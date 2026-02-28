import type { Session } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabaseAnonClient, getSupabaseUserClient } from "@/lib/supabase";
import type { WorkspaceRole } from "@/lib/types";

export const AUTH_ACCESS_COOKIE = "sm_access_token";
export const AUTH_REFRESH_COOKIE = "sm_refresh_token";
export const WORKSPACE_COOKIE = "sm_workspace_id";

export type SessionContext = {
  userId: string;
  email: string | null;
  accessToken: string;
  workspaceId: string | null;
  role: WorkspaceRole | null;
};

type MembershipRow = {
  workspace_id: string;
  role: WorkspaceRole;
};

function cookieConfig(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds
  };
}

export function setAuthCookies(response: NextResponse, session: Session) {
  const accessMaxAge = session.expires_in ?? 60 * 60;

  response.cookies.set(AUTH_ACCESS_COOKIE, session.access_token, cookieConfig(accessMaxAge));
  response.cookies.set(AUTH_REFRESH_COOKIE, session.refresh_token, cookieConfig(60 * 60 * 24 * 30));
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.delete(AUTH_ACCESS_COOKIE);
  response.cookies.delete(AUTH_REFRESH_COOKIE);
}

export function setWorkspaceCookie(response: NextResponse, workspaceId: string) {
  response.cookies.set(WORKSPACE_COOKIE, workspaceId, cookieConfig(60 * 60 * 24 * 365));
}

export function clearWorkspaceCookie(response: NextResponse) {
  response.cookies.delete(WORKSPACE_COOKIE);
}

export async function getSessionTokens() {
  const cookieStore = await cookies();

  return {
    accessToken: cookieStore.get(AUTH_ACCESS_COOKIE)?.value ?? null,
    refreshToken: cookieStore.get(AUTH_REFRESH_COOKIE)?.value ?? null,
    workspaceId: cookieStore.get(WORKSPACE_COOKIE)?.value ?? null
  };
}

export async function getSessionContext(): Promise<SessionContext | null> {
  const { accessToken, workspaceId: selectedWorkspaceId } = await getSessionTokens();

  if (!accessToken) {
    return null;
  }

  const anonClient = getSupabaseAnonClient();
  const {
    data: { user },
    error: userError
  } = await anonClient.auth.getUser(accessToken);

  if (userError || !user) {
    return null;
  }

  const userClient = getSupabaseUserClient(accessToken);
  const { data: memberships, error: membershipError } = await userClient
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (membershipError) {
    return {
      userId: user.id,
      email: user.email ?? null,
      accessToken,
      workspaceId: null,
      role: null
    };
  }

  const normalizedMemberships = (memberships ?? []) as MembershipRow[];

  if (normalizedMemberships.length === 0) {
    return {
      userId: user.id,
      email: user.email ?? null,
      accessToken,
      workspaceId: null,
      role: null
    };
  }

  const selectedMembership =
    normalizedMemberships.find((membership) => membership.workspace_id === selectedWorkspaceId) ??
    normalizedMemberships[0];

  return {
    userId: user.id,
    email: user.email ?? null,
    accessToken,
    workspaceId: selectedMembership.workspace_id,
    role: selectedMembership.role
  };
}

export function requireRole(
  session: SessionContext | null,
  allowed: WorkspaceRole[]
): { allowed: true } | { allowed: false; reason: "UNAUTHENTICATED" | "NO_WORKSPACE" | "FORBIDDEN" } {
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

export function authErrorToStatus(reason: "UNAUTHENTICATED" | "NO_WORKSPACE" | "FORBIDDEN") {
  if (reason === "UNAUTHENTICATED") {
    return 401;
  }

  if (reason === "NO_WORKSPACE") {
    return 409;
  }

  return 403;
}
