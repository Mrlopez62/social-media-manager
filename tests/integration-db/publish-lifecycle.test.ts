import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelQueuedPostPublish,
  getPostPublishTimeline,
  queuePostPublish,
  retryFailedPostTargets
} from "../../lib/publish/jobs.ts";
import {
  claimQueuedPublishJobs,
  dispatchAndExecutePostJobs,
  executeQueuedPublishJob
} from "../../lib/publish/worker.ts";
import { encryptSecret } from "../../lib/security/encryption.ts";
import { createPublishPipelineFixture, hasDbTestEnv } from "../helpers/db-fixtures.ts";

const dbTestSkip = hasDbTestEnv()
  ? false
  : "Missing DB test env. Set TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).";

function ensureTokenKey() {
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    process.env.TOKEN_ENCRYPTION_KEY =
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  }
}

test("queue publish-now is idempotent for active queued jobs", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const first = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const second = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    assert.equal(first.job.id, second.job.id);
    assert.equal(second.idempotent, true);

    const { data: jobs, error: jobsError } = await fixture.client
      .from("publish_jobs")
      .select("id, status")
      .eq("post_id", fixture.postId);

    assert.equal(jobsError, null);
    assert.equal((jobs ?? []).length, 1);
    assert.equal(jobs?.[0]?.status, "queued");
  } finally {
    await fixture.cleanup();
  }
});

test("publish lifecycle executes claimed job and records failed target status", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    assert.equal(queued.job.status, "queued");

    const claimed = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 1
    });

    assert.equal(claimed.claimedCount, 1);
    assert.equal(claimed.jobs[0]?.id, queued.job.id);

    const executed = await executeQueuedPublishJob({
      serviceClient: fixture.client,
      jobId: queued.job.id,
      lockToken: claimed.lockToken
    });

    assert.equal(executed.status, "failed");
    assert.ok("summary" in executed && executed.summary);
    assert.equal(executed.summary.failedTargets, 1);
    assert.equal(executed.summary.retryableFailures, 0);

    const { data: post, error: postError } = await fixture.client
      .from("posts")
      .select("status")
      .eq("id", fixture.postId)
      .single();

    assert.equal(postError, null);
    assert.equal(post?.status, "failed");

    const { data: target, error: targetError } = await fixture.client
      .from("post_targets")
      .select("status, attempt_count, error_code")
      .eq("id", fixture.targetId)
      .single();

    assert.equal(targetError, null);
    assert.equal(target?.status, "failed");
    assert.equal(target?.attempt_count, 1);
    assert.equal(target?.error_code, "PAYLOAD_INVALID");
  } finally {
    await fixture.cleanup();
  }
});

test("retryable refresh failures eventually dead-letter when max attempts are exhausted", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "facebook",
    expiredConnection: true,
    accessTokenEnc: encryptSecret("expired-facebook-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString(),
      maxAttempts: 2
    });

    const firstClaim = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 1
    });

    assert.equal(firstClaim.claimedCount, 1);

    const firstRun = await executeQueuedPublishJob({
      serviceClient: fixture.client,
      jobId: queued.job.id,
      lockToken: firstClaim.lockToken
    });

    assert.equal(firstRun.status, "queued");
    assert.ok(firstRun.nextRunAt);
    assert.equal(firstRun.summary.retryableFailures, 1);

    const secondClaim = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      limit: 1
    });

    assert.equal(secondClaim.claimedCount, 1);

    const secondRun = await executeQueuedPublishJob({
      serviceClient: fixture.client,
      jobId: queued.job.id,
      lockToken: secondClaim.lockToken
    });

    assert.equal(secondRun.status, "dead_letter");
    assert.ok("summary" in secondRun && secondRun.summary);
    assert.equal(secondRun.summary.retryableFailures, 1);

    const { data: job, error: jobError } = await fixture.client
      .from("publish_jobs")
      .select("status, attempt, max_attempts, last_error_code")
      .eq("id", queued.job.id)
      .single();

    assert.equal(jobError, null);
    assert.equal(job?.status, "dead_letter");
    assert.equal(job?.attempt, 2);
    assert.equal(job?.max_attempts, 2);
    assert.equal(job?.last_error_code, "META_TOKEN_REFRESH_FAILED");
  } finally {
    await fixture.cleanup();
  }
});

test("retry failed targets re-queues only failed targets and writes audit history", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const claimed = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 1
    });

    await executeQueuedPublishJob({
      serviceClient: fixture.client,
      jobId: queued.job.id,
      lockToken: claimed.lockToken
    });

    const retried = await retryFailedPostTargets({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId
    });

    assert.equal(retried.mode, "retry_failed");
    assert.equal(retried.failedTargetCount, 1);
    assert.equal(retried.job.status, "queued");

    const { data: target, error: targetError } = await fixture.client
      .from("post_targets")
      .select("status, error_code, error_message")
      .eq("id", fixture.targetId)
      .single();

    assert.equal(targetError, null);
    assert.equal(target?.status, "scheduled");
    assert.equal(target?.error_code, null);
    assert.equal(target?.error_message, null);

    const { data: retryAudits, error: retryAuditError } = await fixture.client
      .from("audit_events")
      .select("event_type, metadata_json")
      .eq("workspace_id", fixture.workspaceId)
      .eq("event_type", "post.retry_failed.queued");

    assert.equal(retryAuditError, null);
    const retryAudit = (retryAudits ?? []).find(
      (event) => (event.metadata_json as { postId?: string } | null)?.postId === fixture.postId
    );
    assert.ok(retryAudit);
    assert.equal(retryAudit.event_type, "post.retry_failed.queued");
    assert.equal(
      (retryAudit.metadata_json as { failedTargetCount?: number } | null)?.failedTargetCount,
      1
    );
  } finally {
    await fixture.cleanup();
  }
});

