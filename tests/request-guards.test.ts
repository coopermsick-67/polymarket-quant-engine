import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey, readJsonBody } from "../app/lib/request-guards";

test("direct clients cannot rotate forwarding headers to evade the shared rate bucket", () => {
  const direct = new Request("https://example.com/api", { headers: {
    "cf-connecting-ip": "192.0.2.1", "x-real-ip": "192.0.2.2", "x-forwarded-for": "192.0.2.3",
  } });
  assert.equal(clientKey(direct), "direct");
  Object.defineProperty(direct, "cf", { value: {} });
  assert.equal(clientKey(direct), "192.0.2.1");
});

test("JSON reads stop at the byte cap even without a declared content length", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(8));
    },
  });
  const request = new Request("https://example.com/api", { method: "POST", body, duplex: "half", headers: { "content-type": "application/json" } } as RequestInit);
  assert.deepEqual(await readJsonBody(request, 16), { failure: { status: 413, error: "Request body is too large." } });
  assert.ok(pulls < 10);
  const valid = new Request("https://example.com/api", { method: "POST", body: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } });
  assert.deepEqual(await readJsonBody(valid, 16), { value: { ok: true } });
});
