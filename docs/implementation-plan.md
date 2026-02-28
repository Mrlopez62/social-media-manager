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

## Phase 3 (Publish + Schedule)
- Implement `publish-now` and `schedule` transactional flows.
- Add queue selection + lock semantics for idempotent workers.
- Record per-target lifecycle and retry history.
- Add categorized error mapping + user-safe messages.

## Phase 4 (Reliability + Security)
- Add alerting for failure spikes and refresh failures.
- Add rate limiting, abuse controls, and payload hardening.
- Add incident runbook and key-rotation playbook.
- Complete pre-launch security checklist.

## Phase 5 (TikTok)
- Enable TikTok adapter after app review and permission approval.
- Extend capability matrix and validation rules.
- Add integration tests per TikTok publish mode.
