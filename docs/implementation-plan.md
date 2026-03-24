# Build Execution Plan

## Phase 0 (Foundation)
- Initialize app/runtime scaffolding.
- Define domain types and API contracts.
- Create initial Supabase migration with RLS.
- Set CI baseline (lint + typecheck + tests + security scan).

## Phase 1 (Auth + Workspace)
- Implement Supabase auth flows for signup/login/logout.
- Add workspace provisioning and membership APIs.
- Add role-sensitive UI gates (owner/admin/editor/viewer).
- Add RLS verification tests.

## Phase 2 (Meta Connections + Composer)
- Implement Meta OAuth start/callback endpoints.
- Persist encrypted tokens and refresh metadata.
- Build composer draft UI with media upload and capability checks.
- Add adapter-level validation rules.

Status:
- Backend/API scope complete (OAuth, draft persistence, media upload endpoints, capability validation, integration coverage).
- Frontend composer UI is now available at `/composer`, including draft create/edit with capability warnings and direct media upload (`/api/media/upload-url` + `/api/media/complete`) wired in.

## Phase 3 (Publish + Schedule)
- Implement `publish-now` and `schedule` transactional flows.
- Add queue selection + lock semantics for idempotent workers.
- Record per-target lifecycle and retry history.
- Add categorized error mapping + user-safe messages.

Status:
- Backend/API foundation implemented (queueing routes, dispatch claim, execute lifecycle, status endpoint, retry/backoff).
- Scheduler trigger foundation added via Edge Function (`supabase/functions/publish_scheduler`).
- Meta adapter has real publish/refresh foundation wired into worker token handling.
- Product UX now includes publish timeline + failed-target retry + queue operator actions (`publish-now`, `schedule`, `cancel`), manual worker cycle trigger (`run-worker`), and job run visibility in the dashboard surface, including mixed-target retry-cancel handling and cancel eligibility guidance.
- Route-level integration coverage now validates operator handler flows for `publish-now`, `schedule`, `cancel`, `retry-failed`, and `run-worker` (auth, validation, rate-limit, orchestration, error mapping).
- HTTP wrapper integration coverage now validates response envelope/status mapping for publish operator endpoints.
- HTTP wrapper integration coverage now also validates manual `run-worker` and post read routes (`status`, `timeline`) for envelope/status/error mapping and timeline query parsing.
- Dashboard action-client coverage now validates operator action contracts and post-action refresh sequencing for `/api/posts`, `/status`, and `/timeline`.
- Playwright E2E coverage now validates dashboard publish-now and run-worker flows against mocked API contracts with real UI interactions.
- Playwright E2E coverage now includes Composer OAuth connect/disconnect and media upload flow (upload-url + storage PUT + complete + refresh).
- Remaining work is broader adapter capability depth.

## Phase 4 (Reliability + Security)
- Add alerting for failure spikes and refresh failures.
- Add rate limiting, abuse controls, and payload hardening.
- Add incident runbook and key-rotation playbook.
- Complete pre-launch security checklist.

Status:
- Started: DB-backed API rate limiting and JSON payload hardening are implemented.
- Security runbook and key-rotation baseline documented (`docs/security-hardening.md`).
- Concrete Sentry dashboard queries + alert thresholds are defined (`docs/observability-alerts.md`).
- CI security gates now block merge on critical dependency vulnerabilities and detected secrets.
- Security control tests added for payload guardrails and rate-limit enforcement.
- Pre-launch checklist automation added (`npm run check:prelaunch`) for dependency pins, alert routing, and incident drill coverage.
- Remaining: verify alert channels in production workspace and execute first live incident drill.

## Phase 5 (TikTok)
- Enable TikTok adapter after app review and permission approval.
- Extend capability matrix and validation rules.
- Add integration tests per TikTok publish mode.
