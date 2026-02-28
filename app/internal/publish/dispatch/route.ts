import { fail, ok } from "@/lib/api/http";
import { publishDispatchSchema } from "@/lib/api/schemas";
import { claimQueuedPublishJobs, PublishWorkerError } from "@/lib/publish/worker";
import { getSupabaseServiceClient } from "@/lib/supabase";

function checkWorkerAuth(req: Request) {
  const token = req.headers.get("x-internal-token");
  return Boolean(token && token === process.env.INTERNAL_WORKER_TOKEN);
}

export async function POST(req: Request) {
  if (!checkWorkerAuth(req)) {
    return fail("UNAUTHORIZED_INTERNAL", "Invalid internal token.", 401);
  }

  const body = await req.json().catch(() => ({}));
  const parsed = publishDispatchSchema.safeParse(body);

  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten());
  }

  try {
    const claimed = await claimQueuedPublishJobs({
      serviceClient: getSupabaseServiceClient(),
      postId: parsed.data.postId,
      runAtBefore: parsed.data.runAtBefore,
      limit: parsed.data.limit
    });

    return ok(claimed);
  } catch (error) {
    if (error instanceof PublishWorkerError) {
      return fail(error.code, error.message, error.status);
    }

    const message = error instanceof Error ? error.message : "Failed to dispatch publish jobs.";
    return fail("PUBLISH_DISPATCH_FAILED", message, 500);
  }
}
