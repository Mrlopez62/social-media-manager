# Phase 4 Observability Dashboards + Alerts (Sentry)

Use this as the source of truth for production monitoring rules.

Routing source of truth:
- `config/alert-routing.json`

## 1. Prerequisites

- `SENTRY_DSN` is configured in the app runtime.
- Telemetry events are flowing (logs + Sentry).
- Use `environment:production` in every alert query.

## 2. Dashboard Definition

Create one Sentry dashboard named: `Social Publisher - Production Ops`

Panels:

1. Publish Job Final Status (15m)
- Query: `environment:production app_event:publish.job.execute.finished`
- Visualization: Timeseries
- Aggregate: `count()`
- Group by: `finalJobStatus`

2. Target Failures by Error Code (15m)
- Query: `environment:production app_event:publish.target.failed`
- Visualization: Top N
- Aggregate: `count()`
- Group by: `errorCode`

3. Meta Refresh Failure Trend (60m)
- Query: `environment:production app_event:publish.target.failed errorCode:META_TOKEN_REFRESH_FAILED`
- Visualization: Timeseries
- Aggregate: `count()`

4. Dead-Letter Jobs (60m)
- Query: `environment:production app_event:publish.job.execute.finished finalJobStatus:dead_letter`
- Visualization: Timeseries
- Aggregate: `count()`

5. API Write Failures (15m)
- Query: `environment:production (app_event:api.posts.publish_now.failed OR app_event:api.posts.schedule.failed OR app_event:api.posts.retry_failed.failed OR app_event:api.media.upload_url.failed OR app_event:api.media.complete.failed)`
- Visualization: Top N
- Aggregate: `count()`
- Group by: `app_event`

6. Rate-Limit Denials (15m)
- Query: `environment:production app_event:security.rate_limit.denied`
- Visualization: Timeseries
- Aggregate: `count()`
- Group by: `scope`

## 3. Alert Rules (Concrete Thresholds)

1. `Critical - Dead Letter Spike`
- Query: `environment:production app_event:publish.job.execute.finished finalJobStatus:dead_letter`
- Condition: `count() >= 3` in `10m`
- Severity: Critical
- Route: Pager + `#ops-alerts`

2. `Warning - Publish Failures Increasing`
- Query: `environment:production app_event:publish.job.execute.finished finalJobStatus:failed`
- Condition: `count() >= 8` in `10m`
- Severity: Warning
- Route: `#ops-alerts`

3. `Critical - Meta Refresh Failures`
- Query: `environment:production app_event:publish.target.failed errorCode:META_TOKEN_REFRESH_FAILED`
- Condition: `count() >= 20` in `15m`
- Severity: Critical
- Route: Pager + `#ops-alerts`

4. `Warning - Meta Refresh Degradation`
- Query: `environment:production app_event:publish.target.failed errorCode:META_TOKEN_REFRESH_FAILED`
- Condition: `count() >= 8` in `15m`
- Severity: Warning
- Route: `#ops-alerts`

5. `Warning - Internal Worker Failures`
- Query: `environment:production (app_event:api.internal.publish_dispatch.failed OR app_event:api.internal.publish_execute.failed)`
- Condition: `count() >= 5` in `10m`
- Severity: Warning
- Route: `#ops-alerts`

6. `Warning - Rate Limit Denial Surge`
- Query: `environment:production app_event:security.rate_limit.denied`
- Condition: `count() >= 200` in `5m`
- Severity: Warning
- Route: `#security-alerts`

7. `Critical - Rate Limit Denial Flood`
- Query: `environment:production app_event:security.rate_limit.denied`
- Condition: `count() >= 500` in `5m`
- Severity: Critical
- Route: Pager + `#security-alerts`

8. `Warning - OAuth Start Failures`
- Query: `environment:production app_event:api.connections.oauth_start.failed`
- Condition: `count() >= 15` in `10m`
- Severity: Warning
- Route: `#ops-alerts`

## 4. Triage Filters

Use these facet/group-by fields in Sentry Discover:
- `workspaceId`
- `postId`
- `platform`
- `errorCode`
- `finalJobStatus`
- `app_event`

## 5. Weekly Threshold Review

Adjust thresholds after one week of baseline production data:
1. Compute p95/p99 of each rule’s `count()` over its window.
2. Set warning threshold near p99.
3. Set critical threshold at roughly `2x` warning threshold (unless business risk requires tighter values).
