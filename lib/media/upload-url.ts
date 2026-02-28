import { randomUUID } from "crypto";
import { buildWorkspaceMediaPath } from "./storage.ts";

type SignedUploadData = {
  token: string;
  signedUrl: string;
  path: string;
};

type ServiceClientLike = {
  storage: {
    from: (bucket: string) => {
      createSignedUploadUrl: (
        path: string
      ) => Promise<{ data: SignedUploadData | null; error: { message: string } | null }>;
    };
  };
};

type UserClientLike = {
  from: (table: string) => {
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };
};

export type CreateMediaUploadUrlParams = {
  workspaceId: string;
  actorUserId: string;
  bucket: string;
  fileName: string;
  mimeType: string;
  size: number;
  userClient: unknown;
  serviceClient: unknown;
};

export class CreateMediaUploadUrlError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function createMediaUploadUrl(params: CreateMediaUploadUrlParams) {
  const assetId = randomUUID();
  const storagePath = buildWorkspaceMediaPath(params.workspaceId, assetId, params.fileName);

  const serviceClient = params.serviceClient as ServiceClientLike;
  const userClient = params.userClient as UserClientLike;

  const { data: signedUpload, error: signedUploadError } = await serviceClient.storage
    .from(params.bucket)
    .createSignedUploadUrl(storagePath);

  if (signedUploadError || !signedUpload) {
    throw new CreateMediaUploadUrlError(
      "MEDIA_UPLOAD_URL_FAILED",
      500,
      signedUploadError?.message ?? "Failed to create upload URL."
    );
  }

  const { error: auditError } = await userClient.from("audit_events").insert({
    workspace_id: params.workspaceId,
    actor_user_id: params.actorUserId,
    event_type: "media.upload_url.created",
    metadata_json: {
      assetId,
      storagePath,
      mimeType: params.mimeType,
      size: params.size
    }
  });

  if (auditError) {
    throw new CreateMediaUploadUrlError("AUDIT_WRITE_FAILED", 500, auditError.message);
  }

  return {
    assetId,
    bucket: params.bucket,
    storagePath,
    token: signedUpload.token,
    signedUrl: signedUpload.signedUrl,
    path: signedUpload.path
  };
}
