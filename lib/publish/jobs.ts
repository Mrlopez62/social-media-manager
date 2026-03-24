import { aggregatePostDeliveryStatus } from "./service.ts";

type UserClientLike = {
  from: (table: string) => unknown;
};

type QueueMode = "publish_now" | "schedule";

type CancelMode = QueueMode | "retry_failed" | "unknown";

type PostRow = {
  id: string;
  workspace_id: string;
  status: string;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
};

type PublishJobRow = {
  id: string;
  post_id: string;
  run_at: string;
  attempt: number;
  max_attempts: number;
  status: string;
  lock_token: string | null;
  locked_at: string | null;
  idempotency_key: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
};

type PostTargetStatusRow = {
  id: string;
  platform: string;
  connection_id: string;
  status: string;
  external_post_id: string | null;
  error_code: string | null;
  error_message: string | null;
  last_attempt_at: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

type AuditEventRow = {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
};

export class PublishJobError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizeRunAt(runAtIso: string) {
  const parsed = new Date(runAtIso);

  if (Number.isNaN(parsed.getTime())) {
    throw new PublishJobError("INVALID_RUN_AT", 400, "runAt must be a valid ISO datetime.");
  }

  return parsed.toISOString();
}

function buildIdempotencyKey(params: {
  mode: QueueMode;
  workspaceId: string;
  postId: string;
  runAtIso: string;
}) {
  if (params.mode === "publish_now") {
    return `${params.mode}:${params.workspaceId}:${params.postId}`;
  }

  return `${params.mode}:${params.workspaceId}:${params.postId}:${params.runAtIso}`;
}

function getModeFromIdempotencyKey(idempotencyKey: string | null): CancelMode {
  if (!idempotencyKey) {
    return "unknown";
  }

  if (idempotencyKey.startsWith("publish_now:")) {
    return "publish_now";
  }

  if (idempotencyKey.startsWith("schedule:")) {
    return "schedule";
  }

  if (idempotencyKey.startsWith("retry_failed:")) {
    return "retry_failed";
  }

  return "unknown";
}

function ensureQueueablePostStatus(postStatus: string) {
  if (!["draft", "scheduled", "failed"].includes(postStatus)) {
    throw new PublishJobError(
      "POST_NOT_QUEUEABLE",
      409,
      "Only draft, scheduled, or failed posts can be queued for publishing."
    );
  }
}

async function readWorkspacePost(userClient: UserClientLike, workspaceId: string, postId: string) {
  const postTable = userClient.from("posts") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => Promise<{ data: PostRow | null; error: { message: string } | null }>;
        };
      };
    };
  };

  const { data: post, error } = await postTable
    .select("id, workspace_id, status, scheduled_for, created_at, updated_at")
    .eq("id", postId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw new PublishJobError("POST_READ_FAILED", 500, error.message);
  }

  if (!post) {
    throw new PublishJobError("POST_NOT_FOUND", 404, "Post not found.");
  }

  return post;
}

async function ensurePostHasTargets(userClient: UserClientLike, postId: string) {
  const targetTable = userClient.from("post_targets") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };

  const { data, error } = await targetTable.select("id").eq("post_id", postId);

  if (error) {
    throw new PublishJobError("POST_TARGET_READ_FAILED", 500, error.message);
  }

  if ((data ?? []).length === 0) {
    throw new PublishJobError(
      "POST_TARGETS_REQUIRED",
      409,
      "At least one post target is required before queueing publish jobs."
    );
  }
}

async function readTargetsForPost(userClient: UserClientLike, postId: string) {
  const targetTable = userClient.from("post_targets") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        order: (column: string, options: { ascending: boolean }) => Promise<{
          data: PostTargetStatusRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };

  const { data, error } = await targetTable
    .select(
      "id, platform, connection_id, status, external_post_id, error_code, error_message, last_attempt_at, attempt_count, created_at, updated_at"
    )
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new PublishJobError("POST_TARGET_READ_FAILED", 500, error.message);
  }

  return data ?? [];
}

