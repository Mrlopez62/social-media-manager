export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export type RoleCheckReason = "UNAUTHENTICATED" | "NO_WORKSPACE" | "FORBIDDEN";

export type RoleCheckedSession = {
  workspaceId: string | null;
  role: WorkspaceRole | null;
};

export function requireRole(
  session: RoleCheckedSession | null,
  allowed: WorkspaceRole[]
): { allowed: true } | { allowed: false; reason: RoleCheckReason } {
  if (!session) {
    return { allowed: false, reason: "UNAUTHENTICATED" };
  }

  if (!session.workspaceId || !session.role) {
    return { allowed: false, reason: "NO_WORKSPACE" };
  }

  if (!allowed.includes(session.role)) {
    return { allowed: false, reason: "FORBIDDEN" };
  }

  return { allowed: true };
}

export function authErrorToStatus(reason: RoleCheckReason) {
  if (reason === "UNAUTHENTICATED") {
    return 401;
  }

  if (reason === "NO_WORKSPACE") {
    return 409;
  }

  return 403;
}
