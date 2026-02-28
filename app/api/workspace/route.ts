import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { createWorkspaceSchema } from "@/lib/api/schemas";
import { getSessionContext, setWorkspaceCookie } from "@/lib/auth/session";
import { listUserWorkspaces } from "@/lib/auth/workspace";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function GET() {
  const session = await getSessionContext();

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const userClient = getSupabaseUserClient(session.accessToken);
  let workspacesResult: Awaited<ReturnType<typeof listUserWorkspaces>>;
  try {
    workspacesResult = await listUserWorkspaces(session.accessToken, session.userId);
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace read failed.";
    return fail("WORKSPACE_READ_FAILED", message, 500);
  }

  const { data: profile, error: profileError } = await userClient
    .from("users")
    .select("id, email, created_at")
    .eq("id", session.userId)
    .maybeSingle();

  if (profileError) {
    return fail("PROFILE_READ_FAILED", profileError.message, 500);
  }

  const currentWorkspace = workspacesResult.find((workspace) => workspace.workspaceId === session.workspaceId) ?? null;

  return ok({
    profile: profile
      ? {
          id: profile.id,
          email: profile.email,
          createdAt: profile.created_at
        }
      : {
          id: session.userId,
          email: session.email,
          createdAt: null
        },
    currentWorkspace,
    workspaces: workspacesResult
  });
}

export async function POST(req: Request) {
  const session = await getSessionContext();

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const parsed = await parseJsonBody(req, createWorkspaceSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  const userClient = getSupabaseUserClient(session.accessToken);
  const { data: workspaceId, error } = await userClient.rpc("create_workspace_with_owner", {
    workspace_name: parsed.data.name.trim()
  });

  if (error) {
    return fail("WORKSPACE_CREATE_FAILED", error.message, 400);
  }

  let workspaces: Awaited<ReturnType<typeof listUserWorkspaces>>;
  try {
    workspaces = await listUserWorkspaces(session.accessToken, session.userId);
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace read failed.";
    return fail("WORKSPACE_READ_FAILED", message, 500);
  }
  const createdWorkspace = workspaces.find((workspace) => workspace.workspaceId === workspaceId);

  if (!createdWorkspace) {
    return fail("WORKSPACE_CREATE_FAILED", "Workspace created but could not be loaded.", 500);
  }

  const response = ok(
    {
      workspace: createdWorkspace
    },
    201
  );

  setWorkspaceCookie(response, createdWorkspace.workspaceId);

  return response;
}
