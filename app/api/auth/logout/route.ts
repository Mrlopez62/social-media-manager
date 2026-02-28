import { ok } from "@/lib/api/http";
import {
  clearAuthCookies,
  clearWorkspaceCookie,
  getSessionTokens
} from "@/lib/auth/session";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function POST() {
  const { accessToken } = await getSessionTokens();

  if (accessToken) {
    const supabase = getSupabaseUserClient(accessToken);
    await supabase.auth.signOut().catch(() => null);
  }

  const response = ok({ message: "Logged out." });
  clearAuthCookies(response);
  clearWorkspaceCookie(response);

  return response;
}
