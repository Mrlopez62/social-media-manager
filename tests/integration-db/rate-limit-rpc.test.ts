import { randomUUID } from "crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRoleClient, hasDbTestEnv } from "../helpers/db-fixtures.ts";

const dbTestSkip = hasDbTestEnv()
  ? false
  : "Missing DB test env. Set TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).";

type RateLimitRow = {
  allowed: boolean;
  remaining: number;
  reset_at: string;
  count: number;
};

async function consumeRateLimit(params: {
  scope: string;
  subject: string;
  limit: number;
  windowSeconds: number;
}) {
  const client = createServiceRoleClient();
  const { data, error } = await client.rpc("consume_api_rate_limit", {
    p_scope: params.scope,
    p_subject: params.subject,
    p_limit: params.limit,
    p_window_seconds: params.windowSeconds
  });

  if (error) {
    throw new Error(`consume_api_rate_limit failed: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RateLimitRow | undefined;
  assert.ok(row, "Expected consume_api_rate_limit to return a row.");
  return row;
}

test("consume_api_rate_limit enforces limit within a fixed window", { skip: dbTestSkip }, async () => {
  const scope = `test.limit.${randomUUID()}`;
  const subject = `ip:${randomUUID()}`;

  const first = await consumeRateLimit({
    scope,
    subject,
    limit: 2,
    windowSeconds: 120
  });

  assert.equal(first.allowed, true);
  assert.equal(first.count, 1);
  assert.equal(first.remaining, 1);
  assert.ok(!Number.isNaN(new Date(first.reset_at).getTime()));

  const second = await consumeRateLimit({
    scope,
    subject,
    limit: 2,
    windowSeconds: 120
  });

  assert.equal(second.allowed, true);
  assert.equal(second.count, 2);
  assert.equal(second.remaining, 0);

  const third = await consumeRateLimit({
    scope,
    subject,
    limit: 2,
    windowSeconds: 120
  });

  assert.equal(third.allowed, false);
  assert.equal(third.count, 3);
  assert.equal(third.remaining, 0);
});

test("consume_api_rate_limit tracks subject keys independently", { skip: dbTestSkip }, async () => {
  const scope = `test.subjects.${randomUUID()}`;
  const subjectA = `ip:${randomUUID()}`;
  const subjectB = `ip:${randomUUID()}`;

  const firstA = await consumeRateLimit({
    scope,
    subject: subjectA,
    limit: 1,
    windowSeconds: 120
  });
  assert.equal(firstA.allowed, true);

  const firstB = await consumeRateLimit({
    scope,
    subject: subjectB,
    limit: 1,
    windowSeconds: 120
  });
  assert.equal(firstB.allowed, true);

  const secondA = await consumeRateLimit({
    scope,
    subject: subjectA,
    limit: 1,
    windowSeconds: 120
  });
  assert.equal(secondA.allowed, false);
});
