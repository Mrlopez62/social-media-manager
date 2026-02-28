import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { PublishJobError, queuePostPublish } from "@/lib/publish/jobs";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const message =
      access.reason === "FORBIDDEN"
        ? "You do not have permission to publish posts."
        : access.reason === "NO_WORKSPACE"
          ? "Join or create a workspace first."
          : "Authentication is required.";

    return fail(
      access.reason,
      message,
      authErrorToStatus(access.reason)
    );
  }

  if (!session?.workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const userClient = getSupabaseUserClient(session.accessToken);
  const postId = (await params).id;

  try {
    const queued = await queuePostPublish({
      userClient,
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      postId,
      mode: "publish_now",
      runAtIso: new Date().toISOString()
    });

    return ok(queued, 202);
  } catch (error) {
    if (error instanceof PublishJobError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to queue publish-now job.";
    return fail("PUBLISH_NOW_FAILED", message, 500);
  }
}
