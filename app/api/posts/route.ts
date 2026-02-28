import { fail, ok } from "@/lib/api/http";
import { createPostSchema } from "@/lib/api/schemas";
import { parseJsonBody } from "@/lib/api/validation";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function POST(req: Request) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    const status = authErrorToStatus(access.reason);
    const message =
      access.reason === "UNAUTHENTICATED"
        ? "Authentication is required."
        : access.reason === "NO_WORKSPACE"
          ? "Join or create a workspace first."
          : "You do not have permission to create posts.";

    return fail(access.reason, message, status);
  }

  const parsed = await parseJsonBody(req, createPostSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  return ok(
    {
      message: "Create draft scaffolded.",
      request: parsed.data
    },
    501
  );
}

export async function GET(req: Request) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor", "viewer"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  const { searchParams } = new URL(req.url);
  return ok({
    workspaceId: session?.workspaceId,
    filters: {
      status: searchParams.get("status"),
      platform: searchParams.get("platform"),
      dateRange: searchParams.get("dateRange")
    },
    items: []
  });
}
