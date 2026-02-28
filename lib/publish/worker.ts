import { randomUUID } from "crypto";
import { getAdapter } from "../adapters/index.ts";
import type { PublishInput } from "../adapters/base.ts";
import { decryptSecret, encryptSecret } from "../security/encryption.ts";
import {
  aggregatePostDeliveryStatus,
  categorizePublishFailure,
  getRetryDelaySeconds,
  publishToTarget
} from "./service.ts";

type ServiceClientLike = {
  from: (table: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

type ClaimedJobRow = {
  id: string;
  post_id: string;
  run_at: string;
  attempt: number;
  max_attempts: number;
  status: string;
  lock_token: string | null;
  locked_at: string | null;
  idempotency_key: string | null;
};

type PublishJobRow = ClaimedJobRow & {
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
};

type PostRow = {
  id: string;
  workspace_id: string;
  status: string;
  scheduled_for: string | null;
};

type PostTargetRow = {
  id: string;
  platform: "instagram" | "facebook" | "tiktok";
  connection_id: string;
  payload_json: Record<string, unknown>;
  status: string;
  attempt_count: number;
  external_post_id: string | null;
};

type SocialConnectionRow = {
  id: string;
  platform: "instagram" | "facebook" | "tiktok";
  account_id: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  status: string;
};

export class PublishWorkerError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizeRunBefore(runBefore: string | undefined) {
  if (!runBefore) {
    return new Date().toISOString();
  }

  const parsed = new Date(runBefore);
  if (Number.isNaN(parsed.getTime())) {
    throw new PublishWorkerError("INVALID_RUN_AT_FILTER", 400, "runAtBefore must be a valid ISO datetime.");
  }

  return parsed.toISOString();
}

function parsePayloadToPublishInput(params: {
  payload: Record<string, unknown>;
  accessToken: string;
  accountId: string;
  connectionId: string;
  refreshToken: string | null;
  expiresAt: string | null;
}): PublishInput {
  const payload = params.payload;
  const caption = typeof payload.caption === "string" ? payload.caption : "";
  const hashtags = Array.isArray(payload.hashtags)
    ? payload.hashtags.filter((item): item is string => typeof item === "string")
    : [];
  const location = typeof payload.location === "string" ? payload.location : null;

  const mediaStoragePaths = Array.isArray(payload.mediaStoragePaths)
    ? payload.mediaStoragePaths.filter((item): item is string => typeof item === "string")
    : [];

  const platformPayload =
    typeof payload.platformPayload === "object" && payload.platformPayload !== null
      ? payload.platformPayload
      : {};

  return {
    caption,
    hashtags,
    location,
    mediaUrls: mediaStoragePaths,
    metadata: {
      platformPayload,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      accountId: params.accountId,
      connectionId: params.connectionId,
      expiresAt: params.expiresAt
    }
  };
}

async function updateJobState(
  serviceClient: ServiceClientLike,
  jobId: string,
  values: Record<string, unknown>
) {
  const jobsTable = serviceClient.from("publish_jobs") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  const { error } = await jobsTable.update(values).eq("id", jobId);
  if (error) {
    throw new PublishWorkerError("PUBLISH_JOB_UPDATE_FAILED", 500, error.message);
  }
}

export async function claimQueuedPublishJobs(params: {
  serviceClient: unknown;
  postId?: string;
  runAtBefore?: string;
  limit?: number;
}) {
  const serviceClient = params.serviceClient as ServiceClientLike;
  const runBeforeIso = normalizeRunBefore(params.runAtBefore);
  const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
  const dispatcherLockToken = randomUUID();

  const { data, error } = await serviceClient.rpc("claim_publish_jobs", {
    p_run_before: runBeforeIso,
    p_limit: limit,
    p_lock_token: dispatcherLockToken,
    p_post_id: params.postId ?? null
  });

  if (error) {
    throw new PublishWorkerError("PUBLISH_JOB_CLAIM_FAILED", 500, error.message);
  }

  const claimed = (data ?? []) as ClaimedJobRow[];

  return {
    claimedCount: claimed.length,
    lockToken: dispatcherLockToken,
    jobs: claimed.map((job) => ({
      id: job.id,
      postId: job.post_id,
      runAt: job.run_at,
      attempt: job.attempt,
      maxAttempts: job.max_attempts,
      status: job.status,
      lockToken: job.lock_token,
      lockedAt: job.locked_at,
      idempotencyKey: job.idempotency_key
    }))
  };
}

async function readJobById(serviceClient: ServiceClientLike, jobId: string) {
  const jobsTable = serviceClient.from("publish_jobs") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        maybeSingle: () => Promise<{ data: PublishJobRow | null; error: { message: string } | null }>;
      };
    };
  };

  const { data: job, error } = await jobsTable
    .select(
      "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw new PublishWorkerError("PUBLISH_JOB_READ_FAILED", 500, error.message);
  }

  if (!job) {
    throw new PublishWorkerError("PUBLISH_JOB_NOT_FOUND", 404, "Publish job not found.");
  }

  return job;
}

