import assert from "node:assert/strict";
import test from "node:test";
import { PublishJobError } from "../../lib/publish/jobs.ts";
import {
  getPostStatusHttpRoute,
  getPostTimelineHttpRoute
} from "../../lib/publish/read-route-http.ts";

function createSession(overrides?: {
  workspaceId?: string | null;
  role?: "owner" | "admin" | "editor" | "viewer" | null;
  accessToken?: string;
}) {
  return {
    workspaceId: "workspace-1",
    role: "owner" as const,
    accessToken: "token-1",
    ...overrides
  };
}

test("post status http route returns 401 when session is missing", async () => {
  const response = await getPostStatusHttpRoute({
    postId: "post-1",
    deps: {
      getSessionContext: async () => null,
      getPostPublishStatus: async () => ({})
    }
  });

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("post status http route returns 409 when workspace is missing", async () => {
  const response = await getPostStatusHttpRoute({
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession({ workspaceId: null }),
      getPostPublishStatus: async () => ({})
    }
  });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "NO_WORKSPACE");
});

test("post status http route allows viewer and returns data envelope", async () => {
  let calledWithPostId = "";

  const response = await getPostStatusHttpRoute({
    postId: "post-2",
    deps: {
      getSessionContext: async () => createSession({ role: "viewer" }),
      getPostPublishStatus: async ({ postId }) => {
        calledWithPostId = postId;
        return {
          summary: {
            aggregateStatus: "published"
          }
        };
      }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(calledWithPostId, "post-2");
  const body = (await response.json()) as { data: { summary: { aggregateStatus: string } } };
  assert.equal(body.data.summary.aggregateStatus, "published");
});

test("post status http route maps publish job errors", async () => {
  const response = await getPostStatusHttpRoute({
    postId: "post-3",
    deps: {
      getSessionContext: async () => createSession(),
      getPostPublishStatus: async () => {
        throw new PublishJobError("POST_NOT_FOUND", 404, "Post not found.");
      }
    }
  });

  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "POST_NOT_FOUND");
  assert.equal(body.error.message, "Post not found.");
});

test("post timeline http route rejects invalid limit query", async () => {
  const response = await getPostTimelineHttpRoute({
    req: new Request("https://example.test/api/posts/post-1/timeline?limit=abc", {
      method: "GET"
    }),
    postId: "post-1",
    deps: {
      getSessionContext: async () => createSession(),
      getPostPublishTimeline: async () => ({
        events: []
      })
    }
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "INVALID_TIMELINE_LIMIT");
});

test("post timeline http route passes parsed limit and returns data envelope", async () => {
  let calledLimit = 0;

  const response = await getPostTimelineHttpRoute({
    req: new Request("https://example.test/api/posts/post-9/timeline?limit=7", {
      method: "GET"
    }),
    postId: "post-9",
    deps: {
      getSessionContext: async () => createSession({ role: "viewer" }),
      getPostPublishTimeline: async ({ limit, postId }) => {
        calledLimit = limit;
        return {
          postId,
          events: [
            {
              id: "evt-1",
              type: "post.publish_now.queued"
            }
          ]
        };
      }
    }
  });

  assert.equal(calledLimit, 7);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: { postId: string; events: Array<{ id: string }> } };
  assert.equal(body.data.postId, "post-9");
  assert.equal(body.data.events.length, 1);
});

test("post timeline http route maps unexpected errors to POST_TIMELINE_FAILED", async () => {
  const response = await getPostTimelineHttpRoute({
    req: new Request("https://example.test/api/posts/post-5/timeline", {
      method: "GET"
    }),
    postId: "post-5",
    deps: {
      getSessionContext: async () => createSession(),
      getPostPublishTimeline: async () => {
        throw new Error("timeline boom");
      }
    }
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "POST_TIMELINE_FAILED");
  assert.equal(body.error.message, "timeline boom");
});
