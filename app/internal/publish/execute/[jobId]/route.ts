import { fail, ok } from "@/lib/api/http";
import { executePublishJobSchema } from "@/lib/api/schemas";
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
  if (!checkWorkerAuth(req)) {
    return fail("UNAUTHORIZED_INTERNAL", "Invalid internal token.", 401);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = executePublishJobSchema.safeParse(body);

  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const result = await executeQueuedPublishJob({
      serviceClient: getSupabaseServiceClient(),
      jobId: (await params).jobId,
      lockToken: parsed.data.lockToken
    });

    return ok(result);
  } catch (error) {
    if (error instanceof PublishWorkerError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to execute publish job.";
    return fail("PUBLISH_EXECUTE_FAILED", message, 500);
  }
}
