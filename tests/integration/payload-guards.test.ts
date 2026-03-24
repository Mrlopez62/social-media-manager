import assert from "node:assert/strict";
import test from "node:test";
import { validateJsonBodyRequest } from "../../lib/api/request-guards.ts";

test("validateJsonBodyRequest rejects non-json content type with 415", () => {
  const req = new Request("https://example.test/api", {
    method: "POST",
    headers: {
      "content-type": "text/plain"
    },
    body: "hello"
  });

  const result = validateJsonBodyRequest(req);
  assert.equal(result?.status, 415);
  assert.equal(result?.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("validateJsonBodyRequest rejects oversized payload by content-length with 413", () => {
  const req = new Request("https://example.test/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "2048"
    },
    body: JSON.stringify({ name: "phase4" })
  });

  const result = validateJsonBodyRequest(req, { maxBytes: 64 });
  assert.equal(result?.status, 413);
  assert.equal(result?.code, "PAYLOAD_TOO_LARGE");
});

test("validateJsonBodyRequest allows valid json payload within size limit", () => {
  const req = new Request("https://example.test/api", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: "phase4" })
  });

  const result = validateJsonBodyRequest(req, { maxBytes: 64 });
  assert.equal(result, null);
});
