"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cancelQueuedAndRefresh,
  listDashboardPosts,
  loadDashboardPostDetails,
  publishNowAndRefresh,
  retryFailedAndRefresh,
  runWorkerAndRefresh,
  scheduleAndRefresh
} from "@/lib/publish/dashboard-actions";

type PostListItem = {
  id: string;
  caption: string;
  status: string;
  scheduledFor: string | null;
  createdAt: string;
  targets: Array<{
    id: string;
    platform: string;
    status: string;
  }>;
};

type PostListResponse = {
  items: PostListItem[];
};

type PostStatusResponse = {
  summary: {
    aggregateStatus: string;
    totalTargets: number;
    publishedTargets: number;
    failedTargets: number;
  };
  targets: Array<{
    id: string;
    platform: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    attemptCount: number;
    lastAttemptAt: string | null;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
    idempotencyKey?: string | null;
  }>;
};

type PostTimelineResponse = {
  events: Array<{
    id: string;
    at: string;
    type: string;
    summary: string;
  }>;
};

type QueuePostResponse = {
  postId: string;
  mode: "publish_now" | "schedule" | "retry_failed";
  idempotent: boolean;
  scheduledFor: string;
  job: {
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
  };
};

type CancelPostResponse = {
  postId: string;
  mode: "publish_now" | "schedule" | "retry_failed" | "unknown";
  canceledTargetCount: number;
  postStatusAfterCancel: string;
  job: {
    id: string;
    status: string;
    runAt: string;
    attempt: number;
    maxAttempts: number;
  };
};