test("retry failed targets rejects when there are no failed targets", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    await assert.rejects(
      () =>
        retryFailedPostTargets({
          userClient: fixture.client,
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.userId,
          postId: fixture.postId
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string })?.code, "NO_FAILED_TARGETS");
        assert.equal((error as { status?: number })?.status, 409);
        return true;
      }
    );
  } finally {
    await fixture.cleanup();
  }
});

test("post publish timeline returns queue and execution events", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const claimed = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 1
    });

    await executeQueuedPublishJob({
      serviceClient: fixture.client,
      jobId: queued.job.id,
      lockToken: claimed.lockToken
    });

    const timeline = await getPostPublishTimeline({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      postId: fixture.postId
    });

    assert.ok(timeline.events.length >= 2);
    assert.ok(timeline.events.some((event) => event.type === "post.publish_now.queued"));
    assert.ok(timeline.events.some((event) => event.type === "publish.job.executed"));
  } finally {
    await fixture.cleanup();
  }
});

test("cancel queued publish reverts post and targets to draft and writes audit history", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const canceled = await cancelQueuedPostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId
    });

    assert.equal(canceled.job.id, queued.job.id);
    assert.equal(canceled.job.status, "failed");
    assert.equal(canceled.mode, "publish_now");
    assert.equal(canceled.canceledTargetCount, 1);

    const { data: post, error: postError } = await fixture.client
      .from("posts")
      .select("status, scheduled_for")
      .eq("id", fixture.postId)
      .single();

    assert.equal(postError, null);
    assert.equal(post?.status, "draft");
    assert.equal(post?.scheduled_for, null);

    const { data: target, error: targetError } = await fixture.client
      .from("post_targets")
      .select("status, error_code, error_message")
      .eq("id", fixture.targetId)
      .single();

    assert.equal(targetError, null);
    assert.equal(target?.status, "draft");
    assert.equal(target?.error_code, "PUBLISH_CANCELED");
    assert.equal(target?.error_message, "Canceled before execution.");

    const { data: job, error: jobError } = await fixture.client
      .from("publish_jobs")
      .select("status, last_error_code")
      .eq("id", queued.job.id)
      .single();

    assert.equal(jobError, null);
    assert.equal(job?.status, "failed");
    assert.equal(job?.last_error_code, "PUBLISH_CANCELED");

    const timeline = await getPostPublishTimeline({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      postId: fixture.postId
    });

    assert.ok(timeline.events.some((event) => event.type === "post.publish_now.queued"));
    assert.ok(timeline.events.some((event) => event.type === "post.publish.canceled"));
  } finally {
    await fixture.cleanup();
  }
});

test("cancel queued publish rejects while job is running", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const claimed = await claimQueuedPublishJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 1
    });

    assert.equal(claimed.claimedCount, 1);
    assert.equal(claimed.jobs[0]?.id, queued.job.id);

    await assert.rejects(
      () =>
        cancelQueuedPostPublish({
          userClient: fixture.client,
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.userId,
          postId: fixture.postId
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string })?.code, "PUBLISH_JOB_ALREADY_RUNNING");
        assert.equal((error as { status?: number })?.status, 409);
        return true;
      }
    );
  } finally {
    await fixture.cleanup();
  }
});

