-- Phase 2: OAuth state tracking for Meta connection flow

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null references public.users(id) on delete cascade,
  platform public.platform not null,
  state text not null unique,
  redirect_uri text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_states_state_expires
  on public.oauth_states(state, expires_at);

create index if not exists idx_oauth_states_workspace_created
  on public.oauth_states(workspace_id, created_at desc);

alter table public.oauth_states enable row level security;

create policy scoped_select_oauth_states
on public.oauth_states
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = oauth_states.workspace_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_insert_oauth_states
on public.oauth_states
for insert
with check (
  actor_user_id = auth.uid()
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = oauth_states.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create policy scoped_update_oauth_states
on public.oauth_states
for update
using (
  actor_user_id = auth.uid()
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = oauth_states.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  actor_user_id = auth.uid()
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = oauth_states.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);
