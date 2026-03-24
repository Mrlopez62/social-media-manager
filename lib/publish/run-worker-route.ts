import { authErrorToStatus, requireRole, type WorkspaceRole } from "../auth/rbac.ts";
import { runPostWorkerSchema } from "../api/schemas.ts";
import { PublishJobError } from "./jobs.ts";
import { PublishWorkerError } from "./worker.ts";

const FUTURE_DISPATCH_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type RunWorkerRouteSession = {
  userId: string;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  accessToken: string;
};

export type RunWorkerRouteError = {
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

type RunWorkerExecution = {
  jobId: string;
  postId: string;
  status: string;
  skipped?: boolean;
  reason?: string;
  postStatus?: string;
  nextRunAt?: string | null;
};

type RunWorkerStatus = {
  summary: {
    aggregateStatus: string;
  };
};

type RunWorkerRouteSuccessData = {
  postId: string;
  includeFutureScheduled: boolean;
  runAtBefore: string;
  claimedCount: number;
  executedCount: number;
  executions: RunWorkerExecution[];
  status: RunWorkerStatus;
};

export type RunWorkerRouteResult =
  | {
      ok: true;
      status: number;
      data: RunWorkerRouteSuccessData;
    }
  | {
      ok: false;
      status: number;
      error: RunWorkerRouteError;
    };

type RateLimitResult = {
  status: number;
  code: string;
  message: string;
  details?: unknown;
};

type DispatchExecutionResult = {
  claimedCount: number;
  executedCount: number;
  executions: RunWorkerExecution[];
};

type RunWorkerRouteDependencies = {
  enforceRateLimit: (params: { req: Request; userId: string }) => Promise<RateLimitResult | null>;
  readWorkspacePost: (params: {
    accessToken: string;
    workspaceId: string;
    postId: string;
  }) => Promise<{ id: string } | null>;
  dispatchAndExecutePostJobs: (params: {
    postId: string;
    runAtBefore: string;
    limit: number;
  }) => Promise<DispatchExecutionResult>;
  getPostPublishStatus: (params: { accessToken: string; workspaceId: string; postId: string }) => Promise<RunWorkerStatus>;
  emitTelemetry?: (payload: {
    event: string;
    level: "info" | "warning" | "error";
    message: string;
    tags?: Record<string, string>;
    data?: Record<string, unknown>;
    error?: unknown;
  }) => void;
  now?: () => Date;
};

function failResult(
  code: string,
  message: string,
  status: number,
  details?: unknown
): RunWorkerRouteResult {
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

function successResult(data: RunWorkerRouteSuccessData, status = 200): RunWorkerRouteResult {
  return {
    ok: true,
    status,
    data
  };
}

export async function handleRunWorkerRoute(params: {
  req: Request;
  postId: string;
  session: RunWorkerRouteSession | null;
  deps: RunWorkerRouteDependencies;
}): Promise<RunWorkerRouteResult> {
  const access = requireRole(params.session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const message =
      access.reason === "FORBIDDEN"
        ? "You do not have permission to run publish workers."
        : access.reason === "NO_WORKSPACE"
          ? "Join or create a workspace first."
          : "Authentication is required.";

    return failResult(access.reason, message, authErrorToStatus(access.reason));
  }

  if (!params.session?.workspaceId) {
    return failResult("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const rateLimited = await params.deps.enforceRateLimit({
    req: params.req,
    userId: params.session.userId
  });

  if (rateLimited) {
    return failResult(rateLimited.code, rateLimited.message, rateLimited.status, rateLimited.details);
  }

  const body = await params.req.json().catch(() => ({}));
  const parsed = runPostWorkerSchema.safeParse(body);

  if (!parsed.success) {
    return failResult("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const post = await params.deps.readWorkspacePost({
      accessToken: params.session.accessToken,
      workspaceId: params.session.workspaceId,
      postId: params.postId
    });

    if (!post) {
      return failResult("POST_NOT_FOUND", "Post not found.", 404);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read post.";
    return failResult("POST_READ_FAILED", message, 500);
  }

  const now = params.deps.now?.() ?? new Date();
  const includeFutureScheduled = parsed.data.includeFutureScheduled ?? false;
  const runAtBefore = includeFutureScheduled
    ? new Date(now.getTime() + FUTURE_DISPATCH_WINDOW_MS).toISOString()
    : now.toISOString();
  const limit = parsed.data.limit ?? 5;

  try {
    const run = await params.deps.dispatchAndExecutePostJobs({
      postId: params.postId,
      runAtBefore,
      limit
    });

    const status = await params.deps.getPostPublishStatus({
      accessToken: params.session.accessToken,
      workspaceId: params.session.workspaceId,
      postId: params.postId
    });

    params.deps.emitTelemetry?.({
      event: "api.posts.run_worker.succeeded",
      level: run.executedCount > 0 ? "info" : "warning",
      message: "Manual publish worker run completed.",
      tags: {
        workspaceId: params.session.workspaceId,
        userId: params.session.userId,
        postId: params.postId
      },
      data: {
        includeFutureScheduled,
        claimedCount: run.claimedCount,
        executedCount: run.executedCount
      }
    });

    return successResult({
      postId: params.postId,
      includeFutureScheduled,
      runAtBefore,
      claimedCount: run.claimedCount,
      executedCount: run.executedCount,
      executions: run.executions,
      status
    });
  } catch (error) {
    if (error instanceof PublishWorkerError || error instanceof PublishJobError) {
      params.deps.emitTelemetry?.({
        event: "api.posts.run_worker.failed",
        level: "warning",
        message: "Manual publish worker run failed.",
        tags: {
          workspaceId: params.session.workspaceId,
          userId: params.session.userId,
          postId: params.postId,
          errorCode: error.code
        },
        error
      });

      return failResult(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to run publish worker.";

    params.deps.emitTelemetry?.({
      event: "api.posts.run_worker.failed",
      level: "error",
      message: "Manual publish worker run failed with unexpected error.",
      tags: {
        workspaceId: params.session.workspaceId,
        userId: params.session.userId,
        postId: params.postId,
        errorCode: "POST_RUN_WORKER_FAILED"
      },
      error
    });

    return failResult("POST_RUN_WORKER_FAILED", message, 500);
  }
}

