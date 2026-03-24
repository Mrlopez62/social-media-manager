import { getSessionContext } from "@/lib/auth/session";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { retryFailedPostTargets } from "@/lib/publish/jobs";
import { postRetryFailedOperatorHttpRoute } from "@/lib/publish/operator-route-http";
import {
  enforceRateLimit,
  normalizeRateLimitResponse,
  rateLimitPolicies
} from "@/lib/security/rate-limit";
import { getSupabaseUserClient } from "@/lib/supabase";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const postId = (await params).id;

  return postRetryFailedOperatorHttpRoute({
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
      retryFailedPostTargets: async ({ accessToken, workspaceId, actorUserId, postId: routePostId }) =>
        retryFailedPostTargets({
          userClient: getSupabaseUserClient(accessToken),
          workspaceId,
          actorUserId,
          postId: routePostId
        }),
      emitTelemetry: (payload) => {
        void emitTelemetry(payload);
      }
    }
  });
}