async function readPostForJob(serviceClient: ServiceClientLike, postId: string) {
  const postTable = serviceClient.from("posts") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        maybeSingle: () => Promise<{ data: PostRow | null; error: { message: string } | null }>;
      };
    };
  };

  const { data: post, error } = await postTable
    .select("id, workspace_id, status, scheduled_for")
    .eq("id", postId)
    .maybeSingle();

  if (error) {
    throw new PublishWorkerError("POST_READ_FAILED", 500, error.message);
  }

  if (!post) {
    throw new PublishWorkerError("POST_NOT_FOUND", 404, "Post not found for publish job.");
  }

  return post;
}

async function readTargetsForJob(serviceClient: ServiceClientLike, postId: string) {
  const targetTable = serviceClient.from("post_targets") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        order: (column: string, options: { ascending: boolean }) => Promise<{
          data: PostTargetRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };

  const { data, error } = await targetTable
    .select("id, platform, connection_id, payload_json, status, attempt_count, external_post_id")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new PublishWorkerError("POST_TARGET_READ_FAILED", 500, error.message);
  }

  return data ?? [];
}

async function readConnectionsForTargets(serviceClient: ServiceClientLike, connectionIds: string[]) {
  const uniqueConnectionIds = [...new Set(connectionIds)];

  const connectionTable = serviceClient.from("social_connections") as {
    select: (columns: string) => {
      in: (column: string, values: string[]) => Promise<{
        data: SocialConnectionRow[] | null;
        error: { message: string } | null;
      }>;
    };
  };

  const { data, error } = await connectionTable
    .select("id, platform, account_id, access_token_enc, refresh_token_enc, expires_at, status")
    .in("id", uniqueConnectionIds);

  if (error) {
    throw new PublishWorkerError("CONNECTION_READ_FAILED", 500, error.message);
  }

  const byId = new Map<string, SocialConnectionRow>();
  for (const connection of data ?? []) {
    byId.set(connection.id, connection);
  }

  return byId;
}

async function updateConnectionToken(params: {
  serviceClient: ServiceClientLike;
  connectionId: string;
  accessToken: string;
  expiresAt?: string;
}) {
  const connectionTable = params.serviceClient.from("social_connections") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  const { error } = await connectionTable
    .update({
      access_token_enc: encryptSecret(params.accessToken),
      expires_at: params.expiresAt ?? null,
      status: "active"
    })
    .eq("id", params.connectionId);

  if (error) {
    throw new PublishWorkerError("CONNECTION_UPDATE_FAILED", 500, error.message);
  }
}

async function writeTargetPublishResult(params: {
  serviceClient: ServiceClientLike;
  target: PostTargetRow;
  status: "published" | "failed";
  externalPostId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptedAt: string;
}) {
  const targetTable = params.serviceClient.from("post_targets") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  const { error } = await targetTable
    .update({
      status: params.status,
      external_post_id: params.externalPostId ?? null,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage ?? null,
      last_attempt_at: params.attemptedAt,
      attempt_count: params.target.attempt_count + 1
    })
    .eq("id", params.target.id);

  if (error) {
    throw new PublishWorkerError("POST_TARGET_UPDATE_FAILED", 500, error.message);
  }
}

async function markPostStatus(serviceClient: ServiceClientLike, postId: string, status: string) {
  const postTable = serviceClient.from("posts") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  const { error } = await postTable.update({ status }).eq("id", postId);
  if (error) {
    throw new PublishWorkerError("POST_STATUS_UPDATE_FAILED", 500, error.message);
  }
}

async function writeExecutionAudit(params: {
  serviceClient: ServiceClientLike;
  workspaceId: string;
  eventType: string;
  metadata: Record<string, unknown>;
}) {
  const auditTable = params.serviceClient.from("audit_events") as {
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };

  const { error } = await auditTable.insert({
    workspace_id: params.workspaceId,
    actor_user_id: null,
    event_type: params.eventType,
    metadata_json: params.metadata
  });

  if (error) {
    throw new PublishWorkerError("AUDIT_WRITE_FAILED", 500, error.message);
  }
}

