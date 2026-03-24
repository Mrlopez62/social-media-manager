import assert from "node:assert/strict";
import test from "node:test";
import { PublishJobError } from "../../lib/publish/jobs.ts";
import {
  handleRunWorkerRoute,
  type RunWorkerRouteSession
} from "../../lib/publish/run-worker-route.ts";
import { PublishWorkerError } from "../../lib/publish/worker.ts";

function makeRequest(body: unknown) {
  return new Request("https://example.test/api/posts/post-1/run-worker", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function createSession(overrides?: Partial<RunWorkerRouteSession>): RunWorkerRouteSession {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    role: "owner",
    accessToken: "token-1",
    ...overrides
  };
}

function createDeps(overrides?: {
  rateLimitResult?: { status: number; code: string; message: string; details?: unknown } | null;
  postExists?: boolean;
  dispatchError?: Error;
  statusError?: Error;
}) {
  const calls = {
    enforceRateLimit: 0,
    readWorkspacePost: 0,
    dispatchAndExecutePostJobs: 0,
    getPostPublishStatus: 0
  };

  let dispatchArgs: { postId: string; runAtBefore: string; limit: number } | null = null;

  return {
    calls,
    getDispatchArgs: () => dispatchArgs,
    deps: {
      enforceRateLimit: async () => {
        calls.enforceRateLimit += 1;
        return overrides?.rateLimitResult ?? null;
      },
      readWorkspacePost: async () => {
        calls.readWorkspacePost += 1;
        if (overrides?.postExists === false) {
          return null;
        }
        return { id: "post-1" };
      },
      dispatchAndExecutePostJobs: async (args: {
        postId: string;
        runAtBefore: string;
        limit: number;
      }) => {
        calls.dispatchAndExecutePostJobs += 1;
        dispatchArgs = args;
        if (overrides?.dispatchError) {
          throw overrides.dispatchError;
        }
        return {
          claimedCount: 1,
          executedCount: 1,
          executions: [
            {
              jobId: "job-1",
              postId: args.postId,
              status: "failed"
            }
          ]
        };
      },
      getPostPublishStatus: async () => {
        calls.getPostPublishStatus += 1;
        if (overrides?.statusError) {
          throw overrides.statusError;
        }
        return {
          summary: {
            aggregateStatus: "failed"
          }
        };
      }
    }
  };
}

test("run-worker route rejects unauthenticated users", async () => {
  const { deps, calls } = createDeps();

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: null,
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.error.code, "UNAUTHENTICATED");
  }
  assert.equal(calls.enforceRateLimit, 0);
});

test("run-worker route rejects viewer role", async () => {
  const { deps } = createDeps();

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: createSession({ role: "viewer" }),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.error.code, "FORBIDDEN");
  }
});

test("run-worker route validates request payload", async () => {
  const { deps, calls } = createDeps();

  const result = await handleRunWorkerRoute({
    req: makeRequest({ limit: 99 }),
    postId: "post-1",
    session: createSession(),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
  assert.equal(calls.readWorkspacePost, 0);
  assert.equal(calls.dispatchAndExecutePostJobs, 0);
});

test("run-worker route returns not-found for unknown post", async () => {
  const { deps, calls } = createDeps({ postExists: false });

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "missing-post",
    session: createSession(),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.equal(result.error.code, "POST_NOT_FOUND");
  }
  assert.equal(calls.dispatchAndExecutePostJobs, 0);
});

test("run-worker route orchestrates dispatch+execute with default options", async () => {
  const fixedNow = new Date("2026-03-23T15:00:00.000Z");
  const { deps, calls, getDispatchArgs } = createDeps();

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      ...deps,
      now: () => fixedNow
    }
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 200);
    assert.equal(result.data.postId, "post-1");
    assert.equal(result.data.includeFutureScheduled, false);
    assert.equal(result.data.claimedCount, 1);
    assert.equal(result.data.executedCount, 1);
    assert.equal(result.data.status.summary.aggregateStatus, "failed");
  }

  assert.equal(calls.enforceRateLimit, 1);
  assert.equal(calls.readWorkspacePost, 1);
  assert.equal(calls.dispatchAndExecutePostJobs, 1);
  assert.equal(calls.getPostPublishStatus, 1);

  const dispatchArgs = getDispatchArgs();
  assert.ok(dispatchArgs);
  assert.equal(dispatchArgs?.postId, "post-1");
  assert.equal(dispatchArgs?.runAtBefore, fixedNow.toISOString());
  assert.equal(dispatchArgs?.limit, 5);
});

test("run-worker route supports includeFutureScheduled and custom limit", async () => {
  const fixedNow = new Date("2026-03-23T15:00:00.000Z");
  const expectedFuture = new Date(
    fixedNow.getTime() + 365 * 24 * 60 * 60 * 1000
  ).toISOString();
  const { deps, getDispatchArgs } = createDeps();

  const result = await handleRunWorkerRoute({
    req: makeRequest({
      includeFutureScheduled: true,
      limit: 3
    }),
    postId: "post-1",
    session: createSession(),
    deps: {
      ...deps,
      now: () => fixedNow
    }
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.includeFutureScheduled, true);
    assert.equal(result.data.runAtBefore, expectedFuture);
  }

  const dispatchArgs = getDispatchArgs();
  assert.equal(dispatchArgs?.runAtBefore, expectedFuture);
  assert.equal(dispatchArgs?.limit, 3);
});

test("run-worker route surfaces rate-limit responses", async () => {
  const { deps, calls } = createDeps({
    rateLimitResult: {
      status: 429,
      code: "RATE_LIMITED",
      message: "Rate limit exceeded."
    }
  });

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: createSession(),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 429);
    assert.equal(result.error.code, "RATE_LIMITED");
  }
  assert.equal(calls.readWorkspacePost, 0);
  assert.equal(calls.dispatchAndExecutePostJobs, 0);
});

test("run-worker route maps worker-domain errors", async () => {
  const { deps } = createDeps({
    dispatchError: new PublishWorkerError("PUBLISH_JOB_CLAIM_FAILED", 500, "claim failed")
  });

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: createSession(),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.equal(result.error.code, "PUBLISH_JOB_CLAIM_FAILED");
  }
});

test("run-worker route maps publish-job status errors", async () => {
  const { deps } = createDeps({
    statusError: new PublishJobError("POST_STATUS_FAILED", 500, "status failed")
  });

  const result = await handleRunWorkerRoute({
    req: makeRequest({}),
    postId: "post-1",
    session: createSession(),
    deps
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.equal(result.error.code, "POST_STATUS_FAILED");
  }
});

