import { fail, ok } from "@/lib/api/http";
import { platformSchema } from "@/lib/api/schemas";
import { authErrorToStatus, getSessionContext, requireRole } from "@/lib/auth/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const session = await getSessionContext();
  const access = requireRole(session, ["owner", "admin", "editor"]);

  if (!access.allowed) {
    return fail(access.reason, "Authentication is required.", authErrorToStatus(access.reason));
  }

  const parsedPlatform = platformSchema.safeParse((await params).platform);

  if (!parsedPlatform.success) {
    return fail("INVALID_PLATFORM", "Unsupported platform.", 400);
  }

  return ok(
    {
      workspaceId: session?.workspaceId,
      platform: parsedPlatform.data,
      authorizationUrl: `/oauth/${parsedPlatform.data}/authorize`
    },
    501
  );
}
