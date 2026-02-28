import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function GET() {
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

  const userClient = getSupabaseUserClient(session.accessToken);
  const { data, error } = await userClient
    .from("media_assets")
    .select("id, storage_path, mime_type, size, checksum, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return fail("MEDIA_READ_FAILED", error.message, 500);
  }

  return ok({
    workspaceId,
    items: (data ?? []).map((asset) => ({
      id: asset.id,
      storagePath: asset.storage_path,
      mimeType: asset.mime_type,
      size: asset.size,
      checksum: asset.checksum,
      createdAt: asset.created_at
    }))
  });
}
