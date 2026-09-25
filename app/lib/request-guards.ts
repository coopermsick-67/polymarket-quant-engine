/**
 * Small request guards for the Worker routes. Limits are per isolate: they
 * bound abuse of one instance cheaply, and upstream APIs keep their own limits.
 */

export type GuardFailure = { status: number; error: string };

/** Read a JSON body, refusing anything over `maxBytes` or not declared as JSON. */
export const readJsonBody = async <T>(request: Request, maxBytes: number): Promise<{ value: T } | { failure: GuardFailure }> => {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return { failure: { status: 415, error: "Requests must be sent as application/json." } };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { failure: { status: 413, error: "Request body is too large." } };
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          return { failure: { status: 413, error: "Request body is too large." } };
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return { failure: { status: 400, error: "Invalid JSON request." } };
  }
};

/**
 * Same-origin check for state-changing browser requests. A request that
 * carries an Origin must match the request's own origin; Fetch Metadata that
 * marks a cross-site request is refused.
 */
export const sameOriginFailure = (request: Request): GuardFailure | null => {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site.toLowerCase())) return { status: 403, error: "Cross-site requests are not allowed." };
  if (!origin) return null;
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return { status: 403, error: "Cross-origin requests are not allowed." };
  } catch {
    return { status: 403, error: "The request origin could not be verified." };
  }
  return null;
};

/** Cloudflare runtime metadata proves that its IP header came through the edge. */
export const clientKey = (request: Request) =>
  ((request as Request & { cf?: unknown }).cf ? request.headers.get("cf-connecting-ip")?.trim() : null) || "direct";

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 5_000) {}

  /** Record a hit for `key` and say whether it is within the limit. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) {
      for (const [entry, times] of this.hits) {
        if (!times.some((at) => now - at < this.windowMs)) this.hits.delete(entry);
        if (this.hits.size <= this.maxKeys) break;
      }
    }
    return true;
  }
}

/** Coalesce identical in-flight reads and reuse results for a short time. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = load();
    this.entries.set(key, { expiresAt: now + this.ttlMs, value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > this.maxEntries) {
      for (const [entry, item] of this.entries) if (item.expiresAt <= now) this.entries.delete(entry);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }
}

/** Cap concurrent upstream fan-out per isolate. */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.active >= this.limit) return null;
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }
}
