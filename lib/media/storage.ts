const DEFAULT_MEDIA_BUCKET = "media-assets";

export function getMediaBucketName() {
  return process.env.SUPABASE_MEDIA_BUCKET ?? DEFAULT_MEDIA_BUCKET;
}

export function sanitizeFileName(fileName: string) {
  const noPathSeparators = fileName.replace(/[\\/]+/g, "-");
  const collapsed = noPathSeparators.replace(/\s+/g, "-");
  const safeChars = collapsed.replace(/[^a-zA-Z0-9._-]/g, "");

  return safeChars.length > 0 ? safeChars.slice(0, 180) : "upload.bin";
}

export function buildWorkspaceMediaPath(workspaceId: string, assetId: string, fileName: string) {
  return `${workspaceId}/${assetId}/${sanitizeFileName(fileName)}`;
}

export function isWorkspaceMediaPath(workspaceId: string, storagePath: string) {
  return storagePath.startsWith(`${workspaceId}/`);
}

export function splitStoragePath(storagePath: string) {
  const normalized = storagePath.replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length < 3) {
    return null;
  }

  const fileName = segments[segments.length - 1];
  const folder = segments.slice(0, -1).join("/");

  return {
    folder,
    fileName
  };
}
