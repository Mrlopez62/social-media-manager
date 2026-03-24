import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { createMediaUploadUrlSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { CreateMediaUploadUrlError, createMediaUploadUrl } from "@/lib/media/upload-url";
import { getMediaBucketName } from "@/lib/media/storage";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/security/rate-limit";
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

  const rateLimited = await enforceRateLimit({
    req,
    policy: rateLimitPolicies.mediaWrite,
    userId: session.userId
  });
  if (rateLimited) {
    return rateLimited;
  }

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const parsed = await parseJsonBody(req, createMediaUploadUrlSchema);

  if (!parsed.success) {
    return parsed.response;
  }

  try {
    const result = await createMediaUploadUrl({
      workspaceId,
      actorUserId: session.userId,
      bucket: getMediaBucketName(),
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      size: parsed.data.size,
      userClient: getSupabaseUserClient(session.accessToken),
      serviceClient: getSupabaseServiceClient()
    });

    void emitTelemetry({
      event: "api.media.upload_url.succeeded",
      level: "info",
      message: "Media upload URL created.",
      tags: {
        workspaceId,
        userId: session.userId,
        assetId: result.assetId
      },
      data: {
        bucket: result.bucket
      }
    });

    return ok(result);
  } catch (error) {
    if (error instanceof CreateMediaUploadUrlError) {
      void emitTelemetry({
        event: "api.media.upload_url.failed",
        level: "warning",
        message: "Media upload URL creation failed.",
        tags: {
          workspaceId,
          userId: session.userId,
          errorCode: error.code
        },
        error
      });
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to create upload URL.";
    void emitTelemetry({
      event: "api.media.upload_url.failed",
      level: "error",
      message: "Media upload URL creation failed with unexpected error.",
      tags: {
        workspaceId,
        userId: session.userId,
        errorCode: "MEDIA_UPLOAD_URL_FAILED"
      },
      error
    });
    return fail("MEDIA_UPLOAD_URL_FAILED", message, 500);
  }
}
