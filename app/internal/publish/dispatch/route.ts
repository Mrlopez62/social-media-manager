import { fail, ok } from "@/lib/api/http";
import { publishDispatchSchema } from "@/lib/api/schemas";
import { parseJsonBody } from "@/lib/api/validation";

function checkWorkerAuth(req: Request) {
  const token = req.headers.get("x-internal-token");
  return Boolean(token && token === process.env.INTERNAL_WORKER_TOKEN);
}

export async function POST(req: Request) {
  if (!checkWorkerAuth(req)) {
    return fail("UNAUTHORIZED_INTERNAL", "Invalid internal token.", 401);
  }

  const parsed = await parseJsonBody(req, publishDispatchSchema);
  if (!parsed.success) {
    return parsed.response;
  }

  return ok(
    {
      message: "Dispatch endpoint scaffolded.",
      filter: parsed.data
    },
    501
  );
}
