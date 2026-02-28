import { fail, ok } from "@/lib/api/http";
import { getSessionContext } from "@/lib/auth/session";
import { listUserWorkspaces } from "@/lib/auth/workspace";

export async function GET() {
  const session = await getSessionContext();

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  let workspaces: Awaited<ReturnType<typeof listUserWorkspaces>>;
  try {
    workspaces = await listUserWorkspaces(session.accessToken, session.userId);
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace read failed.";
    return fail("WORKSPACE_READ_FAILED", message, 500);
  }

  const currentWorkspace = workspaces.find((workspace) => workspace.workspaceId === session.workspaceId) ?? null;

  return ok({
    user: {
      id: session.userId,
      email: session.email
    },
    currentWorkspace,
    role: session.role,
    workspaceCount: workspaces.length
  });
}
