import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { loginSchema } from "@/lib/api/schemas";
import { getSupabaseAnonClient } from "@/lib/supabase";
import { ensureWorkspaceForUser } from "@/lib/auth/workspace";
import { setAuthCookies, setWorkspaceCookie } from "@/lib/auth/session";

export async function POST(req: Request) {
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

  return response;
}
