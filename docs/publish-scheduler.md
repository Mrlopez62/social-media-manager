# Publish Scheduler Setup (Phase 3)

Use this when you want automatic publish job processing without a separate worker server.

## 1. Deploy the Edge Function

Function source:
- `supabase/functions/publish_scheduler/index.ts`

Required env vars on the function:
- `APP_BASE_URL` (for example `https://your-app.vercel.app`)
- `INTERNAL_WORKER_TOKEN` (must match app env var)
- `PUBLISH_DISPATCH_LIMIT` (optional, default `20`)

## 2. Secure Internal Worker Endpoints

Set the same `INTERNAL_WORKER_TOKEN` in app runtime env.

Used endpoints:
- `POST /internal/publish/dispatch`
- `POST /internal/publish/execute/:jobId`

Both require header:
- `x-internal-token: <INTERNAL_WORKER_TOKEN>`

## 3. Schedule Cron Invocation

Create a scheduled trigger (Supabase Cron or external scheduler) that invokes the Edge Function:
- Function: `publish_scheduler`
- Method: `POST`
- Recommended frequency: every minute

Example payload:

```json
{
  "runAtBefore": "2026-02-28T18:00:00.000Z"
}
```

If omitted, the function uses current server time.

## 4. Verify Runtime

1. Queue a post via `POST /api/posts/:id/publish-now` or `POST /api/posts/:id/schedule`.
2. Invoke the scheduler function once manually.
3. Confirm changes in:
   - `publish_jobs` (`queued -> running -> succeeded|failed|dead_letter`)
   - `post_targets` (`scheduled -> publishing -> published|failed`)
   - `posts` aggregate status

## 5. Failure Handling Notes

- Retry backoff is computed in worker execution (`30s`, `60s`, `120s`, ... capped at `15m`).
- Retryable failures re-queue jobs until `max_attempts` is reached.
- Exhausted retryable failures transition jobs to `dead_letter`.
