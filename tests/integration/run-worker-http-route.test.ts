import assert from "node:assert/strict";
import test from "node:test";
import { PublishJobError } from "../../lib/publish/jobs.ts";
import { postRunWorkerHttpRoute } from "../../lib/publish/run-worker-route-http.ts";
import type { RunWorkerRouteSession } from "../../lib/publish/run-worker-route.ts";
import { PublishWorkerError } from "../../lib/publish/worker.ts";

function createSession(overrides?: Partial<RunWorkerRouteSession>): RunWorkerRouteSession {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    role: "owner",
    accessToken: "token-1",
    ...overrides
  };
}

function jsonRequest(body: unknown) {
  return new Request("https://example.test/api/posts/post-1/run-worker", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

test("run-worker http route returns 401 error envelope for unauthenticated users", async () => {
  const response = await postRunWorkerHttpRoute({
    req: jsonRequest({}),
    postId: "post-1",
    deps: {
      getSessionContext: async () => null,
      enforceRateLimit: async () => null,
      readWorkspacePost: async () => ({ id: "post-1" }),
      dispatchAndExecutePostJobs: async () => ({
        claimedCount: 0,
        executedCount: 0,
        executions: []
      }),
      getPostPublishStatus: async () => ({
        summary: {
          aggregateStatus: "draft"
        }
      })
    }
  });

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("run-worker http route short-circuits on rate-limit with error envelope", async () => {
  let readCalls = 0;

  const response = await postRunWorkerHttpRoute({
    req: jsonRequest({}),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => ({
        status: 429,
        code: "RATE_LIMITED",
        message: "Too many requests.",
        details: {
          scope: "posts.publish.queue"
        }
      }),
      readWorkspacePost: async () => {
        readCalls += 1;
        return { id: "post-1" };
      },
      dispatchAndExecutePostJobs: async () => ({
        claimedCount: 0,
        executedCount: 0,
        executions: []
      }),
      getPostPublishStatus: async () => ({
        summary: {
          aggregateStatus: "draft"
        }
      })
    }
  });

  assert.equal(readCalls, 0);
  assert.equal(response.status, 429);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.equal(body.error.message, "Too many requests.");
});

test("run-worker http route returns validation error envelope for invalid body", async () => {
  let readCalls = 0;

  const response = await postRunWorkerHttpRoute({
    req: jsonRequest({ limit: 99 }),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      readWorkspacePost: async () => {
        readCalls += 1;
        return { id: "post-1" };
      },
      dispatchAndExecutePostJobs: async () => ({
        claimedCount: 0,
        executedCount: 0,
        executions: []
      }),
      getPostPublishStatus: async () => ({
        summary: {
          aggregateStatus: "draft"
        }
      })
    }
  });

  assert.equal(readCalls, 0);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "VALIDATION_ERROR");
});

test("run-worker http route returns 200 data envelope on success", async () => {
  const fixedNow = new Date("2026-03-23T20:00:00.000Z");
  const dispatchCall: { runAtBefore?: string; limit?: number } = {};

  const response = await postRunWorkerHttpRoute({
    req: jsonRequest({ limit: 3 }),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      now: () => fixedNow,
      enforceRateLimit: async () => null,
      readWorkspacePost: async () => ({ id: "post-1" }),
      dispatchAndExecutePostJobs: async ({ runAtBefore, limit }) => {
        dispatchCall.runAtBefore = runAtBefore;
        dispatchCall.limit = limit;
        return {
          claimedCount: 1,
          executedCount: 1,
          executions: [
            {
              jobId: "job-1",
              postId: "post-1",
              status: "published"
            }
          ]
        };
      },
      getPostPublishStatus: async () => ({
        summary: {
          aggregateStatus: "published"
        }
      })
    }
  });

  assert.equal(response.status, 200);
  assert.equal(dispatchCall.runAtBefore, fixedNow.toISOString());
  assert.equal(dispatchCall.limit, 3);

  const body = (await response.json()) as {
    data: { postId: string; executedCount: number; status: { summary: { aggregateStatus: string } } };
  };
  assert.equal(body.data.postId, "post-1");
  assert.equal(body.data.executedCount, 1);
  assert.equal(body.data.status.summary.aggregateStatus, "published");
});

test("run-worker http route maps worker and publish errors to error envelope", async () => {
  const response = await postRunWorkerHttpRoute({
    req: jsonRequest({}),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      readWorkspacePost: async () => ({ id: "post-1" }),
      dispatchAndExecutePostJobs: async () => {
        throw new PublishWorkerError("PUBLISH_JOB_CLAIM_FAILED", 500, "claim failed");
      },
      getPostPublishStatus: async () => {
        throw new PublishJobError("POST_STATUS_FAILED", 500, "status failed");
      }
    }
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "PUBLISH_JOB_CLAIM_FAILED");
  assert.equal(body.error.message, "claim failed");
});
