import { fail, ok } from "../api/http.ts";
import {
  handleCancelOperatorRoute,
  handlePublishNowOperatorRoute,
  handleRetryFailedOperatorRoute,
  handleScheduleOperatorRoute,
  type CancelOperatorDeps,
  type OperatorRouteSession,
  type PublishNowOperatorDeps,
  type RetryFailedOperatorDeps,
  type ScheduleOperatorDeps
} from "./operator-route-handlers.ts";

type WithSessionContext = {
  getSessionContext: () => Promise<OperatorRouteSession | null>;
};

export type PublishNowOperatorHttpDeps = PublishNowOperatorDeps & WithSessionContext;
export type ScheduleOperatorHttpDeps = ScheduleOperatorDeps & WithSessionContext;
export type CancelOperatorHttpDeps = CancelOperatorDeps & WithSessionContext;
export type RetryFailedOperatorHttpDeps = RetryFailedOperatorDeps & WithSessionContext;

export async function postPublishNowOperatorHttpRoute(params: {
  req: Request;
  postId: string;
  deps: PublishNowOperatorHttpDeps;
}) {
  const session = await params.deps.getSessionContext();
  const result = await handlePublishNowOperatorRoute({
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

export async function postScheduleOperatorHttpRoute(params: {
  req: Request;
  postId: string;
  deps: ScheduleOperatorHttpDeps;
}) {
  const session = await params.deps.getSessionContext();
  const result = await handleScheduleOperatorRoute({
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

export async function postCancelOperatorHttpRoute(params: {
  req: Request;
  postId: string;
  deps: CancelOperatorHttpDeps;
}) {
  const session = await params.deps.getSessionContext();
  const result = await handleCancelOperatorRoute({
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

export async function postRetryFailedOperatorHttpRoute(params: {
  req: Request;
  postId: string;
  deps: RetryFailedOperatorHttpDeps;
}) {
  const session = await params.deps.getSessionContext();
  const result = await handleRetryFailedOperatorRoute({
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
