import assert from "node:assert/strict";
import test from "node:test";
import { requireRole } from "../../lib/auth/rbac.ts";
import { getDraftWriteAccessFailure } from "../../lib/posts/draft-rbac.ts";

const draftWriteRoles = ["owner", "admin", "editor"] as const;

test("draft create RBAC rejects unauthenticated users", () => {
  const access = requireRole(null, [...draftWriteRoles]);

  assert.equal(access.allowed, false);
  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("create", access.reason);
    assert.equal(failure.code, "UNAUTHENTICATED");
    assert.equal(failure.status, 401);
    assert.equal(failure.message, "Authentication is required.");
  }
});

test("draft create RBAC rejects viewers", () => {
  const access = requireRole(
    {
      workspaceId: "workspace-1",
      role: "viewer"
    },
    [...draftWriteRoles]
  );

  assert.equal(access.allowed, false);
  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("create", access.reason);
    assert.equal(failure.code, "FORBIDDEN");
    assert.equal(failure.status, 403);
    assert.equal(failure.message, "You do not have permission to create posts.");
  }
});

test("draft edit RBAC rejects users without workspace selection", () => {
  const access = requireRole(
    {
      workspaceId: null,
      role: "editor"
    },
    [...draftWriteRoles]
  );

  assert.equal(access.allowed, false);
  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("edit", access.reason);
    assert.equal(failure.code, "NO_WORKSPACE");
    assert.equal(failure.status, 409);
    assert.equal(failure.message, "Join or create a workspace first.");
  }
});

test("draft edit RBAC rejects viewers with edit-specific message", () => {
  const access = requireRole(
    {
      workspaceId: "workspace-1",
      role: "viewer"
    },
    [...draftWriteRoles]
  );

  assert.equal(access.allowed, false);
  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("edit", access.reason);
    assert.equal(failure.code, "FORBIDDEN");
    assert.equal(failure.status, 403);
    assert.equal(failure.message, "You do not have permission to edit posts.");
  }
});

test("draft write RBAC allows editor role", () => {
  const access = requireRole(
    {
      workspaceId: "workspace-1",
      role: "editor"
    },
    [...draftWriteRoles]
  );

  assert.deepEqual(access, { allowed: true });
});
