import assert from "node:assert/strict";
import test from "node:test";
import { PublishJobError } from "../../lib/publish/jobs.ts";
import {
  handleCancelOperatorRoute,
  handlePublishNowOperatorRoute,
  handleRetryFailedOperatorRoute,
  handleScheduleOperatorRoute,
  type PublishNowOperatorDeps,
  type ScheduleOperatorDeps,
  type OperatorRouteSession
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

type CapturedQueueArgs = {
  accessToken: string;
  workspaceId: string;
  actorUserId: string;
  postId: string;
  mode: "publish_now" | "schedule";
  runAtIso: string;
};

test("publish-now route rejects unauthenticated users", async () => {
  const result = await handlePublishNowOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: null,
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new Error("should not call queue");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 401);
    assert.equal(result.error.code, "UNAUTHENTICATED");
  }
});

test("publish-now route enqueues with deterministic runAt", async () => {
  const fixedNow = new Date("2026-03-23T18:00:00.000Z");
  const captured: Partial<CapturedQueueArgs> = {};
  const events: string[] = [];

  const result = await handlePublishNowOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      now: () => fixedNow,
      emitTelemetry: (payload) => {
        events.push(payload.event);
      },
      queuePostPublish: async (
        args: Parameters<PublishNowOperatorDeps["queuePostPublish"]>[0]
      ) => {
        captured.accessToken = args.accessToken;
        captured.workspaceId = args.workspaceId;
        captured.actorUserId = args.actorUserId;
        captured.postId = args.postId;
        captured.mode = args.mode;
        captured.runAtIso = args.runAtIso;
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

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 202);
    assert.equal(result.data.mode, "publish_now");
  }

  assert.equal(captured.mode, "publish_now");
  assert.equal(captured.runAtIso, fixedNow.toISOString());
  assert.deepEqual(events, ["api.posts.publish_now.queued"]);
});

test("publish-now route maps publish job errors", async () => {
  const result = await handlePublishNowOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new PublishJobError("POST_NOT_FOUND", 404, "Post not found.");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.equal(result.error.code, "POST_NOT_FOUND");
  }
});

test("publish-now route surfaces rate-limit responses", async () => {
  let queueCalls = 0;

  const result = await handlePublishNowOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => ({
        status: 429,
        code: "RATE_LIMITED",
        message: "Rate limit exceeded.",
        details: {
          policy: "publish_queue"
        }
      }),
      queuePostPublish: async () => {
        queueCalls += 1;
        throw new Error("should not call queue");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 429);
    assert.equal(result.error.code, "RATE_LIMITED");
    assert.deepEqual(result.error.details, {
      policy: "publish_queue"
    });
  }
  assert.equal(queueCalls, 0);
});

test("schedule route rejects viewers", async () => {
  const result = await handleScheduleOperatorRoute({
    req: jsonRequest({ scheduledFor: "2030-01-01T00:00:00.000Z" }),
    postId: "post-1",
    session: createSession({ role: "viewer" }),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new Error("should not call queue");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.error.code, "FORBIDDEN");
  }
});

test("schedule route enforces json content-type", async () => {
  const result = await handleScheduleOperatorRoute({
    req: jsonRequest("hello", "text/plain"),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new Error("should not call queue");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 415);
    assert.equal(result.error.code, "UNSUPPORTED_MEDIA_TYPE");
  }
});

test("schedule route validates payload", async () => {
  const result = await handleScheduleOperatorRoute({
    req: jsonRequest({ scheduledFor: "not-a-date" }),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new Error("should not call queue");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "VALIDATION_ERROR");
  }
});

test("schedule route enqueues with provided scheduledFor", async () => {
  const scheduledFor = "2030-01-02T03:04:05.000Z";
  const captured: Partial<CapturedQueueArgs> = {};

  const result = await handleScheduleOperatorRoute({
    req: jsonRequest({ scheduledFor }),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async (
        args: Parameters<ScheduleOperatorDeps["queuePostPublish"]>[0]
      ) => {
        captured.accessToken = args.accessToken;
        captured.workspaceId = args.workspaceId;
        captured.actorUserId = args.actorUserId;
        captured.postId = args.postId;
        captured.mode = args.mode;
        captured.runAtIso = args.runAtIso;
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

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 202);
    assert.equal(result.data.mode, "schedule");
  }
  assert.equal(captured.mode, "schedule");
  assert.equal(captured.runAtIso, scheduledFor);
});

test("schedule route maps unexpected errors", async () => {
  const result = await handleScheduleOperatorRoute({
    req: jsonRequest({ scheduledFor: "2030-01-01T00:00:00.000Z" }),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      queuePostPublish: async () => {
        throw new Error("boom");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.equal(result.error.code, "POST_SCHEDULE_FAILED");
    assert.equal(result.error.message, "boom");
  }
});

test("cancel route rejects no-workspace session", async () => {
  const result = await handleCancelOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession({ workspaceId: null }),
    deps: {
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async () => {
        throw new Error("should not call cancel");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.error.code, "NO_WORKSPACE");
  }
});

test("cancel route returns cancel payload", async () => {
  const result = await handleCancelOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async (args) => ({
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

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 200);
    assert.equal(result.data.mode, "publish_now");
    assert.equal(result.data.canceledTargetCount, 1);
  }
});

test("cancel route maps publish job errors", async () => {
  const result = await handleCancelOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async () => {
        throw new PublishJobError("NO_ACTIVE_PUBLISH_JOB", 409, "No active job.");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.error.code, "NO_ACTIVE_PUBLISH_JOB");
  }
});

test("cancel route maps unexpected errors", async () => {
  const result = await handleCancelOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      cancelQueuedPostPublish: async () => {
        throw new Error("unexpected cancel error");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.equal(result.error.code, "POST_CANCEL_FAILED");
    assert.equal(result.error.message, "unexpected cancel error");
  }
});

test("retry-failed route enqueues retry", async () => {
  const result = await handleRetryFailedOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      retryFailedPostTargets: async (args) => ({
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

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, 202);
    assert.equal(result.data.mode, "retry_failed");
    assert.equal(result.data.failedTargetCount, 2);
  }
});

test("retry-failed route maps publish job errors", async () => {
  const result = await handleRetryFailedOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      retryFailedPostTargets: async () => {
        throw new PublishJobError("NO_FAILED_TARGETS", 409, "There are no failed targets.");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.equal(result.error.code, "NO_FAILED_TARGETS");
  }
});

test("retry-failed route maps unexpected errors", async () => {
  const result = await handleRetryFailedOperatorRoute({
    req: jsonRequest({}),
    postId: "post-1",
    session: createSession(),
    deps: {
      enforceRateLimit: async () => null,
      retryFailedPostTargets: async () => {
        throw new Error("unexpected retry error");
      }
    }
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 500);
    assert.equal(result.error.code, "POST_RETRY_FAILED");
    assert.equal(result.error.message, "unexpected retry error");
  }
});
