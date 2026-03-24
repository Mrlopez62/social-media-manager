import assert from "node:assert/strict";
import test from "node:test";
import { PublishJobError } from "../../lib/publish/jobs.ts";
import {
  postCancelOperatorHttpRoute,
  postPublishNowOperatorHttpRoute,
  postRetryFailedOperatorHttpRoute,
  postScheduleOperatorHttpRoute
} from "../../lib/publish/operator-route-http.ts";
import type {
  CancelOperatorDeps,
  OperatorRouteSession,
  PublishNowOperatorDeps,
  RetryFailedOperatorDeps,
  ScheduleOperatorDeps
} from "../../lib/publish/operator-route-handlers.ts";

function createSession(overrides?: Partial<OperatorRouteSession>): OperatorRouteSession {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    role: "owner",
    accessToken: "token-1",
    ...overrides
  };
}

function jsonRequest(body: unknown, contentType = "application/json") {
  return new Request("https://example.test/api", {
    method: "POST",
    headers: {
      "content-type": contentType
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("publish-now http route returns 202 data envelope on success", async () => {
  let getSessionCalls = 0;
  let queueCalls = 0;
  let queuedPostId = "";

  const response = await postPublishNowOperatorHttpRoute({
    req: jsonRequest({}),
    postId: "post-1",
    deps: {
      getSessionContext: async () => {
        getSessionCalls += 1;
        return createSession();
      },
      enforceRateLimit: async () => null,
      queuePostPublish: async (args: Parameters<PublishNowOperatorDeps["queuePostPublish"]>[0]) => {
        queueCalls += 1;
        queuedPostId = args.postId;
        return {
          postId: args.postId,
          workspaceId: args.workspaceId,
          mode: "publish_now",
          idempotent: false,
          scheduledFor: args.runAtIso,
          job: {
            id: "job-1",
            status: "queued",
            runAt: args.runAtIso,
            attempt: 0,
            maxAttempts: 5
          }
        };
      }
    }
  });

  assert.equal(getSessionCalls, 1);
  assert.equal(queueCalls, 1);
  assert.equal(queuedPostId, "post-1");
  assert.equal(response.status, 202);

  const body = (await response.json()) as { data: { mode: string; postId: string } };
  assert.equal(body.data.mode, "publish_now");
  assert.equal(body.data.postId, "post-1");
});

test("publish-now http route returns error envelope when rate limited", async () => {
  let queueCalls = 0;

  const response = await postPublishNowOperatorHttpRoute({
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
      queuePostPublish: async () => {
        queueCalls += 1;
        throw new Error("should not be called");
      }
    }
  });

  assert.equal(queueCalls, 0);
  assert.equal(response.status, 429);

  const body = (await response.json()) as {
    error: { code: string; message: string; details: { scope: string } };
  };
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.equal(body.error.message, "Too many requests.");
  assert.equal(body.error.details.scope, "posts.publish.queue");
});

test("schedule http route returns validation error envelope for bad payload", async () => {
  let queueCalls = 0;

  const response = await postScheduleOperatorHttpRoute({
    req: jsonRequest({ scheduledFor: "not-a-date" }),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        queueCalls += 1;
        throw new Error("should not queue invalid payload");
      }
    }
  });

  assert.equal(queueCalls, 0);
  assert.equal(response.status, 400);

  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.message, "Invalid request body.");
});

test("schedule http route returns 202 data envelope on success", async () => {
  const scheduledFor = "2030-01-02T03:04:05.000Z";
  let runAtIso = "";

  const response = await postScheduleOperatorHttpRoute({
    req: jsonRequest({ scheduledFor }),
    postId: "post-2",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      queuePostPublish: async (args: Parameters<ScheduleOperatorDeps["queuePostPublish"]>[0]) => {
        runAtIso = args.runAtIso;
        return {
          postId: args.postId,
          workspaceId: args.workspaceId,
          mode: "schedule",
          idempotent: false,
          scheduledFor: args.runAtIso,
          job: {
            id: "job-2",
            status: "queued",
            runAt: args.runAtIso,
            attempt: 0,
            maxAttempts: 5
          }
        };
      }
    }
  });

  assert.equal(response.status, 202);
  assert.equal(runAtIso, scheduledFor);
  const body = (await response.json()) as { data: { mode: string; scheduledFor: string } };
  assert.equal(body.data.mode, "schedule");
  assert.equal(body.data.scheduledFor, scheduledFor);
});

test("cancel http route returns publish job errors as http errors", async () => {
  const response = await postCancelOperatorHttpRoute({
    req: jsonRequest({}),
    postId: "post-3",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async () => {
        throw new PublishJobError("NO_ACTIVE_PUBLISH_JOB", 409, "No active job.");
      }
    }
  });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "NO_ACTIVE_PUBLISH_JOB");
  assert.equal(body.error.message, "No active job.");
});

test("cancel http route returns 200 data envelope on success", async () => {
  const response = await postCancelOperatorHttpRoute({
    req: jsonRequest({}),
    postId: "post-3",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async (
        args: Parameters<CancelOperatorDeps["cancelQueuedPostPublish"]>[0]
      ) => ({
        postId: args.postId,
        workspaceId: args.workspaceId,
        mode: "publish_now",
        canceledTargetCount: 1,
        postStatusAfterCancel: "draft",
        job: {
          id: "job-3",
          status: "failed",
          runAt: "2030-01-01T00:00:00.000Z",
          attempt: 0,
          maxAttempts: 5
        }
      })
    }
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data: { mode: string; canceledTargetCount: number };
  };
  assert.equal(body.data.mode, "publish_now");
  assert.equal(body.data.canceledTargetCount, 1);
});

test("retry-failed http route returns 202 data envelope on success", async () => {
  const response = await postRetryFailedOperatorHttpRoute({
    req: jsonRequest({}),
    postId: "post-4",
    deps: {
      getSessionContext: async () => createSession(),
      enforceRateLimit: async () => null,
      retryFailedPostTargets: async (
        args: Parameters<RetryFailedOperatorDeps["retryFailedPostTargets"]>[0]
      ) => ({
        postId: args.postId,
        workspaceId: args.workspaceId,
        mode: "retry_failed",
        idempotent: false,
        failedTargetCount: 2,
        scheduledFor: "2030-01-01T00:00:00.000Z",
        job: {
          id: "job-4",
          status: "queued",
          runAt: "2030-01-01T00:00:00.000Z",
          attempt: 0,
          maxAttempts: 5
        }
      })
    }
  });

  assert.equal(response.status, 202);
  const body = (await response.json()) as {
    data: { mode: string; failedTargetCount: number };
  };
  assert.equal(body.data.mode, "retry_failed");
  assert.equal(body.data.failedTargetCount, 2);
});
