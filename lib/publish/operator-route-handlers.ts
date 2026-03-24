import { schedulePostSchema } from "../api/schemas.ts";
import { validateJsonBodyRequest } from "../api/request-guards.ts";
import { authErrorToStatus, requireRole, type WorkspaceRole } from "../auth/rbac.ts";
import { PublishJobError } from "./jobs.ts";

export type OperatorRouteSession = {
  userId: string;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  accessToken: string;
};

export type OperatorRouteError = {
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

type OperatorRouteResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
    }
  | {
      ok: false;
      status: number;
      error: OperatorRouteError;
    };

type RateLimitResult = {
  status: number;
  code: string;
  message: string;
  details?: unknown;
};

type QueuePublishResult = {
  postId: string;
  workspaceId: string;
  mode: "publish_now" | "schedule";
  idempotent: boolean;
  scheduledFor: string;
  job: {
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
    idempotencyKey?: string | null;
  };
};

type CancelPublishResult = {
  postId: string;
  workspaceId: string;
  mode: "publish_now" | "schedule" | "retry_failed" | "unknown";
  canceledTargetCount: number;
  postStatusAfterCancel: string;
  job: {
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
    idempotencyKey?: string | null;
  };
};

type RetryFailedResult = {
  postId: string;
  workspaceId: string;
  mode: "retry_failed";
  idempotent: boolean;
  failedTargetCount: number;
  scheduledFor: string;
  job: {
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
    idempotencyKey?: string | null;
  };
};

type TelemetryPayload = {
  event: string;
  level: "info" | "warning" | "error";
  message: string;
  tags?: Record<string, string>;
  data?: Record<string, unknown>;
  error?: unknown;
};

type BaseOperatorDeps = {
  enforceRateLimit: (params: { req: Request; userId: string }) => Promise<RateLimitResult | null>;
  emitTelemetry?: (payload: TelemetryPayload) => void;
  now?: () => Date;
};

export type PublishNowOperatorDeps = BaseOperatorDeps & {
  queuePostPublish: (params: {
    accessToken: string;
    workspaceId: string;
    actorUserId: string;
    postId: string;
    mode: "publish_now";
    runAtIso: string;
  }) => Promise<QueuePublishResult>;
};

export type ScheduleOperatorDeps = BaseOperatorDeps & {
  queuePostPublish: (params: {
    accessToken: string;
    workspaceId: string;
    actorUserId: string;
    postId: string;
    mode: "schedule";
    runAtIso: string;
  }) => Promise<QueuePublishResult>;
};

export type CancelOperatorDeps = BaseOperatorDeps & {
  cancelQueuedPostPublish: (params: {
    accessToken: string;
    workspaceId: string;
    actorUserId: string;
    postId: string;
  }) => Promise<CancelPublishResult>;
};

export type RetryFailedOperatorDeps = BaseOperatorDeps & {
  retryFailedPostTargets: (params: {
    accessToken: string;
    workspaceId: string;
    actorUserId: string;
    postId: string;
  }) => Promise<RetryFailedResult>;
};

function failResult<T>(
  code: string,
  message: string,
  status: number,
  details?: unknown
): OperatorRouteResult<T> {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      status,
      details
    }
  };
}

function okResult<T>(data: T, status = 200): OperatorRouteResult<T> {
  return {
    ok: true,
    status,
    data
  };
}

