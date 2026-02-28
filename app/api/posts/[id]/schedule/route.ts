import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { schedulePostSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { PublishJobError, queuePostPublish } from "@/lib/publish/jobs";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const message =
      access.reason === "FORBIDDEN"
        ? "You do not have permission to schedule posts."
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

  const parsed = await parseJsonBody(req, schedulePostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const userClient = getSupabaseUserClient(session.accessToken);
  const postId = (await params).id;

  try {
    const queued = await queuePostPublish({
      userClient,
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      postId,
      mode: "schedule",
      runAtIso: parsed.data.scheduledFor
    });

    return ok(queued, 202);
  } catch (error) {
    if (error instanceof PublishJobError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to schedule publish job.";
    return fail("POST_SCHEDULE_FAILED", message, 500);
  }
}
