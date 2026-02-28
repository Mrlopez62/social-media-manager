# One-Stop Social Publisher

Compose once and publish across connected social platforms.

Current implementation baseline:
- Platforms: Instagram + Facebook (Meta)
- Modes: Draft compose + schedule metadata + publish pipeline stubs
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
5. Bootstrap storage bucket/policies:
   - follow [docs/storage-bootstrap.md](docs/storage-bootstrap.md)

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
  - `GET /api/posts/:id/status`
  - `GET /api/posts?status=&platform=&dateRange=`
- Internal worker
  - `POST /internal/publish/dispatch`
  - `POST /internal/publish/execute/:jobId`

## Next Implementation Targets
1. Implement immediate/scheduled publish execution path in internal worker routes.
2. Add retry/idempotency mechanics for publish jobs.
3. Build composer and status UI in `app/` routes.
4. Extend capability matrix with deeper platform-specific media constraints and warnings.
