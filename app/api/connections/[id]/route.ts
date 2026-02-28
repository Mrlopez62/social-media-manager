import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

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

  const id = (await params).id;
  const userClient = getSupabaseUserClient(session.accessToken);

  const { data: updated, error: updateError } = await userClient
    .from("social_connections")
    .update({
      status: "revoked",
      expires_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select("id, platform, account_id, status, expires_at")
    .maybeSingle();

  if (updateError) {
    return fail("CONNECTION_DISCONNECT_FAILED", updateError.message, 500);
  }

  if (!updated) {
    return fail("CONNECTION_NOT_FOUND", "Connection not found.", 404);
  }

  await userClient.from("audit_events").insert({
    workspace_id: workspaceId,
    actor_user_id: session.userId,
    event_type: "connection.disconnected",
    metadata_json: {
      connectionId: updated.id,
      platform: updated.platform,
      accountId: updated.account_id
    }
  });

  return ok({
    workspaceId,
    connection: {
      id: updated.id,
      platform: updated.platform,
      accountId: updated.account_id,
      status: updated.status,
      expiresAt: updated.expires_at
    }
  });
}
