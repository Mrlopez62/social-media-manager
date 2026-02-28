-- Phase 3: publish queue idempotency + dispatcher locking primitives

alter table public.publish_jobs
add column if not exists idempotency_key text;

create index if not exists idx_publish_jobs_post_status_run
  on public.publish_jobs(post_id, status, run_at);

create index if not exists idx_publish_jobs_idempotency_key
  on public.publish_jobs(idempotency_key);

create unique index if not exists idx_publish_jobs_active_post_unique
  on public.publish_jobs(post_id)
  where status in ('queued', 'running');

drop policy if exists scoped_write_publish_jobs on public.publish_jobs;
create policy scoped_write_publish_jobs
on public.publish_jobs
for all
using (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = publish_jobs.post_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  exists (
    select 1
    from public.posts p
    join public.workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = publish_jobs.post_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

create or replace function public.claim_publish_jobs(
  p_run_before timestamptz default now(),
  p_limit integer default 20,
  p_lock_token text default null,
  p_post_id uuid default null
)
returns table (
  id uuid,
  post_id uuid,
  run_at timestamptz,
  attempt integer,
  max_attempts integer,
  status public.publish_job_status,
  lock_token text,
  locked_at timestamptz,
  idempotency_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(coalesce(p_limit, 20), 1);
  v_lock_token text := coalesce(p_lock_token, gen_random_uuid()::text);
begin
  return query
  with candidate_jobs as (
    select pj.id
    from public.publish_jobs pj
    where pj.status = 'queued'
      and pj.run_at <= coalesce(p_run_before, now())
      and (p_post_id is null or pj.post_id = p_post_id)
    order by pj.run_at asc, pj.created_at asc
    limit v_limit
    for update skip locked
  ),
  claimed_jobs as (
    update public.publish_jobs pj
    set
      status = 'running',
      lock_token = v_lock_token,
      locked_at = now()
    from candidate_jobs cj
    where pj.id = cj.id
    returning
      pj.id,
      pj.post_id,
      pj.run_at,
      pj.attempt,
      pj.max_attempts,
      pj.status,
      pj.lock_token,
      pj.locked_at,
      pj.idempotency_key
  )
  select
    claimed_jobs.id,
    claimed_jobs.post_id,
    claimed_jobs.run_at,
    claimed_jobs.attempt,
    claimed_jobs.max_attempts,
    claimed_jobs.status,
    claimed_jobs.lock_token,
    claimed_jobs.locked_at,
    claimed_jobs.idempotency_key
  from claimed_jobs;
end;
$$;

revoke all on function public.claim_publish_jobs(timestamptz, integer, text, uuid) from public;
grant execute on function public.claim_publish_jobs(timestamptz, integer, text, uuid) to service_role;
