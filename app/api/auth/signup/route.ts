import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { signupSchema } from "@/lib/api/schemas";
import { getSupabaseAnonClient } from "@/lib/supabase";
import { ensureWorkspaceForUser } from "@/lib/auth/workspace";
import { setAuthCookies, setWorkspaceCookie } from "@/lib/auth/session";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/security/rate-limit";

export async function POST(req: Request) {
  const rateLimited = await enforceRateLimit({
    req,
    policy: rateLimitPolicies.authSignup
  });
  if (rateLimited) {
    return rateLimited;
  }

  const parsed = await parseJsonBody(req, signupSchema);

  if (!parsed.success) {
    return parsed.response;
  }

  const supabase = getSupabaseAnonClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password
  });

  if (error) {
    void emitTelemetry({
      event: "api.auth.signup.failed",
      level: "warning",
      message: "Signup failed.",
      tags: {
        errorCode: "AUTH_SIGNUP_FAILED"
      },
      data: {
        reason: error.message
      }
    });
    return fail("AUTH_SIGNUP_FAILED", error.message, 400);
  }

  if (!data.user) {
    void emitTelemetry({
      event: "api.auth.signup.failed",
      level: "error",
      message: "Signup completed without a user record.",
      tags: {
        errorCode: "AUTH_SIGNUP_FAILED"
      }
    });
    return fail("AUTH_SIGNUP_FAILED", "Signup completed without a user record.", 500);
  }

  if (!data.session) {
    void emitTelemetry({
      event: "api.auth.signup.pending_confirmation",
      level: "info",
      message: "Signup succeeded with email confirmation required.",
      tags: {
        userId: data.user.id
      }
    });
    return ok(
      {
        userId: data.user.id,
        email: data.user.email ?? parsed.data.email,
        emailConfirmationRequired: true,
        message: "Signup succeeded. Confirm your email to continue."
      },
      201
    );
  }

  let workspace;
  try {
    workspace = await ensureWorkspaceForUser(
      data.session.access_token,
      data.user.id,
      parsed.data.workspaceName,
      data.user.email ?? parsed.data.email
    );
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace setup failed.";
    void emitTelemetry({
      event: "api.auth.signup.failed",
      level: "error",
      message: "Signup failed during workspace bootstrap.",
      tags: {
        userId: data.user.id,
        errorCode: "WORKSPACE_BOOTSTRAP_FAILED"
      },
      error: workspaceError
    });
    return fail("WORKSPACE_BOOTSTRAP_FAILED", message, 500);
  }

  const response = ok(
    {
      user: {
        id: data.user.id,
        email: data.user.email ?? parsed.data.email
      },
      workspace,
      emailConfirmationRequired: false
    },
    201
  );

  setAuthCookies(response, data.session);
  setWorkspaceCookie(response, workspace.workspaceId);

  void emitTelemetry({
    event: "api.auth.signup.succeeded",
    level: "info",
    message: "Signup completed.",
    tags: {
      userId: data.user.id,
      workspaceId: workspace.workspaceId
    }
  });

  return response;
}