export async function executeQueuedPublishJob(params: {
  serviceClient: unknown;
  jobId: string;
  lockToken?: string;
}) {
  const serviceClient = params.serviceClient as ServiceClientLike;
  const job = await readJobById(serviceClient, params.jobId);

  if (["succeeded", "failed", "dead_letter"].includes(job.status)) {
    return {
      jobId: job.id,
      postId: job.post_id,
      status: job.status,
      skipped: true,
      reason: "Job already finalized."
    };
  }

  if (params.lockToken && job.lock_token && params.lockToken !== job.lock_token) {
    throw new PublishWorkerError(
      "PUBLISH_JOB_LOCK_MISMATCH",
      409,
      "Job lock token does not match the claimed dispatcher lock."
    );
  }

  if (job.status === "queued") {
    await updateJobState(serviceClient, job.id, {
      status: "running",
      lock_token: params.lockToken ?? job.lock_token ?? randomUUID(),
      locked_at: new Date().toISOString()
    });
  }

  const executionJob = await readJobById(serviceClient, params.jobId);
  if (executionJob.status !== "running") {
    throw new PublishWorkerError("PUBLISH_JOB_NOT_RUNNING", 409, "Publish job must be in running state.");
  }

  const nextAttempt = executionJob.attempt + 1;
  await updateJobState(serviceClient, executionJob.id, { attempt: nextAttempt });

  const post = await readPostForJob(serviceClient, executionJob.post_id);
  await markPostStatus(serviceClient, post.id, "publishing");

  const targets = await readTargetsForJob(serviceClient, executionJob.post_id);
  if (targets.length === 0) {
    await updateJobState(serviceClient, executionJob.id, {
      status: "dead_letter",
      lock_token: null,
      locked_at: null,
      last_error_code: "POST_TARGETS_REQUIRED",
      last_error_message: "No targets found for this post."
    });

    await markPostStatus(serviceClient, post.id, "failed");

    return {
      jobId: executionJob.id,
      postId: executionJob.post_id,
      status: "dead_letter",
      summary: {
        attemptedTargets: 0,
        publishedTargets: 0,
        failedTargets: 0,
        retryableFailures: 0
      }
    };
  }

  const actionableTargets = targets.filter((target) => target.status !== "published");
  const connectionsById = await readConnectionsForTargets(
    serviceClient,
    actionableTargets.map((target) => target.connection_id)
  );
  const attemptedAt = new Date().toISOString();
  let publishedCount = targets.filter((target) => target.status === "published").length;
  let failedCount = 0;
  let retryableFailures = 0;
  const failureCodes: string[] = [];
  const failureMessages: string[] = [];

  for (const target of actionableTargets) {
    const connection = connectionsById.get(target.connection_id);

    if (!connection) {
      failedCount += 1;
      failureCodes.push("CONNECTION_NOT_FOUND");
      failureMessages.push("Connection is missing for this publish target.");

      await writeTargetPublishResult({
        serviceClient,
        target,
        status: "failed",
        errorCode: "CONNECTION_NOT_FOUND",
        errorMessage: "Connection is missing for this publish target.",
        attemptedAt
      });
      continue;
    }

    if (connection.status !== "active") {
      failedCount += 1;
      failureCodes.push("CONNECTION_INACTIVE");
      failureMessages.push("Connection is inactive. Reconnect the account to continue publishing.");

      await writeTargetPublishResult({
        serviceClient,
        target,
        status: "failed",
        errorCode: "CONNECTION_INACTIVE",
        errorMessage: "Connection is inactive. Reconnect the account to continue publishing.",
        attemptedAt
      });
      continue;
    }

    if (connection.platform !== target.platform) {
      failedCount += 1;
      failureCodes.push("CONNECTION_PLATFORM_MISMATCH");
      failureMessages.push("Selected connection platform does not match publish target.");

      await writeTargetPublishResult({
        serviceClient,
        target,
        status: "failed",
        errorCode: "CONNECTION_PLATFORM_MISMATCH",
        errorMessage: "Selected connection platform does not match publish target.",
        attemptedAt
      });
      continue;
    }

    let accessToken: string;
    let refreshToken: string | null = null;

    try {
      accessToken = decryptSecret(connection.access_token_enc);
      refreshToken = connection.refresh_token_enc ? decryptSecret(connection.refresh_token_enc) : null;
    } catch {
      failedCount += 1;
      failureCodes.push("CONNECTION_TOKEN_INVALID");
      failureMessages.push("Stored connection token is invalid. Reconnect the account.");

      await writeTargetPublishResult({
        serviceClient,
        target,
        status: "failed",
        errorCode: "CONNECTION_TOKEN_INVALID",
        errorMessage: "Stored connection token is invalid. Reconnect the account.",
        attemptedAt
      });
      continue;
    }

    const isMetaTarget = target.platform === "facebook" || target.platform === "instagram";
    const tokenExpired =
      typeof connection.expires_at === "string" &&
      !Number.isNaN(new Date(connection.expires_at).getTime()) &&
      new Date(connection.expires_at).getTime() <= Date.now();

    if (isMetaTarget && tokenExpired) {
      const adapter = getAdapter(target.platform);
      const refreshed = await adapter.refreshToken(accessToken);

      if (!refreshed.success || !refreshed.accessToken) {
        failedCount += 1;
        retryableFailures += 1;
        failureCodes.push("META_TOKEN_REFRESH_FAILED");
        failureMessages.push("Connection token refresh failed. Retrying.");

        await writeTargetPublishResult({
          serviceClient,
          target,
          status: "failed",
          errorCode: "META_TOKEN_REFRESH_FAILED",
          errorMessage: "Connection token refresh failed. Retrying.",
          attemptedAt
        });
        continue;
      }

      accessToken = refreshed.accessToken;
      await updateConnectionToken({
        serviceClient,
        connectionId: connection.id,
        accessToken,
        expiresAt: refreshed.expiresAt
      });
    }

    const targetStatusTable = serviceClient.from("post_targets") as {
      update: (values: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };

    const { error: publishingMarkError } = await targetStatusTable
      .update({ status: "publishing" })
      .eq("id", target.id);

    if (publishingMarkError) {
      throw new PublishWorkerError("POST_TARGET_UPDATE_FAILED", 500, publishingMarkError.message);
    }

    const input = parsePayloadToPublishInput({
      payload: target.payload_json ?? {},
      accessToken,
      accountId: connection.account_id,
      connectionId: connection.id,
      refreshToken,
      expiresAt: connection.expires_at
    });
    const result = await publishToTarget(target.platform, target.connection_id, input);

    if (result.success) {
      await writeTargetPublishResult({
        serviceClient,
        target,
        status: "published",
        externalPostId: result.externalPostId ?? null,
        attemptedAt
      });
      publishedCount += 1;
      continue;
    }

    const failure = categorizePublishFailure(result);
    failedCount += 1;
    if (failure.retryable) {
      retryableFailures += 1;
    }

    failureCodes.push(failure.code);
    failureMessages.push(failure.userMessage);

    await writeTargetPublishResult({
      serviceClient,
      target,
      status: "failed",
      errorCode: failure.code,
      errorMessage: failure.userMessage,
      attemptedAt
    });
  }

  const refreshedTargets = await readTargetsForJob(serviceClient, executionJob.post_id);
  const aggregatePostStatus = aggregatePostDeliveryStatus(refreshedTargets.map((target) => target.status));
  await markPostStatus(serviceClient, post.id, aggregatePostStatus);

  let finalJobStatus: "queued" | "succeeded" | "failed" | "dead_letter";
  let nextRunAt: string | null = null;

  if (aggregatePostStatus === "published") {
    finalJobStatus = "succeeded";
  } else if (retryableFailures > 0 && nextAttempt < executionJob.max_attempts) {
    finalJobStatus = "queued";
    nextRunAt = new Date(Date.now() + getRetryDelaySeconds(nextAttempt) * 1000).toISOString();
  } else if (retryableFailures > 0 && nextAttempt >= executionJob.max_attempts) {
    finalJobStatus = "dead_letter";
  } else {
    finalJobStatus = "failed";
  }

  await updateJobState(serviceClient, executionJob.id, {
    status: finalJobStatus,
    run_at: nextRunAt ?? executionJob.run_at,
    lock_token: null,
    locked_at: null,
    last_error_code: failureCodes[0] ?? null,
    last_error_message: failureMessages[0] ?? null
  });

  await writeExecutionAudit({
    serviceClient,
    workspaceId: post.workspace_id,
    eventType: "publish.job.executed",
    metadata: {
      jobId: executionJob.id,
      postId: executionJob.post_id,
      attempt: nextAttempt,
      finalJobStatus,
      aggregatePostStatus,
      attemptedTargets: actionableTargets.length,
      publishedTargets: publishedCount,
      failedTargets: failedCount,
      retryableFailures
    }
  });

  return {
    jobId: executionJob.id,
    postId: executionJob.post_id,
    status: finalJobStatus,
    postStatus: aggregatePostStatus,
    nextRunAt,
    summary: {
      attemptedTargets: actionableTargets.length,
      publishedTargets: publishedCount,
      failedTargets: failedCount,
      retryableFailures
    }
  };
}
