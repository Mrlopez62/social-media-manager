import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { getPostPublishStatus, PublishJobError } from "@/lib/publish/jobs";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor", "viewer"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  if (!session?.workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const userClient = getSupabaseUserClient(session.accessToken);
  const postId = (await params).id;

  try {
    const status = await getPostPublishStatus({
      userClient,
      workspaceId: session.workspaceId,
      postId
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
