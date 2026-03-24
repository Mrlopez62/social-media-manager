import { fail, ok } from "@/lib/api/http";
import { patchPostSchema } from "@/lib/api/schemas";
import { parseJsonBody } from "@/lib/api/validation";
import { getSessionContext, requireRole } from "@/lib/auth/session";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { DraftServiceError, updateDraftPost } from "@/lib/posts/drafts";
import { getDraftWriteAccessFailure } from "@/lib/posts/draft-rbac";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/security/rate-limit";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const failure = getDraftWriteAccessFailure("edit", access.reason);
    return fail(failure.code, failure.message, failure.status);
  }

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const rateLimited = await enforceRateLimit({
    req,
    policy: rateLimitPolicies.postsWrite,
    userId: session.userId
  });
  if (rateLimited) {
    return rateLimited;
  }

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const postId = (await params).id;

  const parsed = await parseJsonBody(req, patchPostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const userClient = getSupabaseUserClient(session.accessToken);

  try {
    const updated = await updateDraftPost(userClient, {
      postId,
      workspaceId,
      actorUserId: session.userId,
      patch: parsed.data
    });

    void emitTelemetry({
      event: "api.posts.update.succeeded",
      level: "info",
      message: "Draft post updated.",
      tags: {
        workspaceId,
        userId: session.userId,
        postId
      },
      data: {
        targetCount: updated.targets.length
      }
    });

    return ok({
      post: {
        id: updated.post.id,
        caption: updated.post.caption,
        hashtags: updated.post.hashtags,
        location: updated.post.location,
        status: updated.post.status,
        scheduledFor: updated.post.scheduled_for,
        updatedAt: updated.post.updated_at
      },
      targets: updated.targets.map((target) => ({
        id: target.id,
        platform: target.platform,
        connectionId: target.connection_id
      })),
      capabilityWarnings: updated.warnings
    });
  } catch (error) {
    if (error instanceof DraftServiceError) {
      void emitTelemetry({
        event: "api.posts.update.failed",
        level: "warning",
        message: "Draft post update failed.",
        tags: {
          workspaceId,
          userId: session.userId,
          postId,
          errorCode: error.code
        },
        error
      });
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to update draft.";
    void emitTelemetry({
      event: "api.posts.update.failed",
      level: "error",
      message: "Draft post update failed with unexpected error.",
      tags: {
        workspaceId,
        userId: session.userId,
        postId,
        errorCode: "POST_UPDATE_FAILED"
      },
      error
    });
    return fail("POST_UPDATE_FAILED", message, 500);
  }
}