test("cancel queued retry job supports mixed target states and preserves published targets", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const { data: secondTarget, error: secondTargetError } = await fixture.client
      .from("post_targets")
      .insert({
        post_id: fixture.postId,
        platform: "tiktok",
        connection_id: fixture.connectionId,
        payload_json: {
          caption: "Phase 3 post payload secondary",
          hashtags: ["phase3"],
          location: null,
          mediaAssetIds: ["asset-fixture-2"],
          mediaStoragePaths: [`${fixture.workspaceId}/asset-fixture-2/post.png`]
        },
        status: "published",
        external_post_id: "external-2"
      })
      .select("id")
      .single();

    assert.equal(secondTargetError, null);
    assert.ok(secondTarget);

    const { error: failFirstTargetError } = await fixture.client
      .from("post_targets")
      .update({
        status: "failed",
        error_code: "PAYLOAD_INVALID",
        error_message: "Fixture failure"
      })
      .eq("id", fixture.targetId);

    assert.equal(failFirstTargetError, null);

    const { error: postStatusUpdateError } = await fixture.client
      .from("posts")
      .update({
        status: "partial_failed",
        scheduled_for: null
      })
      .eq("id", fixture.postId);

    assert.equal(postStatusUpdateError, null);

    const retried = await retryFailedPostTargets({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId
    });

    assert.equal(retried.mode, "retry_failed");
    assert.equal(retried.failedTargetCount, 1);
    assert.equal(retried.job.status, "queued");

    const canceled = await cancelQueuedPostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId
    });

    assert.equal(canceled.mode, "retry_failed");
    assert.equal(canceled.canceledTargetCount, 1);
    assert.equal(canceled.postStatusAfterCancel, "partial_failed");

    const { data: targets, error: targetsError } = await fixture.client
      .from("post_targets")
      .select("id, status, error_code")
      .eq("post_id", fixture.postId);

    assert.equal(targetsError, null);
    assert.ok(targets);
    const first = (targets ?? []).find((target) => target.id === fixture.targetId);
    const second = (targets ?? []).find((target) => target.id === secondTarget.id);

    assert.equal(first?.status, "failed");
    assert.equal(first?.error_code, "PUBLISH_CANCELED");
    assert.equal(second?.status, "published");

    const { data: postAfter, error: postAfterError } = await fixture.client
      .from("posts")
      .select("status, scheduled_for")
      .eq("id", fixture.postId)
      .single();

    assert.equal(postAfterError, null);
    assert.equal(postAfter?.status, "partial_failed");
    assert.equal(postAfter?.scheduled_for, null);
  } finally {
    await fixture.cleanup();
  }
});

test("cancel queued publish rejects unsupported mixed target state for non-retry mode", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const { data: secondTarget, error: secondTargetError } = await fixture.client
      .from("post_targets")
      .insert({
        post_id: fixture.postId,
        platform: "tiktok",
        connection_id: fixture.connectionId,
        payload_json: {
          caption: "Phase 3 post payload secondary",
          hashtags: ["phase3"],
          location: null,
          mediaAssetIds: ["asset-fixture-2"],
          mediaStoragePaths: [`${fixture.workspaceId}/asset-fixture-2/post.png`]
        },
        status: "scheduled"
      })
      .select("id")
      .single();

    assert.equal(secondTargetError, null);
    assert.ok(secondTarget);

    const { error: mutateTargetError } = await fixture.client
      .from("post_targets")
      .update({
        status: "published",
        external_post_id: "drifted-external"
      })
      .eq("id", fixture.targetId);

    assert.equal(mutateTargetError, null);

    await assert.rejects(
      () =>
        cancelQueuedPostPublish({
          userClient: fixture.client,
          workspaceId: fixture.workspaceId,
          actorUserId: fixture.userId,
          postId: fixture.postId
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string })?.code, "CANCEL_UNSUPPORTED_STATE");
        assert.equal((error as { status?: number })?.status, 409);
        return true;
      }
    );

    const { data: jobAfter, error: jobAfterError } = await fixture.client
      .from("publish_jobs")
      .select("id, status")
      .eq("id", queued.job.id)
      .single();

    assert.equal(jobAfterError, null);
    assert.equal(jobAfter?.status, "queued");
  } finally {
    await fixture.cleanup();
  }
});

test("dispatchAndExecutePostJobs claims and executes due jobs for a post", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const queued = await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    const run = await dispatchAndExecutePostJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 60 * 1000).toISOString(),
      limit: 5
    });

    assert.equal(run.claimedCount, 1);
    assert.equal(run.executedCount, 1);
    assert.equal(run.executions[0]?.jobId, queued.job.id);
    assert.equal(run.executions[0]?.status, "failed");

    const { data: job, error: jobError } = await fixture.client
      .from("publish_jobs")
      .select("status")
      .eq("id", queued.job.id)
      .single();

    assert.equal(jobError, null);
    assert.equal(job?.status, "failed");
  } finally {
    await fixture.cleanup();
  }
});

test("dispatchAndExecutePostJobs can include future-scheduled jobs via runAtBefore", { skip: dbTestSkip }, async () => {
  ensureTokenKey();
  const fixture = await createPublishPipelineFixture({
    platform: "tiktok",
    accessTokenEnc: encryptSecret("fixture-tiktok-token")
  });

  try {
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await queuePostPublish({
      userClient: fixture.client,
      workspaceId: fixture.workspaceId,
      actorUserId: fixture.userId,
      postId: fixture.postId,
      mode: "schedule",
      runAtIso: scheduledFor
    });

    const dueOnlyRun = await dispatchAndExecutePostJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date().toISOString(),
      limit: 5
    });

    assert.equal(dueOnlyRun.claimedCount, 0);
    assert.equal(dueOnlyRun.executedCount, 0);

    const includeFutureRun = await dispatchAndExecutePostJobs({
      serviceClient: fixture.client,
      postId: fixture.postId,
      runAtBefore: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      limit: 5
    });

    assert.equal(includeFutureRun.claimedCount, 1);
    assert.equal(includeFutureRun.executedCount, 1);
  } finally {
    await fixture.cleanup();
  }
});
