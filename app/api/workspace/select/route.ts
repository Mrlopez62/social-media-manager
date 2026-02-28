import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { selectWorkspaceSchema } from "@/lib/api/schemas";
import { getSessionContext, setWorkspaceCookie } from "@/lib/auth/session";
import { listUserWorkspaces } from "@/lib/auth/workspace";

export async function POST(req: Request) {
  const session = await getSessionContext();

  if (!session) {
    return fail("UNAUTHENTICATED", "Authentication is required.", 401);
  }

  const parsed = await parseJsonBody(req, selectWorkspaceSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  let workspaces: Awaited<ReturnType<typeof listUserWorkspaces>>;
  try {
    workspaces = await listUserWorkspaces(session.accessToken, session.userId);
  } catch (workspaceError) {
    const message = workspaceError instanceof Error ? workspaceError.message : "Workspace read failed.";
    return fail("WORKSPACE_READ_FAILED", message, 500);
  }

  const selected = workspaces.find((workspace) => workspace.workspaceId === parsed.data.workspaceId);

  if (!selected) {
    return fail("WORKSPACE_NOT_FOUND", "You are not a member of this workspace.", 404);
  }

  const response = ok({
    workspace: selected
  });

  setWorkspaceCookie(response, selected.workspaceId);
  return response;
}