type RunWorkerResponse = {
  postId: string;
  includeFutureScheduled: boolean;
  runAtBefore: string;
  claimedCount: number;
  executedCount: number;
  executions: Array<{
    jobId: string;
    postId: string;
    status: string;
    skipped?: boolean;
    reason?: string;
    postStatus?: string;
    nextRunAt?: string | null;
  }>;
  status: PostStatusResponse;
};

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function toLocalDateTimeInputValue(iso: string | null) {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function defaultScheduleInputValue() {
  const next = new Date(Date.now() + 30 * 60 * 1000);
  next.setSeconds(0, 0);
  return toLocalDateTimeInputValue(next.toISOString());
}

function getQueueModeFromIdempotencyKey(idempotencyKey: string | null | undefined) {
  if (!idempotencyKey) {
    return "unknown" as const;
  }

  if (idempotencyKey.startsWith("publish_now:")) {
    return "publish_now" as const;
  }

  if (idempotencyKey.startsWith("schedule:")) {
    return "schedule" as const;
  }

  if (idempotencyKey.startsWith("retry_failed:")) {
    return "retry_failed" as const;
  }

  return "unknown" as const;
}

export function PublishDashboard() {
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [status, setStatus] = useState<PostStatusResponse | null>(null);
  const [timeline, setTimeline] = useState<PostTimelineResponse | null>(null);
  const [isLoadingPosts, setIsLoadingPosts] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isQueueingPublishNow, setIsQueueingPublishNow] = useState(false);
  const [isQueueingSchedule, setIsQueueingSchedule] = useState(false);
  const [isCancelingQueue, setIsCancelingQueue] = useState(false);
  const [isRunningWorker, setIsRunningWorker] = useState(false);
  const [includeFutureScheduledRun, setIncludeFutureScheduledRun] = useState(false);
  const [scheduleForLocal, setScheduleForLocal] = useState(defaultScheduleInputValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedPost = useMemo(
    () => posts.find((post) => post.id === selectedPostId) ?? null,
    [posts, selectedPostId]
  );

  const hasFailedTargets = Boolean(status && status.targets.some((target) => target.status === "failed"));
  const hasRunningJob = Boolean(status && status.jobs.some((job) => job.status === "running"));
  const hasQueuedJob = Boolean(status && status.jobs.some((job) => job.status === "queued"));
  const queuedJob = useMemo(
    () => status?.jobs.find((job) => job.status === "queued") ?? null,
    [status]
  );
  const queuedJobMode = getQueueModeFromIdempotencyKey(queuedJob?.idempotencyKey);
  const totalTargets = status?.summary.totalTargets ?? 0;
  const scheduledTargetCount = status?.targets.filter((target) => target.status === "scheduled").length ?? 0;
  const cancelUnsupportedForMode =
    hasQueuedJob &&
    !hasRunningJob &&
    queuedJobMode !== "retry_failed" &&
    totalTargets > 0 &&
    scheduledTargetCount !== totalTargets;
  const cancelDisabledReason = !hasQueuedJob
    ? "No queued job to cancel."
    : hasRunningJob
      ? "Cancel is disabled while a job is running."
      : scheduledTargetCount === 0
        ? "No scheduled targets remain for cancel."
        : cancelUnsupportedForMode
          ? "Queued job cannot be safely canceled because target statuses have diverged."
          : queuedJobMode === "unknown"
            ? "Queued job mode is unknown; cancel may be rejected."
            : "Cancel will revert queued targets before execution.";
  const canCancelQueuedJob =
    hasQueuedJob &&
    !hasRunningJob &&
    scheduledTargetCount > 0 &&
    !cancelUnsupportedForMode &&
    !isLoadingDetails &&
    !isCancelingQueue &&
    !isRunningWorker &&
    !isQueueingPublishNow &&
    !isQueueingSchedule;

  const loadPosts = useCallback(async () => {
    setIsLoadingPosts(true);
    setError(null);

    try {
      const data = await listDashboardPosts<PostListResponse>(fetch);
      setPosts(data.items);
      if (data.items.length === 0) {
        setStatus(null);
        setTimeline(null);
        setSelectedPostId(null);
      } else {
        setSelectedPostId((currentPostId) => {
          if (currentPostId && data.items.some((post) => post.id === currentPostId)) {
            return currentPostId;
          }

          return data.items[0].id;
        });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load posts.");
    } finally {
      setIsLoadingPosts(false);
    }
  }, []);

  const loadPostDetails = useCallback(async (postId: string) => {
    setIsLoadingDetails(true);
    setError(null);

    try {
      const details = await loadDashboardPostDetails<PostStatusResponse, PostTimelineResponse>(
        fetch,
        postId
      );
      setStatus(details.status);
      setTimeline(details.timeline);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load publish details.");
    } finally {
      setIsLoadingDetails(false);
    }
  }, []);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  useEffect(() => {
    if (!selectedPostId) {
      return;
    }

    void loadPostDetails(selectedPostId);
  }, [selectedPostId, loadPostDetails]);

  useEffect(() => {
    if (!selectedPost?.scheduledFor) {
      setScheduleForLocal(defaultScheduleInputValue());
      return;
    }

    setScheduleForLocal(toLocalDateTimeInputValue(selectedPost.scheduledFor));
  }, [selectedPost?.id, selectedPost?.scheduledFor]);

  const onRetryFailed = useCallback(async () => {
    if (!selectedPostId) {
      return;
    }

    setIsRetrying(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await retryFailedAndRefresh<
        QueuePostResponse,
        PostListResponse,
        PostStatusResponse,
        PostTimelineResponse
      >(fetch, selectedPostId);
      setSuccess("Queued failed targets for retry.");
      setPosts(result.posts.items);
      setStatus(result.details.status);
      setTimeline(result.details.timeline);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Retry failed.");
    } finally {
      setIsRetrying(false);
    }
  }, [selectedPostId]);

  const onQueuePublishNow = useCallback(async () => {
    if (!selectedPostId) {
      return;
    }

    setIsQueueingPublishNow(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await publishNowAndRefresh<
        QueuePostResponse,
        PostListResponse,
        PostStatusResponse,
        PostTimelineResponse
      >(fetch, selectedPostId);
      const queued = result.action;
      setSuccess(
        queued.idempotent
          ? "Publish-now request merged with existing queued job."
          : "Queued publish-now job."
      );
      setPosts(result.posts.items);
      setStatus(result.details.status);
      setTimeline(result.details.timeline);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Failed to queue publish-now.");
    } finally {
      setIsQueueingPublishNow(false);
    }
  }, [selectedPostId]);

  const onQueueSchedule = useCallback(async () => {
    if (!selectedPostId) {
      return;
    }

    const scheduledForIso = toIsoDateTime(scheduleForLocal);
    if (!scheduledForIso) {
      setError("Enter a valid schedule datetime.");
      return;
    }

    if (new Date(scheduledForIso).getTime() <= Date.now()) {
      setError("Scheduled time must be in the future.");
      return;
    }

    setIsQueueingSchedule(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await scheduleAndRefresh<
        QueuePostResponse,
        PostListResponse,
        PostStatusResponse,
        PostTimelineResponse
      >(fetch, selectedPostId, scheduledForIso);
      const queued = result.action;

      setSuccess(
        queued.idempotent
          ? "Schedule request merged with existing queued job."
          : `Scheduled publish for ${formatTimestamp(queued.scheduledFor)}.`
      );
      setPosts(result.posts.items);
      setStatus(result.details.status);
      setTimeline(result.details.timeline);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Failed to queue scheduled publish.");
    } finally {
      setIsQueueingSchedule(false);
    }
  }, [scheduleForLocal, selectedPostId]);

  const onCancelQueued = useCallback(async () => {
    if (!selectedPostId) {
      return;
    }

    setIsCancelingQueue(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await cancelQueuedAndRefresh<
        CancelPostResponse,
        PostListResponse,
        PostStatusResponse,
        PostTimelineResponse
      >(fetch, selectedPostId);
      const canceled = result.action;
      setSuccess(
        `Canceled queued publish job (${canceled.mode}); reverted ${canceled.canceledTargetCount} target(s). Post is now ${canceled.postStatusAfterCancel}.`
      );
      setPosts(result.posts.items);
      setStatus(result.details.status);
      setTimeline(result.details.timeline);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Failed to cancel queued publish job.");
    } finally {
      setIsCancelingQueue(false);
    }
  }, [selectedPostId]);

  const onRunWorkerNow = useCallback(async () => {
    if (!selectedPostId) {
      return;
    }

    setIsRunningWorker(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await runWorkerAndRefresh<
        RunWorkerResponse,
        PostListResponse,
        PostStatusResponse,
        PostTimelineResponse
      >(fetch, selectedPostId, {
        includeFutureScheduled: includeFutureScheduledRun,
        limit: 5
      });
      const workerRun = result.action;

      setSuccess(
        workerRun.executedCount > 0
          ? `Worker run finished: claimed ${workerRun.claimedCount}, executed ${workerRun.executedCount}. Aggregate is ${workerRun.status.summary.aggregateStatus}.`
          : `Worker run finished: no jobs claimed (includeFutureScheduled=${workerRun.includeFutureScheduled ? "true" : "false"}).`
      );
      setPosts(result.posts.items);
      setStatus(result.details.status);
      setTimeline(result.details.timeline);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run publish worker.");
    } finally {
      setIsRunningWorker(false);
    }
  }, [includeFutureScheduledRun, selectedPostId]);

  return (
    <main
      style={{
        maxWidth: 1160,
        margin: "48px auto",
        padding: "0 20px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
        lineHeight: 1.5
      }}
    >
      <h1 style={{ marginBottom: 6 }}>One-Stop Social Publisher</h1>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 10
        }}
      >
        <p style={{ marginTop: 0, marginBottom: 0, color: "#4b5563" }}>
          Phase 3 delivery console: inspect publish history and retry failed targets.
        </p>
        <Link
          href="/composer"
          style={{
            border: "1px solid #0f766e",
            borderRadius: 8,
            background: "#f0fdfa",
            color: "#0f766e",
            fontWeight: 600,
            textDecoration: "none",
            padding: "6px 10px"
          }}
        >
          Open Composer
        </Link>
      </div>

      {error ? (
        <div
          style={{
            marginBottom: 16,
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            padding: "10px 12px",
            borderRadius: 8
          }}
        >
          {error}
        </div>
      ) : null}
      {success ? (
        <div
          style={{
            marginBottom: 16,
            border: "1px solid #bbf7d0",
            background: "#f0fdf4",
            color: "#14532d",
            padding: "10px 12px",
            borderRadius: 8
          }}
        >
          {success}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 18
        }}
      >
        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 14
          }}
        >
          <h2 style={{ marginTop: 2, marginBottom: 10, fontSize: 18 }}>Posts</h2>
          {isLoadingPosts ? <p>Loading posts...</p> : null}
          {!isLoadingPosts && posts.length === 0 ? (
            <p style={{ color: "#6b7280" }}>No posts yet. Create a draft and queue publish to populate timeline data.</p>
          ) : null}
          <div style={{ display: "grid", gap: 10 }}>
            {posts.map((post) => {
              const isSelected = post.id === selectedPostId;
              return (
                <button
                  key={post.id}
                  type="button"
                  onClick={() => setSelectedPostId(post.id)}
                  style={{
                    textAlign: "left",
                    border: isSelected ? "2px solid #0f766e" : "1px solid #d1d5db",
                    borderRadius: 10,
                    background: isSelected ? "#f0fdfa" : "white",
                    padding: 10,
                    cursor: "pointer"
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{post.caption || "(empty caption)"}</div>
                  <div style={{ fontSize: 13, color: "#334155" }}>Status: {post.status}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    Scheduled: {formatTimestamp(post.scheduledFor)}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            padding: 14
          }}
        >
          <h2 style={{ marginTop: 2, marginBottom: 10, fontSize: 18 }}>Publish Timeline</h2>
          {!selectedPost ? <p>Select a post to inspect publish status.</p> : null}

          {selectedPost ? (
            <>
              <div
                style={{
                  border: "1px solid #dbeafe",
                  background: "#f8fbff",
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 12
                }}
              >
                <div style={{ fontSize: 13, color: "#334155", marginBottom: 8, fontWeight: 600 }}>
                  Operator Actions
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    disabled={
                      hasRunningJob ||
                      isLoadingDetails ||
                      isQueueingPublishNow ||
                      isQueueingSchedule ||
                      isCancelingQueue ||
                      isRunningWorker
                    }
                    onClick={() => void onQueuePublishNow()}
                    style={{
                      border: "1px solid #2563eb",
                      background:
                        hasRunningJob ||
                        isLoadingDetails ||
                        isQueueingPublishNow ||
                        isQueueingSchedule ||
                        isCancelingQueue ||
                        isRunningWorker
                          ? "#bfdbfe"
                          : "#2563eb",
                      color: "white",
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor:
                        hasRunningJob ||
                        isLoadingDetails ||
                        isQueueingPublishNow ||
                        isQueueingSchedule ||
                        isCancelingQueue ||
                        isRunningWorker
                          ? "not-allowed"
                          : "pointer"
                    }}
                  >
                    {isQueueingPublishNow ? "Queueing..." : "Publish Now"}
                  </button>
                  <input
                    type="datetime-local"
                    value={scheduleForLocal}
                    onChange={(event) => setScheduleForLocal(event.target.value)}
                    disabled={
                      hasRunningJob ||
                      isLoadingDetails ||
                      isQueueingPublishNow ||
                      isQueueingSchedule ||
                      isCancelingQueue ||
                      isRunningWorker
                    }
                    style={{
                      border: "1px solid #cbd5e1",
                      borderRadius: 8,
                      padding: "6px 8px",
                      font: "inherit"
                    }}
                  />
                  <button
                    type="button"
                    disabled={
                      hasRunningJob ||
                      isLoadingDetails ||
                      isQueueingSchedule ||
                      isQueueingPublishNow ||
                      isCancelingQueue ||
                      isRunningWorker
                    }
                    onClick={() => void onQueueSchedule()}
                    style={{
                      border: "1px solid #0f766e",
                      background:
                        hasRunningJob ||
                        isLoadingDetails ||
                        isQueueingSchedule ||
                        isQueueingPublishNow ||
                        isCancelingQueue ||
                        isRunningWorker
                          ? "#99f6e4"
                          : "#0f766e",
                      color: "white",
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor:
                        hasRunningJob ||
                        isLoadingDetails ||
                        isQueueingSchedule ||
                        isQueueingPublishNow ||
                        isCancelingQueue ||
                        isRunningWorker
                          ? "not-allowed"
                          : "pointer"
                    }}
                  >
                    {isQueueingSchedule ? "Queueing..." : "Schedule"}
                  </button>
                  <button
                    type="button"
                    disabled={!canCancelQueuedJob}
                    onClick={() => void onCancelQueued()}
                    style={{
                      border: "1px solid #b91c1c",
                      background:
                        !canCancelQueuedJob ? "#fecaca" : "#b91c1c",
                      color: "white",
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor: !canCancelQueuedJob ? "not-allowed" : "pointer"
                    }}
                  >
                    {isCancelingQueue ? "Canceling..." : "Cancel Queued Job"}
                  </button>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                    <input
                      type="checkbox"
                      checked={includeFutureScheduledRun}
                      onChange={(event) => setIncludeFutureScheduledRun(event.target.checked)}
                      disabled={isRunningWorker || isLoadingDetails}
                    />
                    Include future scheduled
                  </label>
                  <button
                    type="button"
                    onClick={() => void onRunWorkerNow()}
                    disabled={
                      isRunningWorker ||
                      isLoadingDetails ||
                      isQueueingPublishNow ||
                      isQueueingSchedule ||
                      isCancelingQueue
                    }
                    style={{
                      border: "1px solid #4338ca",
                      background:
                        isRunningWorker ||
                        isLoadingDetails ||
                        isQueueingPublishNow ||
                        isQueueingSchedule ||
                        isCancelingQueue
                          ? "#c7d2fe"
                          : "#4338ca",
                      color: "white",
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor:
                        isRunningWorker ||
                        isLoadingDetails ||
                        isQueueingPublishNow ||
                        isQueueingSchedule ||
                        isCancelingQueue
                          ? "not-allowed"
                          : "pointer"
                    }}
                  >
                    {isRunningWorker ? "Running..." : "Run Worker Cycle"}
                  </button>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    {hasRunningJob
                      ? "A publish job is running. Wait for completion before queueing another action."
                      : hasQueuedJob
                        ? "A queued job exists; scheduling/publish-now updates it idempotently, or cancel it."
                        : "No active queue job."}
                  </span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: canCancelQueuedJob ? "#475569" : "#92400e" }}>
                  {cancelDisabledReason}
                </div>
              </div>

              <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>
                  Aggregate: <strong>{status?.summary.aggregateStatus ?? "n/a"}</strong>
                </span>
                <span>
                  Failed targets: <strong>{status?.summary.failedTargets ?? 0}</strong>
                </span>
                <button
                  type="button"
                  disabled={!hasFailedTargets || isRetrying || isLoadingDetails}
                  onClick={() => void onRetryFailed()}
                  style={{
                    border: "1px solid #1d4ed8",
                    background: !hasFailedTargets || isRetrying || isLoadingDetails ? "#bfdbfe" : "#1d4ed8",
                    color: "white",
                    borderRadius: 8,
                    padding: "6px 10px",
                    cursor: !hasFailedTargets || isRetrying || isLoadingDetails ? "not-allowed" : "pointer"
                  }}
                >
                  {isRetrying ? "Retrying..." : "Retry Failed Targets"}
                </button>
              </div>

              {isLoadingDetails ? <p>Loading status and timeline...</p> : null}

              {!isLoadingDetails ? (
                <>
                  <h3 style={{ marginBottom: 8, fontSize: 15 }}>Targets</h3>
                  <div style={{ overflowX: "auto", marginBottom: 14 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #e5e7eb", textAlign: "left" }}>
                          <th style={{ padding: "6px 4px" }}>Platform</th>
                          <th style={{ padding: "6px 4px" }}>Status</th>
                          <th style={{ padding: "6px 4px" }}>Attempts</th>
                          <th style={{ padding: "6px 4px" }}>Last Attempt</th>
                          <th style={{ padding: "6px 4px" }}>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(status?.targets ?? []).map((target) => (
                          <tr key={target.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "6px 4px" }}>{target.platform}</td>
                            <td style={{ padding: "6px 4px" }}>{target.status}</td>
                            <td style={{ padding: "6px 4px" }}>{target.attemptCount}</td>
                            <td style={{ padding: "6px 4px" }}>{formatTimestamp(target.lastAttemptAt)}</td>
                            <td style={{ padding: "6px 4px", color: "#991b1b" }}>
                              {target.errorMessage ?? target.errorCode ?? "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <h3 style={{ marginBottom: 8, fontSize: 15 }}>Jobs</h3>
                  <div style={{ overflowX: "auto", marginBottom: 14 }}>
                    {(status?.jobs ?? []).length === 0 ? (
                      <p style={{ color: "#6b7280" }}>No jobs queued yet.</p>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid #e5e7eb", textAlign: "left" }}>
                            <th style={{ padding: "6px 4px" }}>Status</th>
                            <th style={{ padding: "6px 4px" }}>Run At</th>
                            <th style={{ padding: "6px 4px" }}>Attempt</th>
                            <th style={{ padding: "6px 4px" }}>Max</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(status?.jobs ?? []).map((job) => (
                            <tr key={job.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                              <td style={{ padding: "6px 4px" }}>{job.status}</td>
                              <td style={{ padding: "6px 4px" }}>{formatTimestamp(job.runAt)}</td>
                              <td style={{ padding: "6px 4px" }}>{job.attempt}</td>
                              <td style={{ padding: "6px 4px" }}>{job.maxAttempts}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <h3 style={{ marginBottom: 8, fontSize: 15 }}>Events</h3>
                  <div style={{ display: "grid", gap: 8 }}>
                    {(timeline?.events ?? []).length === 0 ? (
                      <p style={{ color: "#6b7280" }}>No timeline events yet.</p>
                    ) : (
                      (timeline?.events ?? []).map((event) => (
                        <div
                          key={event.id}
                          style={{
                            border: "1px solid #e5e7eb",
                            borderRadius: 8,
                            padding: "8px 10px"
                          }}
                        >
                          <div style={{ fontSize: 12, color: "#6b7280" }}>{formatTimestamp(event.at)}</div>
                          <div style={{ fontWeight: 600 }}>{event.summary}</div>
                          <div style={{ fontSize: 12, color: "#475569" }}>{event.type}</div>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
