import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelQueuedAndRefresh,
  loadDashboardPostDetails,
  publishNowAndRefresh,
  requestDashboardApi,
  retryFailedAndRefresh,
  runWorkerAndRefresh,
  scheduleAndRefresh
} from "../../lib/publish/dashboard-actions.ts";

type MockCall = {
  method: string;
  path: string;
  init?: RequestInit;
};

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function createMockFetcher(routes: Record<string, () => Response>) {
  const calls: MockCall[] = [];

  const fetcher = async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      path: input,
      init
    });

    const routeKey = `${method} ${input}`;
    const route = routes[routeKey];
    if (!route) {
      throw new Error(`Missing mock route for ${routeKey}`);
    }

    return route();
  };

  return {
    fetcher,
    calls
  };
}

function createRefreshRoutes(postId: string) {
  return {
    [`GET /api/posts`]: () =>
      jsonResponse(200, {
        data: {
          items: [{ id: postId }]
        }
      }),
    [`GET /api/posts/${postId}/status`]: () =>
      jsonResponse(200, {
        data: {
          summary: {
            aggregateStatus: "scheduled"
          },
          targets: [],
          jobs: []
        }
      }),
    [`GET /api/posts/${postId}/timeline?limit=100`]: () =>
      jsonResponse(200, {
        data: {
          events: []
        }
      })
  };
}

test("requestDashboardApi surfaces API envelope errors", async () => {
  const { fetcher } = createMockFetcher({
    "GET /api/posts": () =>
      jsonResponse(429, {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests."
        }
      })
  });

  await assert.rejects(
    () => requestDashboardApi(fetcher, "/api/posts"),
    /Too many requests\./
  );
});

test("loadDashboardPostDetails requests status and timeline for selected post", async () => {
  const postId = "post-1";
  const { fetcher, calls } = createMockFetcher({
    [`GET /api/posts/${postId}/status`]: () =>
      jsonResponse(200, {
        data: {
          summary: {
            aggregateStatus: "published"
          }
        }
      }),
    [`GET /api/posts/${postId}/timeline?limit=100`]: () =>
      jsonResponse(200, {
        data: {
          events: [{ id: "evt-1" }]
        }
      })
  });

  const details = await loadDashboardPostDetails<
    { summary: { aggregateStatus: string } },
    { events: Array<{ id: string }> }
  >(fetcher, postId);
  assert.equal(details.status.summary.aggregateStatus, "published");
  assert.equal(details.timeline.events.length, 1);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`).sort(),
    [`GET /api/posts/${postId}/status`, `GET /api/posts/${postId}/timeline?limit=100`].sort()
  );
});

test("publish-now, retry-failed, and cancel actions refresh posts + details", async () => {
  const postId = "post-2";
  const { fetcher, calls } = createMockFetcher({
    [`POST /api/posts/${postId}/publish-now`]: () =>
      jsonResponse(200, {
        data: {
          idempotent: false
        }
      }),
    [`POST /api/posts/${postId}/retry-failed`]: () =>
      jsonResponse(200, {
        data: {
          idempotent: false
        }
      }),
    [`POST /api/posts/${postId}/cancel`]: () =>
      jsonResponse(200, {
        data: {
          canceledTargetCount: 1
        }
      }),
    ...createRefreshRoutes(postId)
  });

  await publishNowAndRefresh(fetcher, postId);
  await retryFailedAndRefresh(fetcher, postId);
  await cancelQueuedAndRefresh(fetcher, postId);

  assert.equal(calls.filter((call) => call.path === "/api/posts").length, 3);
  assert.equal(calls.filter((call) => call.path.endsWith("/status")).length, 3);
  assert.equal(calls.filter((call) => call.path.includes("/timeline?limit=100")).length, 3);
});

test("schedule action sends scheduledFor in JSON body and refreshes", async () => {
  const postId = "post-3";
  const scheduledFor = "2030-01-02T03:04:05.000Z";
  const { fetcher, calls } = createMockFetcher({
    [`POST /api/posts/${postId}/schedule`]: () =>
      jsonResponse(200, {
        data: {
          idempotent: false
        }
      }),
    ...createRefreshRoutes(postId)
  });

  await scheduleAndRefresh(fetcher, postId, scheduledFor);

  const scheduleCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/schedule"));
  assert.ok(scheduleCall?.init?.body);
  const body = JSON.parse(String(scheduleCall?.init?.body)) as { scheduledFor: string };
  assert.equal(body.scheduledFor, scheduledFor);
  assert.equal(calls.filter((call) => call.path === "/api/posts").length, 1);
});

test("run-worker action sends includeFutureScheduled/limit and refreshes", async () => {
  const postId = "post-4";
  const { fetcher, calls } = createMockFetcher({
    [`POST /api/posts/${postId}/run-worker`]: () =>
      jsonResponse(200, {
        data: {
          executedCount: 1
        }
      }),
    ...createRefreshRoutes(postId)
  });

  await runWorkerAndRefresh(fetcher, postId, {
    includeFutureScheduled: true,
    limit: 5
  });

  const runWorkerCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/run-worker"));
  assert.ok(runWorkerCall?.init?.body);
  const body = JSON.parse(String(runWorkerCall?.init?.body)) as {
    includeFutureScheduled: boolean;
    limit: number;
  };
  assert.equal(body.includeFutureScheduled, true);
  assert.equal(body.limit, 5);
  assert.equal(calls.filter((call) => call.path === "/api/posts").length, 1);
});
