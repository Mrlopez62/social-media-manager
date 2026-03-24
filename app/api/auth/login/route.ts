import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { loginSchema } from "@/lib/api/schemas";
import { getSupabaseAnonClient } from "@/lib/supabase";
import { ensureWorkspaceForUser } from "@/lib/auth/workspace";
import { setAuthCookies, setWorkspaceCookie } from "@/lib/auth/session";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/security/rate-limit";

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit({
    req,
    policy: rateLimitPolicies.authLogin
  });
  if (rateLimited) {
    return rateLimited;
  }

  const parsed = await parseJsonBody(req, loginSchema);

  if (!parsed.success) {
    return parsed.response;
  }

  const supabase = getSupabaseAnonClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password
  });

  if (error || !data.user || !data.session) {
    void emitTelemetry({
      event: "api.auth.login.failed",
      level: "warning",
      message: "Login failed.",
      tags: {
        errorCode: "AUTH_LOGIN_FAILED"
      },
      data: {
        reason: error?.message ?? "Invalid credentials."
      }
    });
    return fail("AUTH_LOGIN_FAILED", error?.message ?? "Invalid credentials.", 401);
  }

  let workspace;
  try {
    workspace = await ensureWorkspaceForUser(
      data.session.access_token,
      data.user.id,
      undefined,
      data.user.email ?? parsed.data.email
    );
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace setup failed.";
    void emitTelemetry({
      event: "api.auth.login.failed",
      level: "error",
      message: "Login failed during workspace bootstrap.",
      tags: {
        userId: data.user.id,
        errorCode: "WORKSPACE_BOOTSTRAP_FAILED"
      },
      error: workspaceError
    });
    return fail("WORKSPACE_BOOTSTRAP_FAILED", message, 500);
  }

  const response = ok({
    user: {
      id: data.user.id,
      email: data.user.email ?? parsed.data.email
    },
    workspace
  });

  setAuthCookies(response, data.session);
  setWorkspaceCookie(response, workspace.workspaceId);

  void emitTelemetry({
    event: "api.auth.login.succeeded",
    level: "info",
    message: "Login completed.",
    tags: {
      userId: data.user.id,
      workspaceId: workspace.workspaceId
    }
  });

  return response;
}
