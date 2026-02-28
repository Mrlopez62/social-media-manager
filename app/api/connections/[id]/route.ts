import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  return ok(
    {
      workspaceId: session?.workspaceId,
      id: (await params).id,
      message: "Disconnect endpoint scaffolded."
    },
    501
  );
}
