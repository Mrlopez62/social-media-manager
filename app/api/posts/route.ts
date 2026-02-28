import { fail, ok } from "@/lib/api/http";
import { createPostSchema, platformSchema } from "@/lib/api/schemas";
import { parseJsonBody } from "@/lib/api/validation";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { DraftServiceError, createDraftPost } from "@/lib/posts/drafts";
import { getDraftWriteAccessFailure } from "@/lib/posts/draft-rbac";
import { getSupabaseUserClient } from "@/lib/supabase";

const VALID_POST_FILTERS = new Set([
  "draft",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "partial_failed"
]);

type PostListRow = {
  id: string;
  caption: string;
  hashtags: string[];
  location: string | null;
  status: string;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
};

type TargetListRow = {
  post_id: string;
  id: string;
  platform: string;
  status: string;
  connection_id: string;
};

function parseDateRange(dateRange: string | null) {
  if (!dateRange) {
    return { from: null, to: null };
  }

  const [fromRaw, toRaw] = dateRange.split(",").map((part) => part?.trim() ?? "");

  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;

  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw new DraftServiceError(
      "INVALID_DATE_RANGE",
      400,
      "dateRange must be an ISO date or datetime pair: from,to"
    );
  }

  return {
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null
  };
}

export async function POST(req: Request) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("create", access.reason);
    return fail(failure.code, failure.message, failure.status);
  }

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const parsed = await parseJsonBody(req, createPostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const userClient = getSupabaseUserClient(session.accessToken);

  try {
    const created = await createDraftPost(userClient, {
      workspaceId,
      actorUserId: session.userId,
      input: parsed.data
    });

    return ok(
      {
        post: {
          id: created.post.id,
          caption: created.post.caption,
          hashtags: created.post.hashtags,
          location: created.post.location,
          status: created.post.status,
          scheduledFor: created.post.scheduled_for,
          createdAt: created.post.created_at,
          updatedAt: created.post.updated_at
        },
        targets: created.targets.map((target) => ({
          id: target.id,
          platform: target.platform,
          connectionId: target.connection_id
        })),
        capabilityWarnings: created.warnings
      },
      201
    );
  } catch (error) {
    if (error instanceof DraftServiceError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to create draft post.";
    return fail("POST_CREATE_FAILED", message, 500);
  }
}

export async function GET(req: Request) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor", "viewer"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status");
  const platformFilter = searchParams.get("platform");
  const dateRange = searchParams.get("dateRange");

  if (statusFilter && !VALID_POST_FILTERS.has(statusFilter)) {
    return fail("INVALID_STATUS_FILTER", "Unsupported post status filter.", 400);
  }

  if (platformFilter && !platformSchema.safeParse(platformFilter).success) {
    return fail("INVALID_PLATFORM_FILTER", "Unsupported platform filter.", 400);
  }

  let parsedDateRange;
  try {
    parsedDateRange = parseDateRange(dateRange);
  } catch (error) {
    if (error instanceof DraftServiceError) {
      return fail(error.code, error.message, error.status);
    }

    return fail("INVALID_DATE_RANGE", "Invalid dateRange filter.", 400);
  }

  const userClient = getSupabaseUserClient(session.accessToken);

  let filteredPostIds: string[] | null = null;

  if (platformFilter) {
    const { data: targetRows, error: targetError } = await userClient
      .from("post_targets")
      .select("post_id")
      .eq("platform", platformFilter);

    if (targetError) {
      return fail("POST_TARGET_READ_FAILED", targetError.message, 500);
    }

    filteredPostIds = [...new Set((targetRows ?? []).map((target) => target.post_id))];

    if (filteredPostIds.length === 0) {
      return ok({
        workspaceId,
        filters: {
          status: statusFilter,
          platform: platformFilter,
          dateRange
        },
        items: []
      });
    }
  }

  let postQuery = userClient
    .from("posts")
    .select("id, caption, hashtags, location, status, scheduled_for, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (statusFilter) {
    postQuery = postQuery.eq("status", statusFilter);
  }

  if (filteredPostIds) {
    postQuery = postQuery.in("id", filteredPostIds);
  }

  if (parsedDateRange.from) {
    postQuery = postQuery.gte("created_at", parsedDateRange.from);
  }

  if (parsedDateRange.to) {
    postQuery = postQuery.lte("created_at", parsedDateRange.to);
  }

  const { data: posts, error: postError } = await postQuery;

  if (postError) {
    return fail("POST_READ_FAILED", postError.message, 500);
  }

  const postRows = (posts ?? []) as PostListRow[];
  const postIds = postRows.map((post) => post.id);

  const targetsByPost = new Map<string, TargetListRow[]>();

  if (postIds.length > 0) {
    const { data: targets, error: targetsError } = await userClient
      .from("post_targets")
      .select("id, post_id, platform, status, connection_id")
      .in("post_id", postIds);

    if (targetsError) {
      return fail("POST_TARGET_READ_FAILED", targetsError.message, 500);
    }

    for (const target of (targets ?? []) as TargetListRow[]) {
      const bucket = targetsByPost.get(target.post_id) ?? [];
      bucket.push(target);
      targetsByPost.set(target.post_id, bucket);
    }
  }

  return ok({
    workspaceId,
    filters: {
      status: statusFilter,
      platform: platformFilter,
      dateRange
    },
    items: postRows.map((post) => ({
      id: post.id,
      caption: post.caption,
      hashtags: post.hashtags,
      location: post.location,
      status: post.status,
      scheduledFor: post.scheduled_for,
      createdAt: post.created_at,
      updatedAt: post.updated_at,
      targets:
        targetsByPost.get(post.id)?.map((target) => ({
          id: target.id,
          platform: target.platform,
          status: target.status,
          connectionId: target.connection_id
        })) ?? []
    }))
  });
}
