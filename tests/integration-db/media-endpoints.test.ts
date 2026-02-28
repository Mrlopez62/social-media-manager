import { randomUUID } from "crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { CompleteMediaUploadError, completeMediaAssetUpload } from "../../lib/media/complete-upload.ts";
import { getMediaBucketName } from "../../lib/media/storage.ts";
import { createMediaUploadUrl } from "../../lib/media/upload-url.ts";
import {
  createWorkspaceFixture,
  ensureMediaBucket,
  hasDbTestEnv,
  uploadFixtureStorageObject
} from "../helpers/db-fixtures.ts";

const dbTestSkip = hasDbTestEnv()
  ? false
  : "Missing DB test env. Set TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).";

test(
  "media upload-url creates workspace-scoped storage path and audit event",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createWorkspaceFixture();

    try {
      const bucket = getMediaBucketName();
      await ensureMediaBucket(fixture.client, bucket);

      const created = await createMediaUploadUrl({
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.userId,
        bucket,
        fileName: "hero image @ 2x!!.jpg",
        mimeType: "image/jpeg",
        size: 2048,
        userClient: fixture.client,
        serviceClient: fixture.client
      });

      assert.equal(created.bucket, bucket);
      assert.ok(created.assetId);
      assert.ok(created.token);
      assert.ok(created.signedUrl);
      assert.ok(created.path);
      assert.ok(created.storagePath.startsWith(`${fixture.workspaceId}/`));
      assert.match(created.storagePath, /^[-a-zA-Z0-9/_.]+$/);

      const { data: audits, error: auditsError } = await fixture.client
        .from("audit_events")
        .select("event_type, metadata_json")
        .eq("workspace_id", fixture.workspaceId)
        .eq("event_type", "media.upload_url.created");

      assert.equal(auditsError, null);
      assert.ok(audits && audits.length > 0);

      const matchingAudit = (audits ?? []).find(
        (audit) =>
          (audit.metadata_json as { storagePath?: string } | null)?.storagePath === created.storagePath
      );

      assert.ok(matchingAudit);
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  "media complete rejects storage path outside workspace scope",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createWorkspaceFixture();

    try {
      const bucket = getMediaBucketName();
      await ensureMediaBucket(fixture.client, bucket);

      await assert.rejects(
        () =>
          completeMediaAssetUpload({
            workspaceId: fixture.workspaceId,
            actorUserId: fixture.userId,
            bucket,
            storagePath: `another-workspace/${randomUUID()}/image.jpg`,
            mimeType: "image/jpeg",
            size: 12,
            checksum: "abc12345",
            userClient: fixture.client,
            serviceClient: fixture.client
          }),
        (error: unknown) => {
          assert.ok(error instanceof CompleteMediaUploadError);
          assert.equal(error.code, "MEDIA_PATH_FORBIDDEN");
          assert.equal(error.status, 403);
          return true;
        }
      );
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  "media complete rejects when storage object does not exist",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createWorkspaceFixture();

    try {
      const bucket = getMediaBucketName();
      await ensureMediaBucket(fixture.client, bucket);

      await assert.rejects(
        () =>
          completeMediaAssetUpload({
            workspaceId: fixture.workspaceId,
            actorUserId: fixture.userId,
            bucket,
            storagePath: `${fixture.workspaceId}/${randomUUID()}/missing.jpg`,
            mimeType: "image/jpeg",
            size: 12,
            checksum: "abc12345",
            userClient: fixture.client,
            serviceClient: fixture.client
          }),
        (error: unknown) => {
          assert.ok(error instanceof CompleteMediaUploadError);
          assert.equal(error.code, "MEDIA_OBJECT_NOT_FOUND");
          assert.equal(error.status, 400);
          return true;
        }
      );
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  "media complete inserts media_assets row for valid uploaded object",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createWorkspaceFixture();

    try {
      const bucket = getMediaBucketName();
      await ensureMediaBucket(fixture.client, bucket);

      const storagePath = `${fixture.workspaceId}/${randomUUID()}/clip.txt`;
      const size = await uploadFixtureStorageObject(fixture.client, {
        bucketName: bucket,
        storagePath,
        content: "phase2-media",
        mimeType: "text/plain"
      });

      const completed = await completeMediaAssetUpload({
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.userId,
        bucket,
        storagePath,
        mimeType: "text/plain",
        size,
        checksum: "checksum-phase2-0001",
        userClient: fixture.client,
        serviceClient: fixture.client
      });

      assert.ok(completed.mediaAsset.id);
      assert.equal(completed.mediaAsset.storagePath, storagePath);
      assert.equal(completed.mediaAsset.size, size);
      assert.equal(completed.mediaAsset.mimeType, "text/plain");

      const { data: savedAsset, error: savedAssetError } = await fixture.client
        .from("media_assets")
        .select("id, workspace_id, storage_path, mime_type, size, checksum")
        .eq("id", completed.mediaAsset.id)
        .maybeSingle();

      assert.equal(savedAssetError, null);
      assert.ok(savedAsset);
      assert.equal(savedAsset.workspace_id, fixture.workspaceId);
      assert.equal(savedAsset.storage_path, storagePath);
      assert.equal(savedAsset.size, size);
      assert.equal(savedAsset.checksum, "checksum-phase2-0001");
    } finally {
      await fixture.cleanup();
    }
  }
);
