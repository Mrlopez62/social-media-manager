# MVP Backlog (Prioritized)

## P0
- Implement Supabase session-based auth in API handlers. (Done)
- Implement workspace bootstrap on first signup. (Done)
- Add workspace profile/select APIs for account/workspace management. (Done)
- Implement Meta OAuth start/callback with token encryption.
- Implement `POST /api/posts` and `PATCH /api/posts/:id` DB writes.
- Implement job enqueue + idempotency key for publish/schedule.

## P1
- Implement dispatcher lock strategy (`for update skip locked`).
- Implement adapter publish + retry classification.
- Implement post status aggregation (`published`, `failed`, `partial_failed`).
- Build composer UI with capability warnings.
- Build publish timeline and failure retry UX.

## P2
- Add security checks (rate limits, abuse rules, content-size limits).
- Add operational dashboards and alerts.
- Add TikTok adapter with feature flags.
