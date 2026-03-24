-- Phase 4: security hardening baseline (API rate limits)

create table if not exists public.api_rate_limits (
  scope text not null,
  subject text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, subject, window_started_at)
);

create index if not exists idx_api_rate_limits_updated_at
  on public.api_rate_limits(updated_at desc);

drop trigger if exists set_updated_at_api_rate_limits on public.api_rate_limits;
create trigger set_updated_at_api_rate_limits
before update on public.api_rate_limits
for each row execute function public.set_updated_at();

alter table public.api_rate_limits enable row level security;

create or replace function public.consume_api_rate_limit(
  p_scope text,
  p_subject text,
  p_window_seconds integer default 60,
  p_limit integer default 10
)
returns table (
  allowed boolean,
  remaining integer,
  reset_at timestamptz,
  count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_window_seconds integer := greatest(coalesce(p_window_seconds, 60), 1);
  v_limit integer := greatest(coalesce(p_limit, 10), 1);
  v_window_start timestamptz;
  v_count integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
  )::timestamptz;

  insert into public.api_rate_limits (scope, subject, window_started_at, request_count)
  values (p_scope, p_subject, v_window_start, 1)
  on conflict (scope, subject, window_started_at)
  do update
    set request_count = public.api_rate_limits.request_count + 1,
        updated_at = now()
  returning request_count into v_count;

  return query
  select
    v_count <= v_limit,
    greatest(v_limit - v_count, 0),
    v_window_start + make_interval(secs => v_window_seconds),
    v_count;
end;
$$;

revoke all on table public.api_rate_limits from public;
revoke all on table public.api_rate_limits from anon;
revoke all on table public.api_rate_limits from authenticated;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;
