import assert from "node:assert/strict";
import test from "node:test";
import { queuePostPublish } from "../../lib/publish/jobs.ts";
import { claimQueuedPublishJobs, executeQueuedPublishJob } from "../../lib/publish/worker.ts";
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
