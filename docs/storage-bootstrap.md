# Storage Bootstrap Checklist (Media Bucket + Policies)

Use this checklist for consistent environment setup across local, staging, and production.

## 1. Environment
- Ensure `SUPABASE_MEDIA_BUCKET` is set in app env (default: `media-assets`).
- Ensure `SUPABASE_SERVICE_ROLE_KEY` is available to API runtime for signed upload URL generation.

## 2. Migration
- Apply migrations, including media bucket/policy bootstrap:
  - `supabase/migrations/20260228141000_media_storage_bootstrap.sql`

What this migration does:
- Creates/updates `storage.buckets` entry for `media-assets`.
- Sets `file_size_limit` to `100 MB`.
- Enables object RLS and installs workspace-scoped `select/insert/update/delete` policies on `storage.objects`.

## 3. Verify Bucket
Run in Supabase SQL editor:

```sql
select id, name, public, file_size_limit
from storage.buckets
where id = 'media-assets';
```

Expected:
- One row for `media-assets`
- `public = false`

## 4. Verify Object Policies
Run in Supabase SQL editor:

```sql
select policyname, cmd
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and policyname like 'media_assets_%'
order by policyname;
```

Expected policies:
- `media_assets_read`
- `media_assets_insert`
- `media_assets_update`
- `media_assets_delete`

## 5. Runtime Smoke Test
1. Call `POST /api/media/upload-url` with a valid workspace session.
2. Upload bytes using returned `signedUrl`/`token`.
3. Call `POST /api/media/complete` with `storagePath`, `mimeType`, `size`, `checksum`.
4. Call `GET /api/media` and confirm new `media_assets` row appears.

## 6. CI/Testing Notes
- DB integration tests for callback/media persistence run via `npm run test:integration:db`.
- CI executes DB integration tests only when both secrets are set:
  - `TEST_SUPABASE_URL`
  - `TEST_SUPABASE_SERVICE_ROLE_KEY`

## 7. Custom Bucket Name (Optional)
If you need a bucket name other than `media-assets`:
- Update app env `SUPABASE_MEDIA_BUCKET`.
- Create a follow-up migration to mirror policies for the custom bucket id.
- Keep workspace folder naming as `<workspace_id>/<asset_id>/<filename>`.
