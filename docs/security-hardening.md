# Phase 4 Security Hardening Guide

This document covers the Phase 4 baseline now implemented:
- DB-backed API rate limiting (`consume_api_rate_limit`)
- Route-level enforcement on auth, OAuth start, post write/publish, and media write endpoints
- Payload hardening for JSON body type and size checks
- Structured observability events with optional Sentry forwarding (`SENTRY_DSN`)
- CI security gates for dependency and secret scanning (fail-on-critical)

Alert dashboard/query definitions:
- `docs/observability-alerts.md`
- Alert routing config: `config/alert-routing.json`
- Incident drill runbook: `docs/incident-drill.md`

## 1. Apply Migration

Apply the Phase 4 migration:
- `supabase/migrations/20260228211000_phase4_security_rate_limits.sql`

This migration adds:
- `public.api_rate_limits`
- `public.consume_api_rate_limit(...)`

## 2. Configure Env Vars

Set in app runtime (local + deployment):

```bash
DISABLE_RATE_LIMITS=false
RATE_LIMIT_AUTH_LOGIN_MAX=8
RATE_LIMIT_AUTH_LOGIN_WINDOW_SECONDS=60
RATE_LIMIT_AUTH_SIGNUP_MAX=4
RATE_LIMIT_AUTH_SIGNUP_WINDOW_SECONDS=60
RATE_LIMIT_OAUTH_START_MAX=12
RATE_LIMIT_OAUTH_START_WINDOW_SECONDS=60
RATE_LIMIT_POST_WRITE_MAX=40
RATE_LIMIT_POST_WRITE_WINDOW_SECONDS=60
RATE_LIMIT_POST_PUBLISH_QUEUE_MAX=20
RATE_LIMIT_POST_PUBLISH_QUEUE_WINDOW_SECONDS=60
RATE_LIMIT_MEDIA_WRITE_MAX=30
RATE_LIMIT_MEDIA_WRITE_WINDOW_SECONDS=60
```

Notes:
- Leave `DISABLE_RATE_LIMITS=false` in staging/prod.
- `SUPABASE_SERVICE_ROLE_KEY` is required for rate-limit RPC calls.

## 3. Verify Runtime

1. Call `POST /api/auth/login` repeatedly with invalid credentials.
2. Confirm responses eventually return:
   - status `429`
   - error code `RATE_LIMITED`
   - `Retry-After` header
3. Repeat on:
   - `POST /api/posts`
   - `POST /api/posts/:id/publish-now`
   - `POST /api/media/upload-url`

Automated coverage:
- `tests/integration/payload-guards.test.ts`
- `tests/integration-db/rate-limit-enforcement.test.ts`
- `tests/integration-db/rate-limit-rpc.test.ts`

## 4. Incident Runbook

If elevated 429s are observed:
1. Confirm there is no active attack or runaway client.
2. Check recent deploy/config changes to rate-limit env vars.
3. Temporarily raise thresholds for impacted scope only.
4. If production traffic is blocked unexpectedly, set `DISABLE_RATE_LIMITS=true` briefly and roll forward with corrected thresholds.
5. Re-enable limits and monitor error rates for 30 minutes.

## 5. Key Rotation Playbook

If service keys are exposed:
1. Create new Supabase server key in Dashboard.
2. Update runtime env (`SUPABASE_SERVICE_ROLE_KEY`) and CI secrets.
3. Redeploy app and verify protected endpoints.
4. Revoke old key.
5. Document incident timestamp, rotation timestamp, and verification evidence.

## 6. Observability Event Names (Logs + Sentry)

Primary events emitted:
- `security.rate_limit.denied`
- `publish.dispatch.claimed`
- `publish.job.execute.started`
- `publish.target.failed`
- `publish.job.execute.finished`
- `api.posts.publish_now.failed`
- `api.posts.schedule.failed`
- `api.posts.retry_failed.failed`
- `api.media.upload_url.failed`
- `api.media.complete.failed`

Recommended alert starters:
1. `publish.target.failed` where `tags.errorCode = META_TOKEN_REFRESH_FAILED`
2. `publish.job.execute.finished` where `tags.finalJobStatus in (failed, dead_letter)`
3. `security.rate_limit.denied` spike over baseline

## 7. CI Security Gates

The `CI` workflow now includes merge-blocking jobs:
1. `npm audit --audit-level=critical`
2. `gitleaks` repository secret scan
3. `npm run check:prelaunch` (dependency pins + alert routing config + incident drill doc)

If any gate fails, the workflow fails and blocks merge.

## 8. Pre-Launch Checklist Automation

Run locally:

```bash
npm run check:prelaunch
```

This validates:
1. Direct dependency versions are pinned exactly.
2. `config/alert-routing.json` includes required channels and rules.
3. `docs/incident-drill.md` includes required drill sections.
