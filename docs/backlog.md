# MVP Backlog (Prioritized)

## P0
- Implement Supabase session-based auth in API handlers. (Done)
- Implement workspace bootstrap on first signup. (Done)
- Add workspace profile/select APIs for account/workspace management. (Done)
- Implement Meta OAuth start/callback with token encryption. (Done)
- Implement `POST /api/posts` and `PATCH /api/posts/:id` DB writes. (Done)
- Add integration coverage for OAuth state validation and draft create/edit RBAC. (Done)
- Add DB-backed integration tests for OAuth callback persistence (`social_connections` upsert + `oauth_states` consume). (Done)
- Implement media upload endpoints + `media_assets` persistence. (Done)
- Add DB-backed integration tests for media endpoint completion path checks + `media_assets` insert. (Done)
- Add DB-backed integration tests for media upload URL generation path + audit persistence. (Done)
- Add CI job that runs DB integration tests only when DB secrets are present. (Done)
- Enforce adapter-level capability validation/transform during draft create/edit. (Done)
- Implement job enqueue + idempotency key for publish/schedule. (Done)

## P1
- Implement dispatcher lock strategy (`for update skip locked`). (Done)
- Implement adapter publish + retry classification. (Done)
- Implement Meta adapter publish + token refresh foundation. (Done)
- Implement post status aggregation (`published`, `failed`, `partial_failed`). (Done)
- Add scheduler trigger for dispatch + execute worker flow. (Done)
- Build composer UI with capability warnings.
- Build publish timeline and failure retry UX.

## P2
- Add security checks (rate limits, abuse rules, content-size limits).
- Add operational dashboards and alerts.
- Add TikTok adapter with feature flags.
