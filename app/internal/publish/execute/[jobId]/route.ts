import { fail, ok } from "@/lib/api/http";
import { executePublishJobSchema } from "@/lib/api/schemas";
import { emitTelemetry } from "@/lib/observability/telemetry";
import { executeQueuedPublishJob, PublishWorkerError } from "@/lib/publish/worker";
import { getSupabaseServiceClient } from "@/lib/supabase";

function checkWorkerAuth(req: Request) {
  const token = req.headers.get("x-internal-token");
  return Boolean(token && token === process.env.INTERNAL_WORKER_TOKEN);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const jobId = (await params).jobId;

  if (!checkWorkerAuth(req)) {
    void emitTelemetry({
      event: "api.internal.publish_execute.failed",
      level: "warning",
      message: "Internal publish execute rejected due to invalid token.",
      tags: {
        jobId,
        errorCode: "UNAUTHORIZED_INTERNAL"
      }
    });
    return fail("UNAUTHORIZED_INTERNAL", "Invalid internal token.", 401);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = executePublishJobSchema.safeParse(body);

  if (!parsed.success) {
    void emitTelemetry({
      event: "api.internal.publish_execute.failed",
      level: "warning",
      message: "Internal publish execute rejected due to invalid payload.",
      tags: {
        jobId,
        errorCode: "VALIDATION_ERROR"
      }
    });
    return fail("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const result = await executeQueuedPublishJob({
      serviceClient: getSupabaseServiceClient(),
      jobId,
      lockToken: parsed.data.lockToken
    });

    void emitTelemetry({
      event: "api.internal.publish_execute.succeeded",
      level: result.status === "succeeded" ? "info" : "warning",
      message: "Internal publish execute completed.",
      tags: {
        jobId,
        postId: result.postId,
        finalJobStatus: result.status
      }
    });

    return ok(result);
  } catch (error) {
    if (error instanceof PublishWorkerError) {
      void emitTelemetry({
        event: "api.internal.publish_execute.failed",
        level: "error",
        message: "Internal publish execute failed.",
        tags: {
          jobId,
          errorCode: error.code
        },
        error
      });
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to execute publish job.";
    void emitTelemetry({
      event: "api.internal.publish_execute.failed",
      level: "error",
      message: "Internal publish execute failed with unexpected error.",
      tags: {
        jobId,
        errorCode: "PUBLISH_EXECUTE_FAILED"
      },
      error
    });
    return fail("PUBLISH_EXECUTE_FAILED", message, 500);
  }
}
