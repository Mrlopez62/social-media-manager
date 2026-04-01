# One-Stop Social Publisher

Compose once and publish across connected social platforms.

Current implementation baseline:
- Platforms: Instagram + Facebook (Meta)
- Modes: Draft compose + schedule + publish job pipeline (queue/dispatch/execute)
- Hosting posture: Supabase + Vercel
- TikTok: scaffolded for later phase
- Draft composer APIs enforce adapter capability validation and store per-target transformed payload + warnings

## Project Layout
- `app/api/*`: public API routes
- `app/internal/*`: worker-only publish endpoints
- `lib/adapters/*`: platform adapter contracts and implementations
- `lib/types.ts`: shared domain types
- `supabase/migrations/*`: schema and RLS policies
- `docs/*`: architecture, implementation phases, agent ownership

## Quick Start
1. Install dependencies:
   - `npm install`
2. Configure environment:
   - `cp .env.example .env.local`
   - populate Supabase + Meta + internal worker vars
   - set `TOKEN_ENCRYPTION_KEY` (32-byte key in hex or base64)
3. Run locally:
   - `npm run dev`
4. Validate quality gates:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run test:integration:db` (requires Supabase DB env vars)
   - `npm run test:e2e` (requires Playwright browser install via `npx playwright install chromium`)
5. Bootstrap storage bucket/policies:
   - follow [docs/storage-bootstrap.md](docs/storage-bootstrap.md)
6. Configure scheduled publish runner (optional but recommended):
   - follow [docs/publish-scheduler.md](docs/publish-scheduler.md)
7. Configure security hardening baseline:
   - follow [docs/security-hardening.md](docs/security-hardening.md)
8. Configure observability dashboards and alert thresholds:
   - follow [docs/observability-alerts.md](docs/observability-alerts.md)
9. Run pre-launch checklist automation:
   - `npm run check:prelaunch`
   - optional production-hardening pass: `npm run check:prelaunch:strict-alerts`
   - full operational hardening pass (real alert targets + completed drill evidence): `npm run check:prelaunch:strict-ops`
   - review [docs/incident-drill.md](docs/incident-drill.md)
10. Create an incident drill evidence file before each drill:
   - `npm run ops:drill:init -- --scenario dead-letter-spike --environment staging --commander "Your Name"`
   - validate completed drill evidence: `npm run ops:drill:validate`

## API Surface
- Auth
  - `POST /api/auth/signup`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/session`
- Workspace
  - `GET /api/workspace`
  - `POST /api/workspace`
  - `POST /api/workspace/select`
- Connections
  - `GET /api/connections`
  - `POST /api/connections/:platform/oauth/start`
  - `GET /api/connections/:platform/oauth/callback`
  - `DELETE /api/connections/:id`
- Media
  - `GET /api/media`
  - `POST /api/media/upload-url`
  - `POST /api/media/complete`
- Posts
  - `POST /api/posts`
  - `PATCH /api/posts/:id`
  - `POST /api/posts/:id/publish-now`
  - `POST /api/posts/:id/schedule`
  - `POST /api/posts/:id/cancel`
  - `POST /api/posts/:id/run-worker`
  - `POST /api/posts/:id/retry-failed`
  - `GET /api/posts/:id/status`
  - `GET /api/posts/:id/timeline`
  - `GET /api/posts?status=&platform=&dateRange=`
- Internal worker
  - `POST /internal/publish/dispatch`
  - `POST /internal/publish/execute/:jobId`

## Next Implementation Targets
1. Implement deeper adapter capability and media-policy constraints per platform.
2. Add production-grade observability wiring and alert routing verification in live environments.
3. Expand E2E coverage to include authenticated Meta OAuth callback persistence and full draft create/edit flows.
