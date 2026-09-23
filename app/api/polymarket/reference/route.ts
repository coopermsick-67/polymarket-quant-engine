// Read-only proxy for Polymarket's official price-to-beat endpoint, which does
// not send CORS headers. Inputs are validated and capped; open prices never
// change once published, so they are cached for the life of the isolate.

import { fetchOfficialPrice, type OfficialPrice } from "../../../lib/polymarket-data";

const cache = new Map<string, OfficialPrice>();
const KEY = /^([A-Z0-9]{2,10}):(5m|15m):(\d{13})$/;
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const keys = [
    ...new Set(
      (new URL(request.url).searchParams.get("keys") ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ].slice(0, 60);
  const now = Date.now();
  const prices: Record<string, OfficialPrice | null> = {};
  await Promise.all(
    keys.map(async (key) => {
      const match = key.match(KEY);
      if (!match) return;
      const [, asset, duration, startRaw] = match;
      const startTime = Number(startRaw);
      const durationMs = duration === "5m" ? 300_000 : 900_000;
      if (startTime % 60_000 !== 0 || startTime > now + 5_000 || startTime < now - 6 * 60 * 60 * 1000) return;
      const cached = cache.get(key);
      if (cached && (cached.completed || (cached.openPrice !== null && now < startTime + durationMs) || now - cached.fetchedAt < 3_000)) {
        prices[key] = cached;
        return;
      }
      try {
        const price = await fetchOfficialPrice(asset, startTime, duration as "5m" | "15m");
        if (price) cache.set(key, price);
        prices[key] = price;
      } catch {
        prices[key] = cached ?? null;
      }
    }),
  );
  if (cache.size > 5_000) for (const key of [...cache.keys()].slice(0, 1_000)) cache.delete(key);
  return new Response(JSON.stringify({ ok: true, prices }), { headers });
}
