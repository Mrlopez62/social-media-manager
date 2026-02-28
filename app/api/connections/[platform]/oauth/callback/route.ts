import { fail, ok } from "@/lib/api/http";
import { platformSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";
import {
  MetaCallbackPersistenceError,
  persistMetaCallbackConnections
} from "@/lib/connections/meta-callback-persistence";
import { validateOAuthState } from "@/lib/connections/oauth-state";
import { connectMetaAccountsFromCode, isMetaPlatform } from "@/lib/integrations/meta";
import { encryptSecret } from "@/lib/security/encryption";
import { getSupabaseUserClient } from "@/lib/supabase";

type OAuthStateRow = {
  id: string;
  platform: string;
  expires_at: string;
  consumed_at: string | null;
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ platform: string }> }
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

  const parsedPlatform = platformSchema.safeParse((await params).platform);

  if (!parsedPlatform.success) {
    return fail("INVALID_PLATFORM", "Unsupported platform.", 400);
  }

  if (!isMetaPlatform(parsedPlatform.data)) {
    return fail("PLATFORM_NOT_ENABLED", "Phase 2 currently supports Meta platforms only.", 400);
  }

  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error") ?? url.searchParams.get("error_reason");
  const oauthErrorDescription = url.searchParams.get("error_description");

  if (oauthError) {
    return fail("OAUTH_CALLBACK_DENIED", oauthErrorDescription ?? oauthError, 400);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return fail("OAUTH_CALLBACK_INVALID", "Missing OAuth code or state.", 400);
  }

  const userClient = getSupabaseUserClient(session.accessToken);

  const { data: oauthState, error: stateError } = await userClient
    .from("oauth_states")
    .select("id, platform, expires_at, consumed_at")
    .eq("state", state)
    .eq("workspace_id", workspaceId)
    .eq("actor_user_id", session.userId)
    .maybeSingle();

  if (stateError) {
    return fail("OAUTH_STATE_READ_FAILED", stateError.message, 500);
  }

  const stateValidation = validateOAuthState({
    oauthState: oauthState
      ? {
          platform: oauthState.platform,
          expiresAt: oauthState.expires_at,
          consumedAt: oauthState.consumed_at
        }
      : null,
    expectedPlatform: parsedPlatform.data
  });

  if (!stateValidation.ok) {
    return fail(stateValidation.code, stateValidation.message, stateValidation.status);
  }

  try {
    const connected = await connectMetaAccountsFromCode(code);
    const persisted = await persistMetaCallbackConnections({
      userClient,
      workspaceId,
      actorUserId: session.userId,
      oauthStateId: (oauthState as OAuthStateRow).id,
      platform: parsedPlatform.data,
      expiresAt: connected.expiresAt,
      connections: connected.connections,
      encryptToken: encryptSecret
    });

    return ok({
      workspaceId,
      platform: parsedPlatform.data,
      connectedCount: persisted.connectedCount,
      connections: persisted.connections
    });
  } catch (error) {
    if (error instanceof MetaCallbackPersistenceError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Meta OAuth callback failed.";
    return fail("OAUTH_CALLBACK_FAILED", message, 500);
  }
}
