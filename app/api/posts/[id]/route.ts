import { fail, ok } from "@/lib/api/http";
import { patchPostSchema } from "@/lib/api/schemas";
import { parseJsonBody } from "@/lib/api/validation";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    return fail(access.reason, "You do not have permission to edit posts.", authErrorToStatus(access.reason));
  }

  const parsed = await parseJsonBody(req, patchPostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  return ok(
    {
      id: (await params).id,
      workspaceId: session?.workspaceId,
      message: "Patch draft scaffolded.",
      patch: parsed.data
    },
    501
  );
}
