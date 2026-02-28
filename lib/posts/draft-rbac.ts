import { authErrorToStatus, type RoleCheckReason } from "../auth/rbac.ts";

export type DraftWriteAction = "create" | "edit";

export function getDraftWriteAccessFailure(action: DraftWriteAction, reason: RoleCheckReason) {
  if (reason === "UNAUTHENTICATED") {
    return {
      code: reason,
      status: authErrorToStatus(reason),
      message: "Authentication is required."
    };
  }

  if (reason === "NO_WORKSPACE") {
    return {
      code: reason,
      status: authErrorToStatus(reason),
      message: "Join or create a workspace first."
    };
  }

  return {
    code: reason,
    status: authErrorToStatus(reason),
    message:
      action === "create"
        ? "You do not have permission to create posts."
        : "You do not have permission to edit posts."
  };
}
