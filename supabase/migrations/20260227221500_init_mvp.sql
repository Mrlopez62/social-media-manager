-- Core schema for One-Stop Social Publisher MVP

create extension if not exists pgcrypto;

create type public.workspace_role as enum ('owner', 'admin', 'editor', 'viewer');
create type public.platform as enum ('instagram', 'facebook', 'tiktok');
create type public.connection_status as enum ('active', 'expired', 'revoked', 'error');
create type public.post_status as enum ('draft', 'scheduled', 'publishing', 'published', 'failed', 'partial_failed');
create type public.publish_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead_letter');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.social_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform public.platform not null,
  account_id text not null,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  status public.connection_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform, account_id)
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  size bigint not null check (size > 0),
  checksum text not null,
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  author_user_id uuid not null references public.users(id) on delete restrict,
  caption text not null default '',
  hashtags text[] not null default '{}',
  location text,
  status public.post_status not null default 'draft',
  scheduled_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  platform public.platform not null,
  connection_id uuid not null references public.social_connections(id) on delete restrict,
  payload_json jsonb not null default '{}'::jsonb,
  status public.post_status not null default 'draft',
  external_post_id text,
  error_code text,
  error_message text,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  run_at timestamptz not null,
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  status public.publish_job_status not null default 'queued',
  lock_token text,
  locked_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
  event_type text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_workspace_members_user on public.workspace_members(user_id);
create index idx_social_connections_workspace on public.social_connections(workspace_id, platform, status);
create index idx_media_assets_workspace on public.media_assets(workspace_id, created_at desc);
create index idx_posts_workspace on public.posts(workspace_id, status, scheduled_for);
create index idx_post_targets_post on public.post_targets(post_id, platform, status);
create index idx_publish_jobs_run_at on public.publish_jobs(status, run_at);
create index idx_audit_events_workspace on public.audit_events(workspace_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at_social_connections
before update on public.social_connections
for each row execute function public.set_updated_at();

create trigger set_updated_at_posts
before update on public.posts
for each row execute function public.set_updated_at();

create trigger set_updated_at_post_targets
before update on public.post_targets
for each row execute function public.set_updated_at();

create trigger set_updated_at_publish_jobs
before update on public.publish_jobs
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, coalesce(new.email, ''));
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.create_workspace_with_owner(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  insert into public.workspaces (name, owner_user_id)
  values (workspace_name, auth.uid())
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, auth.uid(), 'owner');

  return new_workspace_id;
end;
$$;

revoke all on function public.create_workspace_with_owner(text) from public;
grant execute on function public.create_workspace_with_owner(text) to authenticated;

alter table public.users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.social_connections enable row level security;
alter table public.media_assets enable row level security;
alter table public.posts enable row level security;
alter table public.post_targets enable row level security;
alter table public.publish_jobs enable row level security;
alter table public.audit_events enable row level security;

create policy users_read_self
on public.users
for select
using (auth.uid() = id);

create policy users_update_self
on public.users
for update
using (auth.uid() = id)
with check (auth.uid() = id);

create policy workspace_membership_read
on public.workspace_members
for select
using (user_id = auth.uid());

create policy workspace_membership_insert_owner_admin
on public.workspace_members
for insert
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  )
);

create policy workspace_membership_update_owner_admin
on public.workspace_members
for update
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspace_members.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  )
);

create policy workspaces_select_member
on public.workspaces
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspaces.id
      and wm.user_id = auth.uid()
  )
);

create policy workspaces_update_owner_admin
on public.workspaces
for update
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspaces.id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = workspaces.id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  )
);

create policy scoped_select_social_connections
on public.social_connections
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = social_connections.workspace_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_write_social_connections
on public.social_connections
for all
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = social_connections.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = social_connections.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create policy scoped_select_media_assets
on public.media_assets
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = media_assets.workspace_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_write_media_assets
on public.media_assets
for all
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = media_assets.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = media_assets.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create policy scoped_select_posts
on public.posts
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = posts.workspace_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_write_posts
on public.posts
for all
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = posts.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = posts.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create policy scoped_select_post_targets
on public.post_targets
for select
using (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = post_targets.post_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_write_post_targets
on public.post_targets
for all
using (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = post_targets.post_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = post_targets.post_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create policy scoped_select_publish_jobs
on public.publish_jobs
for select
using (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = publish_jobs.post_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_select_audit_events
on public.audit_events
for select
using (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = audit_events.workspace_id
      and wm.user_id = auth.uid()
  )
);

create policy scoped_insert_audit_events
on public.audit_events
for insert
with check (
  exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = audit_events.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);