function getAuthorizationFailure(
  session: OperatorRouteSession | null,
  forbiddenMessage: string
): OperatorRouteResult<never> | null {
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const message =
      access.reason === "FORBIDDEN"
        ? forbiddenMessage
        : access.reason === "NO_WORKSPACE"
          ? "Join or create a workspace first."
          : "Authentication is required.";

    return failResult<never>(access.reason, message, authErrorToStatus(access.reason));
  }

  if (!session?.workspaceId) {
    return failResult<never>("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  return null;
}

async function checkRateLimit<T>(
  req: Request,
  session: OperatorRouteSession,
  deps: BaseOperatorDeps
): Promise<OperatorRouteResult<T> | null> {
  const rateLimited = await deps.enforceRateLimit({
    req,
    userId: session.userId
  });

  if (!rateLimited) {
    return null;
  }

  return failResult<T>(
    rateLimited.code,
    rateLimited.message,
    rateLimited.status,
    rateLimited.details
  );
}

function handleUnexpectedError<T>(
  code: string,
  fallbackMessage: string,
  error: unknown
): OperatorRouteResult<T> {
  const message = error instanceof Error ? error.message : fallbackMessage;
  return failResult<T>(code, message, 500);
}

export async function handlePublishNowOperatorRoute(params: {
  req: Request;
  postId: string;
  session: OperatorRouteSession | null;
  deps: PublishNowOperatorDeps;
}): Promise<OperatorRouteResult<QueuePublishResult>> {
  const authFailure = getAuthorizationFailure(params.session, "You do not have permission to publish posts.");
  if (authFailure) {
    return authFailure;
  }

  const session = params.session as OperatorRouteSession;
  const rateLimitFailure = await checkRateLimit<QueuePublishResult>(params.req, session, params.deps);
  if (rateLimitFailure) {
    return rateLimitFailure;
  }

  const runAtIso = (params.deps.now?.() ?? new Date()).toISOString();

  try {
    const queued = await params.deps.queuePostPublish({
      accessToken: session.accessToken,
      workspaceId: session.workspaceId as string,
      actorUserId: session.userId,
      postId: params.postId,
      mode: "publish_now",
      runAtIso
    });

    params.deps.emitTelemetry?.({
      event: "api.posts.publish_now.queued",
      level: "info",
      message: "Publish-now job queued.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        jobId: queued.job.id
      }
    });

    return okResult(queued, 202);
  } catch (error) {
    if (error instanceof PublishJobError) {
      params.deps.emitTelemetry?.({
        event: "api.posts.publish_now.failed",
        level: "warning",
        message: "Publish-now queueing failed.",
        tags: {
          workspaceId: session.workspaceId as string,
          userId: session.userId,
          postId: params.postId,
          errorCode: error.code
        },
        error
      });
      return failResult(error.code, error.message, error.status);
    }

    params.deps.emitTelemetry?.({
      event: "api.posts.publish_now.failed",
      level: "error",
      message: "Publish-now queueing failed with unexpected error.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        errorCode: "PUBLISH_NOW_FAILED"
      },
      error
    });

    return handleUnexpectedError(
      "PUBLISH_NOW_FAILED",
      "Failed to queue publish-now job.",
      error
    );
  }
}

export async function handleScheduleOperatorRoute(params: {
  req: Request;
  postId: string;
  session: OperatorRouteSession | null;
  deps: ScheduleOperatorDeps;
}): Promise<OperatorRouteResult<QueuePublishResult>> {
  const authFailure = getAuthorizationFailure(params.session, "You do not have permission to schedule posts.");
  if (authFailure) {
    return authFailure;
  }

  const session = params.session as OperatorRouteSession;
  const rateLimitFailure = await checkRateLimit<QueuePublishResult>(params.req, session, params.deps);
  if (rateLimitFailure) {
    return rateLimitFailure;
  }

  const guardFailure = validateJsonBodyRequest(params.req);
  if (guardFailure) {
    return failResult(guardFailure.code, guardFailure.message, guardFailure.status, guardFailure.details);
  }

  const body = await params.req.json().catch(() => null);
  const parsed = schedulePostSchema.safeParse(body);

  if (!parsed.success) {
    return failResult("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const queued = await params.deps.queuePostPublish({
      accessToken: session.accessToken,
      workspaceId: session.workspaceId as string,
      actorUserId: session.userId,
      postId: params.postId,
      mode: "schedule",
      runAtIso: parsed.data.scheduledFor
    });

    params.deps.emitTelemetry?.({
      event: "api.posts.schedule.queued",
      level: "info",
      message: "Scheduled publish job queued.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        jobId: queued.job.id
      },
      data: {
        scheduledFor: parsed.data.scheduledFor
      }
    });

    return okResult(queued, 202);
  } catch (error) {
    if (error instanceof PublishJobError) {
      params.deps.emitTelemetry?.({
        event: "api.posts.schedule.failed",
        level: "warning",
        message: "Post scheduling failed.",
        tags: {
          workspaceId: session.workspaceId as string,
          userId: session.userId,
          postId: params.postId,
          errorCode: error.code
        },
        error
      });
      return failResult(error.code, error.message, error.status);
    }

    params.deps.emitTelemetry?.({
      event: "api.posts.schedule.failed",
      level: "error",
      message: "Post scheduling failed with unexpected error.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        errorCode: "POST_SCHEDULE_FAILED"
      },
      error
    });

    return handleUnexpectedError(
      "POST_SCHEDULE_FAILED",
      "Failed to schedule publish job.",
      error
    );
  }
}

