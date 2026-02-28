import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { signupSchema } from "@/lib/api/schemas";
import { getSupabaseAnonClient } from "@/lib/supabase";
import { ensureWorkspaceForUser } from "@/lib/auth/workspace";
import { setAuthCookies, setWorkspaceCookie } from "@/lib/auth/session";

export async function POST(req: Request) {
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
    return fail("AUTH_SIGNUP_FAILED", error.message, 400);
  }

  if (!data.user) {
    return fail("AUTH_SIGNUP_FAILED", "Signup completed without a user record.", 500);
  }

  if (!data.session) {
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

  return response;
}