async function readActiveJobForPost(userClient: UserClientLike, postId: string) {
  const jobsTable = userClient.from("publish_jobs") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        in: (column: string, values: unknown[]) => {
          order: (column: string, options: { ascending: boolean }) => {
            limit: (value: number) => {
              maybeSingle: () => Promise<{ data: PublishJobRow | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };

  const { data, error } = await jobsTable
    .select(
      "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
    )
    .eq("post_id", postId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new PublishJobError("PUBLISH_JOB_READ_FAILED", 500, error.message);
  }

  return data;
}

async function upsertQueuedJob(params: {
  userClient: UserClientLike;
  postId: string;
  normalizedRunAt: string;
  maxAttempts: number;
  idempotencyKey: string;
}) {
  const activeJob = await readActiveJobForPost(params.userClient, params.postId);
  let queuedJob: PublishJobRow;
  let idempotent = false;

  if (activeJob) {
    if (activeJob.status === "running") {
      throw new PublishJobError(
        "PUBLISH_JOB_ALREADY_RUNNING",
        409,
        "A publish job is already running for this post."
      );
    }

    const jobsTable = params.userClient.from("publish_jobs") as {
      update: (values: unknown) => {
        eq: (column: string, value: unknown) => {
          select: (columns: string) => {
            single: () => Promise<{ data: PublishJobRow | null; error: { message: string } | null }>;
          };
        };
      };
    };

    const { data: updatedJob, error: updateError } = await jobsTable
      .update({
        run_at: params.normalizedRunAt,
        idempotency_key: params.idempotencyKey,
        lock_token: null,
        locked_at: null,
        attempt: 0,
        max_attempts: params.maxAttempts,
        status: "queued",
        last_error_code: null,
        last_error_message: null
      })
      .eq("id", activeJob.id)
      .select(
        "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
      )
      .single();

    if (updateError || !updatedJob) {
      throw new PublishJobError("PUBLISH_JOB_UPDATE_FAILED", 500, updateError?.message ?? "Failed to queue job.");
    }

    queuedJob = updatedJob;
    idempotent = activeJob.idempotency_key === params.idempotencyKey;
  } else {
    const jobsTable = params.userClient.from("publish_jobs") as {
      insert: (values: unknown) => {
        select: (columns: string) => {
          single: () => Promise<{ data: PublishJobRow | null; error: { message: string } | null }>;
        };
      };
    };

    const { data: insertedJob, error: insertError } = await jobsTable
      .insert({
        post_id: params.postId,
        run_at: params.normalizedRunAt,
        attempt: 0,
        max_attempts: params.maxAttempts,
        status: "queued",
        lock_token: null,
        idempotency_key: params.idempotencyKey
      })
      .select(
        "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
      )
      .single();

    if (insertError || !insertedJob) {
      const isActiveJobRace = insertError?.message.toLowerCase().includes("idx_publish_jobs_active_post_unique");

      if (!isActiveJobRace) {
        throw new PublishJobError("PUBLISH_JOB_CREATE_FAILED", 500, insertError?.message ?? "Failed to queue job.");
      }

      const racedJob = await readActiveJobForPost(params.userClient, params.postId);
      if (!racedJob) {
        throw new PublishJobError("PUBLISH_JOB_CREATE_FAILED", 500, "Failed to queue job.");
      }

      queuedJob = racedJob;
      idempotent = true;
    } else {
      queuedJob = insertedJob;
    }
  }

  return { queuedJob, idempotent };
}

async function setPostAndTargetsScheduled(params: {
  userClient: UserClientLike;
  workspaceId: string;
  postId: string;
  runAtIso: string;
}) {
  const postTable = params.userClient.from("posts") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  const { error: postUpdateError } = await postTable
    .update({
      status: "scheduled",
      scheduled_for: params.runAtIso
    })
    .eq("id", params.postId)
    .eq("workspace_id", params.workspaceId);

  if (postUpdateError) {
    throw new PublishJobError("POST_QUEUE_UPDATE_FAILED", 500, postUpdateError.message);
  }

  const targetTable = params.userClient.from("post_targets") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  const { error: targetUpdateError } = await targetTable
    .update({
      status: "scheduled",
      error_code: null,
      error_message: null
    })
    .eq("post_id", params.postId);

  if (targetUpdateError) {
    throw new PublishJobError("POST_TARGET_QUEUE_UPDATE_FAILED", 500, targetUpdateError.message);
  }
}

async function writeAuditEvent(params: {
  userClient: UserClientLike;
  workspaceId: string;
  actorUserId: string;
  eventType: string;
  metadata: Record<string, unknown>;
}) {
  const auditTable = params.userClient.from("audit_events") as {
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };

  const { error } = await auditTable.insert({
    workspace_id: params.workspaceId,
    actor_user_id: params.actorUserId,
    event_type: params.eventType,
    metadata_json: params.metadata
  });

  if (error) {
    throw new PublishJobError("AUDIT_WRITE_FAILED", 500, error.message);
  }
}

export async function queuePostPublish(params: {
  userClient: unknown;
  workspaceId: string;
  actorUserId: string;
  postId: string;
  runAtIso: string;
  mode: QueueMode;
  maxAttempts?: number;
}) {
  const userClient = params.userClient as UserClientLike;
  const normalizedRunAt = normalizeRunAt(params.runAtIso);
  const maxAttempts = Math.max(1, params.maxAttempts ?? 5);
  const now = new Date();
  const runAtDate = new Date(normalizedRunAt);

  if (params.mode === "schedule" && runAtDate.getTime() <= now.getTime()) {
    throw new PublishJobError("SCHEDULE_IN_PAST", 400, "scheduledFor must be in the future.");
  }

  const post = await readWorkspacePost(userClient, params.workspaceId, params.postId);
  ensureQueueablePostStatus(post.status);
  await ensurePostHasTargets(userClient, params.postId);

  const idempotencyKey = buildIdempotencyKey({
    mode: params.mode,
    workspaceId: params.workspaceId,
    postId: params.postId,
    runAtIso: normalizedRunAt
  });

  await setPostAndTargetsScheduled({
    userClient,
    workspaceId: params.workspaceId,
    postId: params.postId,
    runAtIso: normalizedRunAt
  });

  const { queuedJob, idempotent } = await upsertQueuedJob({
    userClient,
    postId: params.postId,
    normalizedRunAt,
    maxAttempts,
    idempotencyKey
  });

  await writeAuditEvent({
    userClient,
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    eventType: params.mode === "publish_now" ? "post.publish_now.queued" : "post.schedule.queued",
    metadata: {
      postId: params.postId,
      runAt: normalizedRunAt,
      jobId: queuedJob.id,
      idempotencyKey,
      idempotent
    }
  });

  return {
    postId: params.postId,
    workspaceId: params.workspaceId,
    mode: params.mode,
    idempotent,
    scheduledFor: normalizedRunAt,
    job: {
      id: queuedJob.id,
      status: queuedJob.status,
      runAt: queuedJob.run_at,
      attempt: queuedJob.attempt,
      maxAttempts: queuedJob.max_attempts,
      idempotencyKey: queuedJob.idempotency_key
    }
  };
}

export async function retryFailedPostTargets(params: {
  userClient: unknown;
  workspaceId: string;
  actorUserId: string;
  postId: string;
  runAtIso?: string;
  maxAttempts?: number;
}) {
  const userClient = params.userClient as UserClientLike;
  const normalizedRunAt = normalizeRunAt(params.runAtIso ?? new Date().toISOString());
  const maxAttempts = Math.max(1, params.maxAttempts ?? 5);

  await readWorkspacePost(userClient, params.workspaceId, params.postId);
  const targets = await readTargetsForPost(userClient, params.postId);

  if (targets.length === 0) {
    throw new PublishJobError(
      "POST_TARGETS_REQUIRED",
      409,
      "At least one post target is required before queueing publish jobs."
    );
  }

  const failedTargets = targets.filter((target) => target.status === "failed");
  if (failedTargets.length === 0) {
    throw new PublishJobError(
      "NO_FAILED_TARGETS",
      409,
      "There are no failed targets to retry for this post."
    );
  }

  const targetTable = userClient.from("post_targets") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  const { error: targetUpdateError } = await targetTable
    .update({
      status: "scheduled",
      error_code: null,
      error_message: null
    })
    .eq("post_id", params.postId)
    .eq("status", "failed");

  if (targetUpdateError) {
    throw new PublishJobError("POST_TARGET_QUEUE_UPDATE_FAILED", 500, targetUpdateError.message);
  }

  const postTable = userClient.from("posts") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  const { error: postUpdateError } = await postTable
    .update({
      status: "scheduled",
      scheduled_for: normalizedRunAt
    })
    .eq("id", params.postId)
    .eq("workspace_id", params.workspaceId);

  if (postUpdateError) {
    throw new PublishJobError("POST_QUEUE_UPDATE_FAILED", 500, postUpdateError.message);
  }

  const idempotencyKey = `retry_failed:${params.workspaceId}:${params.postId}`;
  const { queuedJob, idempotent } = await upsertQueuedJob({
    userClient,
    postId: params.postId,
    normalizedRunAt,
    maxAttempts,
    idempotencyKey
  });

  await writeAuditEvent({
    userClient,
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    eventType: "post.retry_failed.queued",
    metadata: {
      postId: params.postId,
      runAt: normalizedRunAt,
      jobId: queuedJob.id,
      failedTargetIds: failedTargets.map((target) => target.id),
      failedTargetCount: failedTargets.length,
      idempotencyKey,
      idempotent
    }
  });

  return {
    postId: params.postId,
    workspaceId: params.workspaceId,
    mode: "retry_failed" as const,
    idempotent,
    failedTargetCount: failedTargets.length,
    scheduledFor: normalizedRunAt,
    job: {
      id: queuedJob.id,
      status: queuedJob.status,
      runAt: queuedJob.run_at,
      attempt: queuedJob.attempt,
      maxAttempts: queuedJob.max_attempts,
      idempotencyKey: queuedJob.idempotency_key
    }
  };
}

export async function cancelQueuedPostPublish(params: {
  userClient: unknown;
  workspaceId: string;
  actorUserId: string;
  postId: string;
}) {
  const userClient = params.userClient as UserClientLike;

  await readWorkspacePost(userClient, params.workspaceId, params.postId);
  const activeJob = await readActiveJobForPost(userClient, params.postId);

  if (!activeJob) {
    throw new PublishJobError(
      "NO_ACTIVE_PUBLISH_JOB",
      409,
      "There is no active queued/running publish job to cancel."
    );
  }

  if (activeJob.status === "running") {
    throw new PublishJobError(
      "PUBLISH_JOB_ALREADY_RUNNING",
      409,
      "A publish job is already running for this post and cannot be canceled."
    );
  }

  const targets = await readTargetsForPost(userClient, params.postId);

  if (targets.length === 0) {
    throw new PublishJobError(
      "POST_TARGETS_REQUIRED",
      409,
      "At least one post target is required before canceling publish jobs."
    );
  }

  const mode = getModeFromIdempotencyKey(activeJob.idempotency_key);
  const scheduledTargets = targets.filter((target) => target.status === "scheduled");

  if (scheduledTargets.length === 0) {
    throw new PublishJobError(
      "CANCEL_NO_SCHEDULED_TARGETS",
      409,
      "There are no scheduled targets left to cancel for this queued job."
    );
  }

  const hasOnlyScheduledTargets = scheduledTargets.length === targets.length;
  const allowsMixedTargetCancel = mode === "retry_failed";

  if (!hasOnlyScheduledTargets && !allowsMixedTargetCancel) {
    throw new PublishJobError(
      "CANCEL_UNSUPPORTED_STATE",
      409,
      "Cancel is not supported for this queued job because some targets are no longer scheduled."
    );
  }

  const jobsTable = userClient.from("publish_jobs") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          select: (columns: string) => {
            single: () => Promise<{ data: PublishJobRow | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };

  const { data: canceledJob, error: cancelJobError } = await jobsTable
    .update({
      status: "failed",
      lock_token: null,
      locked_at: null,
      last_error_code: "PUBLISH_CANCELED",
      last_error_message: "Queued publish job canceled by user."
    })
    .eq("id", activeJob.id)
    .eq("status", "queued")
    .select(
      "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
    )
    .single();

  if (cancelJobError || !canceledJob) {
    const latestActiveJob = await readActiveJobForPost(userClient, params.postId);
    if (latestActiveJob?.status === "running") {
      throw new PublishJobError(
        "PUBLISH_JOB_ALREADY_RUNNING",
        409,
        "A publish job is already running for this post and cannot be canceled."
      );
    }

    throw new PublishJobError(
      "PUBLISH_JOB_CANCEL_FAILED",
      500,
      cancelJobError?.message ?? "Failed to cancel queued publish job."
    );
  }

  const targetsTable = userClient.from("post_targets") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  const targetRevertStatus = mode === "retry_failed" ? "failed" : "draft";
  const targetErrorCode = "PUBLISH_CANCELED";
  const targetErrorMessage =
    mode === "retry_failed" ? "Retry canceled before execution." : "Canceled before execution.";

  const { error: targetsUpdateError } = await targetsTable
    .update({
      status: targetRevertStatus,
      error_code: targetErrorCode,
      error_message: targetErrorMessage
    })
    .eq("post_id", params.postId)
    .eq("status", "scheduled");

  if (targetsUpdateError) {
    throw new PublishJobError("POST_TARGET_CANCEL_FAILED", 500, targetsUpdateError.message);
  }

  const nextTargetStatuses = targets.map((target) =>
    target.status === "scheduled" ? targetRevertStatus : target.status
  );
  const nextPostStatus =
    mode === "retry_failed" ? aggregatePostDeliveryStatus(nextTargetStatuses) : "draft";

  const postTable = userClient.from("posts") as {
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  const { error: postUpdateError } = await postTable
    .update({
      status: nextPostStatus,
      scheduled_for: null
    })
    .eq("id", params.postId)
    .eq("workspace_id", params.workspaceId);

  if (postUpdateError) {
    throw new PublishJobError("POST_CANCEL_FAILED", 500, postUpdateError.message);
  }

  await writeAuditEvent({
    userClient,
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    eventType: "post.publish.canceled",
    metadata: {
      postId: params.postId,
      jobId: canceledJob.id,
      mode,
      runAt: canceledJob.run_at,
      idempotencyKey: canceledJob.idempotency_key,
      canceledTargetCount: scheduledTargets.length,
      postStatusAfterCancel: nextPostStatus
    }
  });

  return {
    postId: params.postId,
    workspaceId: params.workspaceId,
    mode,
    canceledTargetCount: scheduledTargets.length,
    postStatusAfterCancel: nextPostStatus,
    job: {
      id: canceledJob.id,
      status: canceledJob.status,
      runAt: canceledJob.run_at,
      attempt: canceledJob.attempt,
      maxAttempts: canceledJob.max_attempts,
      idempotencyKey: canceledJob.idempotency_key
    }
  };
}

export async function getPostPublishStatus(params: {
  userClient: unknown;
  workspaceId: string;
  postId: string;
}) {
  const userClient = params.userClient as UserClientLike;
  const post = await readWorkspacePost(userClient, params.workspaceId, params.postId);

  const targets = await readTargetsForPost(userClient, params.postId);

  const jobsTable = userClient.from("publish_jobs") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        order: (column: string, options: { ascending: boolean }) => {
          limit: (value: number) => Promise<{ data: PublishJobRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };

  const { data: jobs, error: jobsError } = await jobsTable
    .select(
      "id, post_id, run_at, attempt, max_attempts, status, lock_token, locked_at, idempotency_key, last_error_code, last_error_message, created_at, updated_at"
    )
    .eq("post_id", params.postId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (jobsError) {
    throw new PublishJobError("PUBLISH_JOB_READ_FAILED", 500, jobsError.message);
  }

  const targetRows = targets;
  const aggregate = aggregatePostDeliveryStatus(targetRows.map((target) => target.status));
  const publishedTargets = targetRows.filter((target) => target.status === "published").length;
  const failedTargets = targetRows.filter((target) => target.status === "failed").length;

  return {
    workspaceId: params.workspaceId,
    post: {
      id: post.id,
      status: post.status,
      scheduledFor: post.scheduled_for,
      createdAt: post.created_at,
      updatedAt: post.updated_at
    },
    summary: {
      aggregateStatus: aggregate,
      totalTargets: targetRows.length,
      publishedTargets,
      failedTargets
    },
    targets: targetRows.map((target) => ({
      id: target.id,
      platform: target.platform,
      connectionId: target.connection_id,
      status: target.status,
      externalPostId: target.external_post_id,
      errorCode: target.error_code,
      errorMessage: target.error_message,
      attemptCount: target.attempt_count,
      lastAttemptAt: target.last_attempt_at,
      updatedAt: target.updated_at
    })),
    jobs: (jobs ?? []).map((job) => ({
      id: job.id,
      status: job.status,
      runAt: job.run_at,
      attempt: job.attempt,
      maxAttempts: job.max_attempts,
      idempotencyKey: job.idempotency_key,
      lockToken: job.lock_token,
      lockedAt: job.locked_at,
      lastErrorCode: job.last_error_code,
      lastErrorMessage: job.last_error_message,
      createdAt: job.created_at,
      updatedAt: job.updated_at
    }))
  };
}

function getTimelineSummary(eventType: string, metadata: Record<string, unknown> | null) {
  if (eventType === "post.publish_now.queued") {
    return "Publish-now job queued.";
  }

  if (eventType === "post.schedule.queued") {
    return "Scheduled publish job queued.";
  }

  if (eventType === "post.retry_failed.queued") {
    return "Failed targets queued for retry.";
  }

  if (eventType === "post.publish.canceled") {
    const mode = metadata?.mode;
    return `Queued publish job canceled (${String(mode ?? "unknown")}).`;
  }

  if (eventType === "publish.job.executed") {
    const finalStatus = metadata?.finalJobStatus;
    const publishedTargets = metadata?.publishedTargets;
    const failedTargets = metadata?.failedTargets;
    return `Publish job executed: ${String(finalStatus ?? "unknown")} (published=${String(publishedTargets ?? 0)}, failed=${String(failedTargets ?? 0)}).`;
  }

  return eventType;
}

export async function getPostPublishTimeline(params: {
  userClient: unknown;
  workspaceId: string;
  postId: string;
  limit?: number;
}) {
  const userClient = params.userClient as UserClientLike;
  await readWorkspacePost(userClient, params.workspaceId, params.postId);
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);

  const auditTable = userClient.from("audit_events") as {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        order: (column: string, options: { ascending: boolean }) => {
          limit: (value: number) => Promise<{ data: AuditEventRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };

  const { data: auditRows, error: auditError } = await auditTable
    .select("id, actor_user_id, event_type, metadata_json, created_at")
    .eq("workspace_id", params.workspaceId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (auditError) {
    throw new PublishJobError("AUDIT_READ_FAILED", 500, auditError.message);
  }

  const filteredRows = (auditRows ?? []).filter(
    (event) => (event.metadata_json as { postId?: string } | null)?.postId === params.postId
  );
  const timelineRows =
    filteredRows.length > limit ? filteredRows.slice(filteredRows.length - limit) : filteredRows;

  return {
    workspaceId: params.workspaceId,
    postId: params.postId,
    events: timelineRows.map((event) => ({
      id: event.id,
      at: event.created_at,
      type: event.event_type,
      actorUserId: event.actor_user_id,
      summary: getTimelineSummary(event.event_type, event.metadata_json),
      metadata: event.metadata_json ?? {}
    }))
  };
}
