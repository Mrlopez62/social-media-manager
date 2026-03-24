import { randomBytes } from "crypto";
import { fail, ok } from "@/lib/api/http";
import { platformSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import { buildMetaAuthorizationUrl, isMetaPlatform } from "@/lib/integrations/meta";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/security/rate-limit";
import { getSupabaseUserClient } from "@/lib/supabase";

const OAUTH_STATE_TTL_MINUTES = 15;

export async function POST(
  req: Request,
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

  const rateLimited = await enforceRateLimit({
    req,
    policy: rateLimitPolicies.oauthStart,
    userId: session.userId
  });
  if (rateLimited) {
    return rateLimited;
  }

  const workspaceId = session.workspaceId;
  if (!workspaceId) {
    return fail("NO_WORKSPACE", "Join or create a workspace first.", 409);
  }

  const parsedPlatform = platformSchema.safeParse((await params).id);

  if (!parsedPlatform.success) {
    return fail("INVALID_PLATFORM", "Unsupported platform.", 400);
  }

  if (!isMetaPlatform(parsedPlatform.data)) {
    return fail("PLATFORM_NOT_ENABLED", "Phase 2 currently supports Meta platforms only.", 400);
  }

  let authorizationUrl: string;
  try {
    const state = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000).toISOString();
    authorizationUrl = buildMetaAuthorizationUrl(state);

    const userClient = getSupabaseUserClient(session.accessToken);
    const { error: stateError } = await userClient.from("oauth_states").insert({
      workspace_id: workspaceId,
      actor_user_id: session.userId,
      platform: parsedPlatform.data,
      state,
      redirect_uri: process.env.META_REDIRECT_URI,
      scopes: [
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "instagram_basic",
        "instagram_content_publish",
        "business_management"
      ],
      expires_at: expiresAt
    });

    if (stateError) {
      void emitTelemetry({
        event: "api.connections.oauth_start.failed",
        level: "error",
        message: "OAuth start failed while persisting state.",
        tags: {
          workspaceId,
          userId: session.userId,
          platform: parsedPlatform.data,
          errorCode: "OAUTH_START_FAILED"
        },
        data: {
          reason: stateError.message
        }
      });
      return fail("OAUTH_START_FAILED", stateError.message, 500);
    }

    await userClient.from("audit_events").insert({
      workspace_id: workspaceId,
      actor_user_id: session.userId,
      event_type: "connection.oauth.started",
      metadata_json: {
        platform: parsedPlatform.data,
        expiresAt
      }
    });

    void emitTelemetry({
      event: "api.connections.oauth_start.succeeded",
      level: "info",
      message: "OAuth flow initialized.",
      tags: {
        workspaceId,
        userId: session.userId,
        platform: parsedPlatform.data
      }
    });

    return ok({
      workspaceId,
      platform: parsedPlatform.data,
      authorizationUrl,
      expiresAt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initialize OAuth flow.";
    void emitTelemetry({
      event: "api.connections.oauth_start.failed",
      level: "error",
      message: "OAuth start failed.",
      tags: {
        workspaceId,
        userId: session.userId,
        errorCode: "OAUTH_START_FAILED"
      },
      error
    });
    return fail("OAUTH_START_FAILED", message, 500);
  }
}
