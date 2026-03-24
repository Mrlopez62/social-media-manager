import { fail, ok } from "../api/http.ts";
import { authErrorToStatus, requireRole, type WorkspaceRole } from "../auth/rbac.ts";
import { PublishJobError } from "./jobs.ts";

type ReadRouteSession = {
  workspaceId: string | null;
  role: WorkspaceRole | null;
  accessToken: string;
};

type StatusReadDeps = {
  getSessionContext: () => Promise<ReadRouteSession | null>;
  getPostPublishStatus: (params: {
    accessToken: string;
    workspaceId: string;
    postId: string;
  }) => Promise<unknown>;
};

type TimelineReadDeps = {
  getSessionContext: () => Promise<ReadRouteSession | null>;
  getPostPublishTimeline: (params: {
    accessToken: string;
    workspaceId: string;
    postId: string;
    limit: number;
  }) => Promise<unknown>;
};

function parseTimelineLimit(url: string) {
  const { searchParams } = new URL(url);
  const raw = searchParams.get("limit");

  if (!raw) {
    return 100;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new PublishJobError("INVALID_TIMELINE_LIMIT", 400, "limit must be an integer.");
  }

  return parsed;
}

function getReadAccessFailure(session: ReadRouteSession | null): Response | null {
  const access = requireRole(session, ["owner", "admin", "editor", "viewer"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  if (!session?.workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  return null;
}

export async function getPostStatusHttpRoute(params: {
  postId: string;
  deps: StatusReadDeps;
}) {
  const session = await params.deps.getSessionContext();
  const accessFailure = getReadAccessFailure(session);

  if (accessFailure) {
    return accessFailure;
  }

  const scopedSession = session as ReadRouteSession;

  try {
    const status = await params.deps.getPostPublishStatus({
      accessToken: scopedSession.accessToken,
      workspaceId: scopedSession.workspaceId as string,
      postId: params.postId
    });

    return ok(status);
  } catch (error) {
    if (error instanceof PublishJobError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to load post publish status.";
    return fail("POST_STATUS_FAILED", message, 500);
  }
}

export async function getPostTimelineHttpRoute(params: {
  req: Request;
  postId: string;
  deps: TimelineReadDeps;
}) {
  const session = await params.deps.getSessionContext();
  const accessFailure = getReadAccessFailure(session);

  if (accessFailure) {
    return accessFailure;
  }

  const scopedSession = session as ReadRouteSession;

  try {
    const limit = parseTimelineLimit(params.req.url);
    const timeline = await params.deps.getPostPublishTimeline({
      accessToken: scopedSession.accessToken,
      workspaceId: scopedSession.workspaceId as string,
      postId: params.postId,
      limit
    });

    return ok(timeline);
  } catch (error) {
    if (error instanceof PublishJobError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to load post publish timeline.";
    return fail("POST_TIMELINE_FAILED", message, 500);
  }
}
