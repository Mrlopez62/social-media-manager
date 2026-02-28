# One-Stop Social Publisher Architecture (MVP)

## Stack
- Frontend: Next.js App Router on Vercel.
- Backend/Data: Supabase Auth, Postgres, Storage, and Edge Functions.
- Scheduling/Workers: internal publish endpoints + cron trigger.
- Observability: Sentry + structured logs.

## Service Boundaries
- `app/api/*`: user-facing endpoints for auth, connections, posts.
- `app/internal/*`: worker-only dispatch/execute surfaces gated by `INTERNAL_WORKER_TOKEN`.
- `lib/adapters/*`: platform connectors with uniform contract.
- `supabase/migrations/*`: source-of-truth schema and RLS policies.

## Request Flow
1. User authenticates and gets workspace-scoped access.
2. User connects Meta accounts via OAuth callback endpoint.
3. User creates draft post and targets one or more connections.
4. User publishes immediately or schedules a job.
5. Worker dispatches queued jobs and calls platform adapters.
6. Per-target status and audit events are persisted for UI + retries.

## Security Baseline
- All tenant tables RLS-enabled.
- Access checks at both API layer and DB layer.
- Internal execution endpoints require shared token.
- Provider tokens are stored encrypted (`*_token_enc`) and not returned to client.

## Known Gaps in Scaffold
- OAuth exchange + token refresh is stubbed.
- Platform adapter publish implementations are scaffolded (queue/worker pipeline is implemented).
- UI flows are not implemented yet.
