import { fail, ok } from "../api/http.ts";
import { handleRunWorkerRoute, type RunWorkerRouteSession } from "./run-worker-route.ts";

type RunWorkerHandlerDeps = Parameters<typeof handleRunWorkerRoute>[0]["deps"];

export type RunWorkerHttpRouteDeps = RunWorkerHandlerDeps & {
  getSessionContext: () => Promise<RunWorkerRouteSession | null>;
};

export async function postRunWorkerHttpRoute(params: {
  req: Request;
  postId: string;
  deps: RunWorkerHttpRouteDeps;
}) {
  const session = await params.deps.getSessionContext();
  const result = await handleRunWorkerRoute({
    req: params.req,
    postId: params.postId,
    session,
    deps: params.deps
  });

  if (!result.ok) {
    return fail(result.error.code, result.error.message, result.status, result.error.details);
  }

  return ok(result.data, result.status);
}
