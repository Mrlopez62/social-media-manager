import { isWorkspaceMediaPath, splitStoragePath } from "./storage.ts";

type StorageListObject = {
  name: string;
  metadata?: {
    size?: number;
    mimetype?: string;
  };
};

type ServiceClientLike = {
  storage: {
    from: (bucket: string) => {
      list: (
        folder: string,
        options?: { limit?: number; offset?: number }
      ) => Promise<{ data: StorageListObject[] | null; error: { message: string } | null }>;
    };
  };
};

type UserClientLike = {
  from: (table: string) => unknown;
};

type MediaAssetRow = {
  id: string;
  storage_path: string;
  mime_type: string;
  size: number;
  checksum: string;
  created_at: string;
};

export class CompleteMediaUploadError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type CompleteMediaUploadParams = {
  workspaceId: string;
  actorUserId: string;
  bucket: string;
  storagePath: string;
  mimeType: string;
  size: number;
  checksum: string;
  userClient: unknown;
  serviceClient: unknown;
};

async function ensureStorageObjectExists(
  serviceClient: ServiceClientLike,
  bucket: string,
  storagePath: string
) {
  const split = splitStoragePath(storagePath);

  if (!split) {
    throw new CompleteMediaUploadError("MEDIA_PATH_INVALID", 400, "Invalid storage path format.");
  }

  const { data: files, error } = await serviceClient.storage
    .from(bucket)
    .list(split.folder, { limit: 100, offset: 0 });

  if (error) {
    throw new CompleteMediaUploadError("MEDIA_STORAGE_CHECK_FAILED", 500, error.message);
  }

  const file = (files ?? []).find((candidate) => candidate.name === split.fileName);

  if (!file) {
    throw new CompleteMediaUploadError(
      "MEDIA_OBJECT_NOT_FOUND",
      400,
      "Uploaded object not found in storage."
    );
  }

  return file;
}

export async function completeMediaAssetUpload(params: CompleteMediaUploadParams) {
  if (!isWorkspaceMediaPath(params.workspaceId, params.storagePath)) {
    throw new CompleteMediaUploadError(
      "MEDIA_PATH_FORBIDDEN",
      403,
      "Storage path must be scoped to the current workspace."
    );
  }

  const serviceClient = params.serviceClient as ServiceClientLike;
  const userClient = params.userClient as UserClientLike;

  const file = await ensureStorageObjectExists(serviceClient, params.bucket, params.storagePath);

  const objectSize = file.metadata?.size;
  if (typeof objectSize === "number" && objectSize !== params.size) {
    throw new CompleteMediaUploadError(
      "MEDIA_SIZE_MISMATCH",
      400,
      "Uploaded file size does not match request payload."
    );
  }

  const mediaAssetsTable = userClient.from("media_assets") as {
    insert: (values: unknown) => {
      select: (columns: string) => {
        single: () => Promise<{ data: MediaAssetRow | null; error: { message: string } | null }>;
      };
    };
  };

  const { data: mediaAsset, error: insertError } = await mediaAssetsTable
    .insert({
      workspace_id: params.workspaceId,
      storage_path: params.storagePath,
      mime_type: params.mimeType,
      size: params.size,
      checksum: params.checksum
    })
    .select("id, storage_path, mime_type, size, checksum, created_at")
    .single();

  if (insertError || !mediaAsset) {
    throw new CompleteMediaUploadError(
      "MEDIA_PERSIST_FAILED",
      500,
      insertError?.message ?? "Failed to persist media asset."
    );
  }

  const auditTable = userClient.from("audit_events") as {
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };

  const { error: auditError } = await auditTable.insert({
    workspace_id: params.workspaceId,
    actor_user_id: params.actorUserId,
    event_type: "media.upload.completed",
    metadata_json: {
      mediaAssetId: mediaAsset.id,
      storagePath: mediaAsset.storage_path,
      size: mediaAsset.size
    }
  });

  if (auditError) {
    throw new CompleteMediaUploadError("AUDIT_WRITE_FAILED", 500, auditError.message);
  }

  return {
    mediaAsset: {
      id: mediaAsset.id,
      storagePath: mediaAsset.storage_path,
      mimeType: mediaAsset.mime_type,
      size: mediaAsset.size,
      checksum: mediaAsset.checksum,
      createdAt: mediaAsset.created_at
    }
  };
}
