import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { completeMediaUploadSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { completeMediaAssetUpload, CompleteMediaUploadError } from "@/lib/media/complete-upload";
import { getMediaBucketName } from "@/lib/media/storage";
import { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase";

export async function POST(req: Request) {
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

  const parsed = await parseJsonBody(req, completeMediaUploadSchema);

  if (!parsed.success) {
    return parsed.response;
  }

  try {
    const result = await completeMediaAssetUpload({
      workspaceId,
      actorUserId: session.userId,
      bucket: getMediaBucketName(),
      storagePath: parsed.data.storagePath,
      mimeType: parsed.data.mimeType,
      size: parsed.data.size,
      checksum: parsed.data.checksum,
      userClient: getSupabaseUserClient(session.accessToken),
      serviceClient: getSupabaseServiceClient()
    });

    return ok(result, 201);
  } catch (error) {
    if (error instanceof CompleteMediaUploadError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to complete media upload.";
    return fail("MEDIA_COMPLETE_FAILED", message, 500);
  }
}
