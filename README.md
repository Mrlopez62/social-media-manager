# One-Stop Social Publisher

Compose once and publish across connected social platforms.

Current scaffold aligns to MVP scope:
- Platforms: Instagram + Facebook (Meta)
- Modes: Publish now + schedule
- Hosting posture: Supabase + Vercel
- TikTok: scaffolded for Phase 2

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
3. Run locally:
   - `npm run dev`
4. Validate quality gates:
   - `npm run lint`
   - `npm run typecheck`

## API Surface (Scaffolded)
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
1. Implement Meta OAuth token exchange + encrypted persistence.
2. Implement queue lock + retry logic in internal publish endpoints.
3. Replace post/connection stub handlers with real DB-backed logic.
4. Build composer and status UI in `app/` routes.
