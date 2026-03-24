import { getSessionContext } from "@/lib/auth/session";
import { getPostPublishTimeline } from "@/lib/publish/jobs";
import { getPostTimelineHttpRoute } from "@/lib/publish/read-route-http";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const postId = (await params).id;

  return getPostTimelineHttpRoute({
    req,
    postId,
    deps: {
      getSessionContext,
      getPostPublishTimeline: async ({ accessToken, workspaceId, postId: routePostId, limit }) =>
        getPostPublishTimeline({
          userClient: getSupabaseUserClient(accessToken),
          workspaceId,
          postId: routePostId,
          limit
        })
    }
  });
}
