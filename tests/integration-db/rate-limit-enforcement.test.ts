import { randomUUID } from "crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { enforceRateLimit } from "../../lib/security/rate-limit.ts";
import { hasDbTestEnv } from "../helpers/db-fixtures.ts";

const dbTestSkip = hasDbTestEnv()
  ? false
  : "Missing DB test env. Set TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).";

function ensureRateLimitEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? "";
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
}

test("enforceRateLimit returns 429 after limit is exceeded", { skip: dbTestSkip }, async () => {
  ensureRateLimitEnv();
  process.env.DISABLE_RATE_LIMITS = "false";

  const userId = randomUUID();
  const scope = `test.route_limit.${randomUUID()}`;
  const policy = {
    scope,
    limit: 2,
    windowSeconds: 120
  };
  const req = new Request("https://example.test/api/posts", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.45"
    }
  });

  const first = await enforceRateLimit({
    req,
    policy,
    userId
  });
  assert.equal(first, null);

  const second = await enforceRateLimit({
    req,
    policy,
    userId
  });
  assert.equal(second, null);

  const denied = await enforceRateLimit({
    req,
    policy,
    userId
  });

  assert.ok(denied);
  assert.equal(denied?.status, 429);
  assert.ok((denied?.headers.get("Retry-After") ?? "").length > 0);

  const payload = (await denied?.json()) as {
    error?: { code?: string; details?: { scope?: string } };
  };
  assert.equal(payload?.error?.code, "RATE_LIMITED");
  assert.equal(payload?.error?.details?.scope, scope);
});
