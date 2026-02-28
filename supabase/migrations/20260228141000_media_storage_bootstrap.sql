-- Phase 2: Storage bucket + object policies for media uploads

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'media-assets',
  'media-assets',
  false,
  104857600,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'text/plain'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table storage.objects enable row level security;

drop policy if exists media_assets_read on storage.objects;
create policy media_assets_read
on storage.objects
for select
using (
  bucket_id = 'media-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = auth.uid()
  )
);

drop policy if exists media_assets_insert on storage.objects;
create policy media_assets_insert
on storage.objects
for insert
with check (
  bucket_id = 'media-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

drop policy if exists media_assets_update on storage.objects;
create policy media_assets_update
on storage.objects
for update
using (
  bucket_id = 'media-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
)
with check (
  bucket_id = 'media-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);

drop policy if exists media_assets_delete on storage.objects;
create policy media_assets_delete
on storage.objects
for delete
using (
  bucket_id = 'media-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'editor')
  )
);
