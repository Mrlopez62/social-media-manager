type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ApiEnvelope<T> = {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type RefreshedDashboardData<TPosts, TStatus, TTimeline> = {
  posts: TPosts;
  details: {
    status: TStatus;
    timeline: TTimeline;
  };
};

export async function requestDashboardApi<T>(
  fetcher: FetchLike,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetcher(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const payload = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed: ${res.status}`);
  }

  if (!payload.data) {
    throw new Error("Missing response payload.");
  }

  return payload.data;
}

export async function listDashboardPosts<TPosts>(fetcher: FetchLike) {
  return requestDashboardApi<TPosts>(fetcher, "/api/posts");
}

export async function loadDashboardPostDetails<TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string,
  timelineLimit = 100
) {
  const [status, timeline] = await Promise.all([
    requestDashboardApi<TStatus>(fetcher, `/api/posts/${postId}/status`),
    requestDashboardApi<TTimeline>(fetcher, `/api/posts/${postId}/timeline?limit=${timelineLimit}`)
  ]);

  return {
    status,
    timeline
  };
}

async function refreshDashboardState<TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string,
  timelineLimit = 100
): Promise<RefreshedDashboardData<TPosts, TStatus, TTimeline>> {
  const [posts, details] = await Promise.all([
    listDashboardPosts<TPosts>(fetcher),
    loadDashboardPostDetails<TStatus, TTimeline>(fetcher, postId, timelineLimit)
  ]);

  return {
    posts,
    details
  };
}

async function runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>(params: {
  fetcher: FetchLike;
  postId: string;
  actionPath: string;
  actionInit: RequestInit;
  timelineLimit?: number;
}) {
  const action = await requestDashboardApi<TAction>(params.fetcher, params.actionPath, params.actionInit);
  const refreshed = await refreshDashboardState<TPosts, TStatus, TTimeline>(
    params.fetcher,
    params.postId,
    params.timelineLimit
  );

  return {
    action,
    ...refreshed
  };
}

export async function retryFailedAndRefresh<TAction, TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string
) {
  return runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>({
    fetcher,
    postId,
    actionPath: `/api/posts/${postId}/retry-failed`,
    actionInit: { method: "POST" }
  });
}

export async function publishNowAndRefresh<TAction, TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string
) {
  return runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>({
    fetcher,
    postId,
    actionPath: `/api/posts/${postId}/publish-now`,
    actionInit: { method: "POST" }
  });
}

export async function scheduleAndRefresh<TAction, TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string,
  scheduledFor: string
) {
  return runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>({
    fetcher,
    postId,
    actionPath: `/api/posts/${postId}/schedule`,
    actionInit: {
      method: "POST",
      body: JSON.stringify({ scheduledFor })
    }
  });
}

export async function cancelQueuedAndRefresh<TAction, TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string
) {
  return runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>({
    fetcher,
    postId,
    actionPath: `/api/posts/${postId}/cancel`,
    actionInit: { method: "POST" }
  });
}

export async function runWorkerAndRefresh<TAction, TPosts, TStatus, TTimeline>(
  fetcher: FetchLike,
  postId: string,
  params: {
    includeFutureScheduled: boolean;
    limit: number;
  }
) {
  return runActionAndRefresh<TAction, TPosts, TStatus, TTimeline>({
    fetcher,
    postId,
    actionPath: `/api/posts/${postId}/run-worker`,
    actionInit: {
      method: "POST",
      body: JSON.stringify(params)
    }
  });
}
