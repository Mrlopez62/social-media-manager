import assert from "node:assert/strict";
import test from "node:test";
import { validateOAuthState } from "../../lib/connections/oauth-state.ts";

test("oauth state validation rejects missing state", () => {
  const result = validateOAuthState({
    oauthState: null,
    expectedPlatform: "facebook"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "OAUTH_STATE_INVALID");
    assert.equal(result.status, 400);
  }
});

test("oauth state validation rejects platform mismatch", () => {
  const result = validateOAuthState({
    oauthState: {
      platform: "facebook",
      expiresAt: "2030-01-01T00:00:00.000Z",
      consumedAt: null
    },
    expectedPlatform: "instagram"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "OAUTH_STATE_PLATFORM_MISMATCH");
    assert.equal(result.status, 400);
  }
});

test("oauth state validation rejects consumed state", () => {
  const result = validateOAuthState({
    oauthState: {
      platform: "facebook",
      expiresAt: "2030-01-01T00:00:00.000Z",
      consumedAt: "2026-02-28T10:00:00.000Z"
    },
    expectedPlatform: "facebook"
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "OAUTH_STATE_CONSUMED");
    assert.equal(result.status, 409);
  }
});

test("oauth state validation rejects expired state", () => {
  const result = validateOAuthState({
    oauthState: {
      platform: "facebook",
      expiresAt: "2025-01-01T00:00:00.000Z",
      consumedAt: null
    },
    expectedPlatform: "facebook",
    now: new Date("2026-02-28T00:00:00.000Z")
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "OAUTH_STATE_EXPIRED");
    assert.equal(result.status, 400);
  }
});

test("oauth state validation accepts valid state", () => {
  const result = validateOAuthState({
    oauthState: {
      platform: "instagram",
      expiresAt: "2030-01-01T00:00:00.000Z",
      consumedAt: null
    },
    expectedPlatform: "instagram",
    now: new Date("2026-02-28T00:00:00.000Z")
  });

  assert.deepEqual(result, { ok: true });
});
