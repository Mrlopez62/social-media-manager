import { fail, ok } from "@/lib/api/http";
import { publishDispatchSchema } from "@/lib/api/schemas";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { claimQueuedPublishJobs, PublishWorkerError } from "@/lib/publish/worker";
import { getSupabaseServiceClient } from "@/lib/supabase";

function checkWorkerAuth(req: Request) {
  const token = req.headers.get("x-internal-token");
  return Boolean(token && token === process.env.INTERNAL_WORKER_TOKEN);
}

export async function POST(req: Request) {
  if (!checkWorkerAuth(req)) {
    void emitTelemetry({
      event: "api.internal.publish_dispatch.failed",
      level: "warning",
      message: "Internal publish dispatch rejected due to invalid token.",
      tags: {
        errorCode: "UNAUTHORIZED_INTERNAL"
      }
    });
    return fail("UNAUTHORIZED_INTERNAL", "Invalid internal token.", 401);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = publishDispatchSchema.safeParse(body);

  if (!parsed.success) {
    void emitTelemetry({
      event: "api.internal.publish_dispatch.failed",
      level: "warning",
      message: "Internal publish dispatch rejected due to invalid payload.",
      tags: {
        errorCode: "VALIDATION_ERROR"
      }
    });
    return fail("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const claimed = await claimQueuedPublishJobs({
      serviceClient: getSupabaseServiceClient(),
      postId: parsed.data.postId,
      runAtBefore: parsed.data.runAtBefore,
      limit: parsed.data.limit
    });

    void emitTelemetry({
      event: "api.internal.publish_dispatch.succeeded",
      level: "info",
      message: "Internal publish dispatch completed.",
      tags: {
        postId: parsed.data.postId ?? "all"
      },
      data: {
        claimedCount: claimed.claimedCount
      }
    });

    return ok(claimed);
  } catch (error) {
    if (error instanceof PublishWorkerError) {
      void emitTelemetry({
        event: "api.internal.publish_dispatch.failed",
        level: "error",
        message: "Internal publish dispatch failed.",
        tags: {
          errorCode: error.code
        },
        error
      });
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to dispatch publish jobs.";
    void emitTelemetry({
      event: "api.internal.publish_dispatch.failed",
      level: "error",
      message: "Internal publish dispatch failed with unexpected error.",
      tags: {
        errorCode: "PUBLISH_DISPATCH_FAILED"
      },
      error
    });
    return fail("PUBLISH_DISPATCH_FAILED", message, 500);
  }
}
