import { expect, test } from "@playwright/test";

type PostListItem = {
  id: string;
  caption: string;
  status: string;
  scheduledFor: string | null;
  createdAt: string;
  targets: Array<{
    id: string;
    platform: string;
    status: string;
  }>;
};

function json(payload: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload)
  };
}

test("publish dashboard queues publish-now and refreshes status + timeline", async ({ page }) => {
  const postId = "post-e2e-1";
  let publishNowCalls = 0;
  const posts: PostListItem[] = [
    {
      id: postId,
      caption: "E2E dashboard post",
      status: "draft",
      scheduledFor: null,
      createdAt: "2026-03-23T00:00:00.000Z",
      targets: [
        { id: "target-ig", platform: "instagram", status: "draft" },
        { id: "target-fb", platform: "facebook", status: "draft" }
      ]
    }
  ];

  let statusPayload = {
    summary: {
      aggregateStatus: "draft",
      totalTargets: 2,
      publishedTargets: 0,
      failedTargets: 0
    },
    targets: [
      {
        id: "target-ig",
        platform: "instagram",
        status: "draft",
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        lastAttemptAt: null
      },
      {
        id: "target-fb",
        platform: "facebook",
        status: "draft",
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        lastAttemptAt: null
      }
    ],
    jobs: [] as Array<{
      id: string;
      status: string;
      runAt: string;
      attempt: number;
      maxAttempts: number;
      idempotencyKey?: string | null;
    }>
  };

  let timelinePayload = {
    events: [] as Array<{
      id: string;
      at: string;
      type: string;
      summary: string;
    }>
  };

  await page.route("**/api/posts", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(
        json({
          data: {
            items: posts
          }
        })
      );
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/posts/${postId}/status`, async (route) => {
    await route.fulfill(json({ data: statusPayload }));
  });

  await page.route(`**/api/posts/${postId}/timeline?limit=100`, async (route) => {
    await route.fulfill(json({ data: timelinePayload }));
  });

  await page.route(`**/api/posts/${postId}/publish-now`, async (route) => {
    publishNowCalls += 1;
    posts[0] = {
      ...posts[0],
      status: "scheduled",
      scheduledFor: "2030-01-01T00:00:00.000Z",
      targets: [
        { id: "target-ig", platform: "instagram", status: "scheduled" },
        { id: "target-fb", platform: "facebook", status: "scheduled" }
      ]
    };

    statusPayload = {
      ...statusPayload,
      summary: {
        aggregateStatus: "scheduled",
        totalTargets: 2,
        publishedTargets: 0,
        failedTargets: 0
      },
      targets: statusPayload.targets.map((target) => ({
        ...target,
        status: "scheduled"
      })),
      jobs: [
        {
          id: "job-e2e-1",
          status: "queued",
          runAt: "2030-01-01T00:00:00.000Z",
          attempt: 0,
          maxAttempts: 5,
          idempotencyKey: "publish_now:workspace-1:post-e2e-1"
        }
      ]
    };

    timelinePayload = {
      events: [
        {
          id: "evt-e2e-1",
          at: "2030-01-01T00:00:00.000Z",
          type: "post.publish_now.queued",
          summary: "Publish-now job queued."
        }
      ]
    };

    await route.fulfill(
      json({
        data: {
          postId,
          mode: "publish_now",
          idempotent: false,
          scheduledFor: "2030-01-01T00:00:00.000Z",
          job: {
            id: "job-e2e-1",
            status: "queued",
            runAt: "2030-01-01T00:00:00.000Z",
            attempt: 0,
            maxAttempts: 5
          }
        }
      })
    );
  });

  await page.goto("/");

  await expect(page.getByText("One-Stop Social Publisher")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish Now" })).toBeVisible();
  await expect(page.getByText("Aggregate:")).toContainText("draft");

  await page.getByRole("button", { name: "Publish Now" }).click();

  await expect(page.getByText("Queued publish-now job.")).toBeVisible();
  await expect(page.getByText("Aggregate:")).toContainText("scheduled");
  await expect(page.getByText("Publish-now job queued.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "queued" })).toBeVisible();
  expect(publishNowCalls).toBe(1);
});

test("publish dashboard run-worker action sends includeFutureScheduled and refreshes", async ({ page }) => {
  const postId = "post-e2e-2";
  let includeFutureScheduledSeen = false;
  let workerCalls = 0;

  const posts: PostListItem[] = [
    {
      id: postId,
      caption: "E2E worker post",
      status: "scheduled",
      scheduledFor: "2030-01-01T00:00:00.000Z",
      createdAt: "2026-03-23T00:00:00.000Z",
      targets: [
        { id: "target-ig", platform: "instagram", status: "scheduled" }
      ]
    }
  ];

  let statusPayload = {
    summary: {
      aggregateStatus: "scheduled",
      totalTargets: 1,
      publishedTargets: 0,
      failedTargets: 0
    },
    targets: [
      {
        id: "target-ig",
        platform: "instagram",
        status: "scheduled",
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        lastAttemptAt: null
      }
    ],
    jobs: [
      {
        id: "job-worker-1",
        status: "queued",
        runAt: "2030-01-01T00:00:00.000Z",
        attempt: 0,
        maxAttempts: 5,
        idempotencyKey: "schedule:workspace-1:post-e2e-2:2030-01-01T00:00:00.000Z"
      }
    ]
  };

  let timelinePayload = {
    events: [] as Array<{
      id: string;
      at: string;
      type: string;
      summary: string;
    }>
  };

  await page.route("**/api/posts", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(
        json({
          data: {
            items: posts
          }
        })
      );
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/posts/${postId}/status`, async (route) => {
    await route.fulfill(json({ data: statusPayload }));
  });

  await page.route(`**/api/posts/${postId}/timeline?limit=100`, async (route) => {
    await route.fulfill(json({ data: timelinePayload }));
  });

  await page.route(`**/api/posts/${postId}/run-worker`, async (route) => {
    workerCalls += 1;
    const body = route.request().postDataJSON() as { includeFutureScheduled?: boolean };
    includeFutureScheduledSeen = body.includeFutureScheduled === true;

    statusPayload = {
      ...statusPayload,
      summary: {
        aggregateStatus: "published",
        totalTargets: 1,
        publishedTargets: 1,
        failedTargets: 0
      },
      targets: statusPayload.targets.map((target) => ({
        ...target,
        status: "published"
      })),
      jobs: [
        {
          ...statusPayload.jobs[0],
          status: "succeeded"
        }
      ]
    };
    timelinePayload = {
      events: [
        {
          id: "evt-worker-1",
          at: "2030-01-01T00:00:30.000Z",
          type: "publish.job.executed",
          summary: "Publish job executed: succeeded (published=1, failed=0)."
        }
      ]
    };

    await route.fulfill(
      json({
        data: {
          postId,
          includeFutureScheduled: true,
          runAtBefore: "2031-01-01T00:00:00.000Z",
          claimedCount: 1,
          executedCount: 1,
          executions: [
            {
              jobId: "job-worker-1",
              postId,
              status: "succeeded"
            }
          ],
          status: statusPayload
        }
      })
    );
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Run Worker Cycle" })).toBeVisible();
  await page.getByLabel("Include future scheduled").check();
  await page.getByRole("button", { name: "Run Worker Cycle" }).click();

  await expect(page.getByText(/Worker run finished: claimed 1, executed 1/)).toBeVisible();
  await expect(page.getByText("Aggregate:")).toContainText("published");
  await expect(page.getByText("Publish job executed: succeeded (published=1, failed=0).")).toBeVisible();
  expect(workerCalls).toBe(1);
  expect(includeFutureScheduledSeen).toBe(true);
});