export async function handleCancelOperatorRoute(params: {
  req: Request;
  postId: string;
  session: OperatorRouteSession | null;
  deps: CancelOperatorDeps;
}): Promise<OperatorRouteResult<CancelPublishResult>> {
  const authFailure = getAuthorizationFailure(
    params.session,
    "You do not have permission to cancel queued publish jobs."
  );
  if (authFailure) {
    return authFailure;
  }

  const session = params.session as OperatorRouteSession;
  const rateLimitFailure = await checkRateLimit<CancelPublishResult>(params.req, session, params.deps);
  if (rateLimitFailure) {
    return rateLimitFailure;
  }

  try {
    const canceled = await params.deps.cancelQueuedPostPublish({
      accessToken: session.accessToken,
      workspaceId: session.workspaceId as string,
      actorUserId: session.userId,
      postId: params.postId
    });

    params.deps.emitTelemetry?.({
      event: "api.posts.cancel.succeeded",
      level: "info",
      message: "Queued publish job canceled.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        jobId: canceled.job.id
      },
      data: {
        mode: canceled.mode,
        canceledTargetCount: canceled.canceledTargetCount
      }
    });

    return okResult(canceled);
  } catch (error) {
    if (error instanceof PublishJobError) {
      params.deps.emitTelemetry?.({
        event: "api.posts.cancel.failed",
        level: "warning",
        message: "Cancel queued publish job failed.",
        tags: {
          workspaceId: session.workspaceId as string,
          userId: session.userId,
          postId: params.postId,
          errorCode: error.code
        },
        error
      });
      return failResult(error.code, error.message, error.status);
    }

    params.deps.emitTelemetry?.({
      event: "api.posts.cancel.failed",
      level: "error",
      message: "Cancel queued publish job failed with unexpected error.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        errorCode: "POST_CANCEL_FAILED"
      },
      error
    });

    return handleUnexpectedError(
      "POST_CANCEL_FAILED",
      "Failed to cancel queued publish job.",
      error
    );
  }
}

export async function handleRetryFailedOperatorRoute(params: {
  req: Request;
  postId: string;
  session: OperatorRouteSession | null;
  deps: RetryFailedOperatorDeps;
}): Promise<OperatorRouteResult<RetryFailedResult>> {
  const authFailure = getAuthorizationFailure(
    params.session,
    "You do not have permission to retry failed publish targets."
  );
  if (authFailure) {
    return authFailure;
  }

  const session = params.session as OperatorRouteSession;
  const rateLimitFailure = await checkRateLimit<RetryFailedResult>(params.req, session, params.deps);
  if (rateLimitFailure) {
    return rateLimitFailure;
  }

  try {
    const retried = await params.deps.retryFailedPostTargets({
      accessToken: session.accessToken,
      workspaceId: session.workspaceId as string,
      actorUserId: session.userId,
      postId: params.postId
    });

    params.deps.emitTelemetry?.({
      event: "api.posts.retry_failed.queued",
      level: "info",
      message: "Failed targets retry queued.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        jobId: retried.job.id
      },
      data: {
        failedTargetCount: retried.failedTargetCount
      }
    });

    return okResult(retried, 202);
  } catch (error) {
    if (error instanceof PublishJobError) {
      params.deps.emitTelemetry?.({
        event: "api.posts.retry_failed.failed",
        level: "warning",
        message: "Failed-target retry queueing failed.",
        tags: {
          workspaceId: session.workspaceId as string,
          userId: session.userId,
          postId: params.postId,
          errorCode: error.code
        },
        error
      });
      return failResult(error.code, error.message, error.status);
    }

    params.deps.emitTelemetry?.({
      event: "api.posts.retry_failed.failed",
      level: "error",
      message: "Failed-target retry queueing failed with unexpected error.",
      tags: {
        workspaceId: session.workspaceId as string,
        userId: session.userId,
        postId: params.postId,
        errorCode: "POST_RETRY_FAILED"
      },
      error
    });

    return handleUnexpectedError(
      "POST_RETRY_FAILED",
      "Failed to queue failed-target retry job.",
      error
    );
  }
}
