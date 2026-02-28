import { getSupabaseUserClient } from "@/lib/supabase";
import type { WorkspaceRole } from "@/lib/types";

export type UserWorkspace = {
  workspaceId: string;
  role: WorkspaceRole;
  name: string;
  ownerUserId: string;
  createdAt: string;
};

type WorkspaceJoinRow = {
  workspace_id: string;
  role: WorkspaceRole;
  workspaces:
    | {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
      }
    | {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
      }[]
    | null;
};

function normalizeWorkspaceName(input: string | null | undefined, email: string | null) {
  const trimmed = input?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  const prefix = email?.split("@")[0]?.trim();
  if (prefix) {
    return `${prefix}'s Workspace`;
  }

  return "My Workspace";
}

function toUserWorkspace(row: WorkspaceJoinRow): UserWorkspace | null {
  const joined = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;

  if (!joined) {
    return null;
  }

  return {
    workspaceId: row.workspace_id,
    role: row.role,
    name: joined.name,
    ownerUserId: joined.owner_user_id,
    createdAt: joined.created_at
  };
}

export async function listUserWorkspaces(accessToken: string, userId: string): Promise<UserWorkspace[]> {
  const userClient = getSupabaseUserClient(accessToken);
  const { data, error } = await userClient
    .from("workspace_members")
    .select("workspace_id, role, workspaces!inner(id, name, owner_user_id, created_at)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load workspaces: ${error.message}`);
  }

  return ((data ?? []) as WorkspaceJoinRow[])
    .map((row) => toUserWorkspace(row))
    .filter((workspace): workspace is UserWorkspace => workspace !== null);
}

export async function ensureWorkspaceForUser(
  accessToken: string,
  userId: string,
  workspaceName?: string,
  email?: string | null
): Promise<UserWorkspace> {
  const existing = await listUserWorkspaces(accessToken, userId);

  if (existing.length > 0) {
    return existing[0];
  }

  const userClient = getSupabaseUserClient(accessToken);
  const name = normalizeWorkspaceName(workspaceName, email ?? null);
  const { data: newWorkspaceId, error } = await userClient.rpc("create_workspace_with_owner", {
    workspace_name: name
  });

  if (error) {
    throw new Error(`Workspace bootstrap failed: ${error.message}`);
  }

  const refreshed = await listUserWorkspaces(accessToken, userId);
  const newWorkspace = refreshed.find((workspace) => workspace.workspaceId === newWorkspaceId);

  if (!newWorkspace) {
    throw new Error("Workspace bootstrap failed: created workspace could not be read back.");
  }

  return newWorkspace;
}
