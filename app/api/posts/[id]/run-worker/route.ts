import { getSessionContext } from "@/lib/auth/session";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { getPostPublishStatus } from "@/lib/publish/jobs";
import { postRunWorkerHttpRoute } from "@/lib/publish/run-worker-route-http";
import { dispatchAndExecutePostJobs } from "@/lib/publish/worker";
import {
  enforceRateLimit,
  normalizeRateLimitResponse,
  rateLimitPolicies
} from "@/lib/security/rate-limit";
import { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const postId = (await params).id;

  return postRunWorkerHttpRoute({
    req,
    postId,
    deps: {
      getSessionContext,
      enforceRateLimit: async ({ req: routeReq, userId }) => {
        const rateLimited = await enforceRateLimit({
          req: routeReq,
          policy: rateLimitPolicies.publishQueue,
          userId
        });

        if (!rateLimited) {
          return null;
        }

        return normalizeRateLimitResponse(rateLimited);
      },
      readWorkspacePost: async ({ accessToken, workspaceId, postId: routePostId }) => {
        const userClient = getSupabaseUserClient(accessToken);
        const { data: post, error } = await userClient
          .from("posts")
          .select("id")
          .eq("id", routePostId)
          .eq("workspace_id", workspaceId)
          .maybeSingle();

        if (error) {
          throw new Error(error.message);
        }

        return post ? { id: post.id as string } : null;
      },
      dispatchAndExecutePostJobs: async ({ postId: routePostId, runAtBefore, limit }) =>
        dispatchAndExecutePostJobs({
          serviceClient: getSupabaseServiceClient(),
          postId: routePostId,
          runAtBefore,
          limit
        }),
      getPostPublishStatus: async ({ accessToken, workspaceId, postId: routePostId }) =>
        getPostPublishStatus({
          userClient: getSupabaseUserClient(accessToken),
          workspaceId,
          postId: routePostId
        }),
      emitTelemetry: (payload) => {
        void emitTelemetry(payload);
      }
    }
  });
}
