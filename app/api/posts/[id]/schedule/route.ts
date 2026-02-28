import { fail, ok } from "@/lib/api/http";
import { parseJsonBody } from "@/lib/api/validation";
import { schedulePostSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    return fail(
      access.reason,
      "You do not have permission to schedule posts.",
      authErrorToStatus(access.reason)
    );
  }

  const parsed = await parseJsonBody(req, schedulePostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  return ok(
    {
      postId: (await params).id,
      workspaceId: session?.workspaceId,
      scheduledFor: parsed.data.scheduledFor,
      message: "Schedule endpoint scaffolded."
    },
    501
  );
}
