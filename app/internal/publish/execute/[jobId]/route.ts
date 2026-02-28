import { fail, ok } from "@/lib/api/http";

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

  return ok(
    {
      jobId: (await params).jobId,
      message: "Execute endpoint scaffolded."
    },
    501
  );
}
