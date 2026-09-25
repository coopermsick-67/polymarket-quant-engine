// Module hooks that let route handlers run under plain Node for tests: the
// Worker's `cloudflare:workers` env and Next's request-header helpers are
// replaced by stubs that read from globals the test sets.
const STUBS = {
  "cloudflare:workers": "export const env = (globalThis.__WORKER_ENV__ ??= {});",
  "next/headers": "export const headers = async () => new Headers(globalThis.__REQUEST_HEADERS__ ?? {});",
  "next/navigation": "export const redirect = (path) => { throw new Error(`redirect to ${path}`); };",
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(STUBS, specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
  return nextLoad(url, context);
}
