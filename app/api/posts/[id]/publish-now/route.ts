import { fail, ok } from "@/lib/api/http";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    return fail(
      access.reason,
      "You do not have permission to publish posts.",
      authErrorToStatus(access.reason)
    );
  }

  return ok(
    {
      postId: (await params).id,
      workspaceId: session?.workspaceId,
      message: "Publish-now endpoint scaffolded."
    },
    501
  );
}
