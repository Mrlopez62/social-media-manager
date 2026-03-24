import { getSessionContext } from "@/lib/auth/session";
import { getPostPublishStatus } from "@/lib/publish/jobs";
import { getPostStatusHttpRoute } from "@/lib/publish/read-route-http";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const postId = (await params).id;

  return getPostStatusHttpRoute({
    postId,
    deps: {
      getSessionContext,
      getPostPublishStatus: async ({ accessToken, workspaceId, postId: routePostId }) =>
        getPostPublishStatus({
          userClient: getSupabaseUserClient(accessToken),
          workspaceId,
          postId: routePostId
        })
    }
  });
}
