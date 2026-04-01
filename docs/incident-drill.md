# Phase 4 Incident Drill Runbook

Use this runbook for pre-launch reliability drills. Run at least one full drill before production launch and monthly afterward.

## Objectives

- Validate alert routing, on-call response, and incident coordination.
- Validate operator ability to triage publish failures quickly.
- Capture objective evidence for launch readiness.

## Participants And Roles

- Incident Commander: owns timeline, severity decisions, and stakeholder updates.
- Ops Responder: investigates worker/job behavior and delivery failures.
- Security Responder: investigates abuse/rate-limit incidents.
- Scribe: records timeline, actions, and outcomes.

## Drill Cadence

- Pre-launch: one full drill in staging and one in production-like preview.
- Post-launch: monthly.
- Triggered drill: after any Sev-1/Sev-2 incident.

## Pre-Drill Checklist

1. Confirm latest migrations are applied.
2. Confirm `SENTRY_DSN` and alert routes are configured.
3. Confirm `config/alert-routing.json` matches active routing destinations.
4. Confirm publish scheduler is enabled for the target environment.
5. Confirm test accounts/connections are available for Meta publish attempts.

## Scenario 1: Dead-Letter Spike

Goal: verify detection and response to dead-letter growth.

Steps:
1. Queue multiple posts with intentionally invalid target payloads.
2. Trigger worker dispatch/execute.
3. Verify alert `Critical - Dead Letter Spike` fires.
4. Triage root cause using `publish.job.execute.finished` and `publish.target.failed`.
5. Execute rollback/mitigation decision and document ETA.

Expected:
- Alert reaches pager and `#ops-alerts`.
- Incident owner assigned within 5 minutes.

## Scenario 2: Meta Token Refresh Failure Burst

Goal: validate handling of repeated token refresh failures.

Steps:
1. Expire or revoke selected Meta connection tokens in staging fixtures.
2. Queue publish jobs for affected targets.
3. Verify `META_TOKEN_REFRESH_FAILED` event spike and alert routing.
4. Reconnect one account and confirm recovery path.

Expected:
- `Critical - Meta Refresh Failures` alert fires.
- Recovery runbook executed without data leakage.

## Execution Timeline

1. Start drill and timestamp `T0`.
2. Inject failure scenario.
3. Observe alert fire and confirm routing.
4. Open incident channel and assign roles.
5. Perform triage and mitigation.
6. Validate stabilization signals.
7. Close drill and capture follow-up actions.

## Drill Evidence File

Create an evidence artifact before each drill:

```bash
npm run ops:drill:init -- --scenario dead-letter-spike --environment staging --commander "Your Name"
```

This creates a timestamped file in `docs/incident-drills/` that you can fill in during the drill.

Validate that at least one completed drill evidence file exists:

```bash
npm run ops:drill:validate
```

For production readiness enforcement (together with real alert routing targets), run:

```bash
npm run check:prelaunch:strict-ops
```

## Evidence Capture Template

- Drill date/time:
- Scenario:
- Environment:
- Alerts fired (name + timestamp):
- Triage owner and response start time:
- Root cause summary:
- Mitigation steps:
- Time to detect:
- Time to mitigate:
- Follow-up actions:

## Exit Criteria

- Alert fired and routed to correct channels.
- Incident owner assigned and triage completed.
- Root cause identified and mitigation executed.
- Evidence template completed and shared.

## Post-Drill Follow-Up

1. Add remediation tasks for any missed detections/routing failures.
2. Update `docs/observability-alerts.md` thresholds if needed.
3. Update `config/alert-routing.json` if channel mapping changed.
4. Schedule next drill.
