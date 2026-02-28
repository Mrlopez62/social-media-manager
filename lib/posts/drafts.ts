import { getSupabaseUserClient } from "@/lib/supabase";
import type { Platform } from "@/lib/types";
import {
  buildTargetPayloadsForConnections,
  DraftCapabilityValidationError
} from "@/lib/posts/capabilities";

type UserClient = ReturnType<typeof getSupabaseUserClient>;
type DraftLifecycleStatus = "draft" | "scheduled";

type ConnectionRow = {
  id: string;
  platform: Platform;
  status: string;
};

type MediaAssetRow = {
  id: string;
  storage_path: string;
};

type PostRow = {
  id: string;
  workspace_id: string;
  author_user_id: string;
  caption: string;
  hashtags: string[];
  location: string | null;
  status: string;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
};

type PostTargetRow = {
  id: string;
  connection_id: string;
  platform: Platform;
  payload_json: Record<string, unknown>;
};

export class DraftServiceError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type DraftCreateInput = {
  caption: string;
  hashtags?: string[];
  location?: string | null;
  targetConnectionIds: string[];
  mediaAssetIds: string[];
  scheduledFor?: string | null;
};

export type DraftPatchInput = {
  caption?: string;
  hashtags?: string[];
  location?: string | null;
  targetConnectionIds?: string[];
  mediaAssetIds?: string[];
  scheduledFor?: string | null;
  status?: DraftLifecycleStatus;
};

function dedupeIds(ids: string[]) {
  return [...new Set(ids)];
}

function normalizeHashtags(hashtags: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of hashtags) {
    const cleaned = raw.replace(/^#+/, "").trim();

    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(cleaned);
  }

  return normalized;
}

async function ensureConnectionsForWorkspace(
  userClient: UserClient,
  workspaceId: string,
  connectionIds: string[]
) {
  const uniqueIds = dedupeIds(connectionIds);

  if (uniqueIds.length === 0) {
    throw new DraftServiceError("CONNECTIONS_REQUIRED", 400, "At least one target connection is required.");
  }

  const { data, error } = await userClient
    .from("social_connections")
    .select("id, platform, status")
    .eq("workspace_id", workspaceId)
    .in("id", uniqueIds);

  if (error) {
    throw new DraftServiceError("CONNECTION_READ_FAILED", 500, error.message);
  }

  const rows = (data ?? []) as ConnectionRow[];

  if (rows.length !== uniqueIds.length) {
    throw new DraftServiceError(
      "CONNECTION_NOT_FOUND",
      400,
      "One or more selected connections are missing or inaccessible."
    );
  }

  const inactive = rows.filter((row) => row.status !== "active");
  if (inactive.length > 0) {
    throw new DraftServiceError(
      "CONNECTION_INACTIVE",
      400,
      "All target connections must be active before publishing."
    );
  }

  return rows;
}

async function ensureMediaAssetsForWorkspace(
  userClient: UserClient,
  workspaceId: string,
  mediaAssetIds: string[]
) {
  const uniqueIds = dedupeIds(mediaAssetIds);

  if (uniqueIds.length === 0) {
    throw new DraftServiceError("MEDIA_REQUIRED", 400, "At least one media asset is required.");
  }

  const { data, error } = await userClient
    .from("media_assets")
    .select("id, storage_path")
    .eq("workspace_id", workspaceId)
    .in("id", uniqueIds);

  if (error) {
    throw new DraftServiceError("MEDIA_READ_FAILED", 500, error.message);
  }

  const rows = (data ?? []) as MediaAssetRow[];

  if (rows.length !== uniqueIds.length) {
    throw new DraftServiceError(
      "MEDIA_NOT_FOUND",
      400,
      "One or more media assets are missing or inaccessible."
    );
  }

  return rows;
}

function resolveDraftStatus(
  scheduledFor: string | null | undefined,
  explicitStatus?: DraftLifecycleStatus
): DraftLifecycleStatus {
  if (explicitStatus) {
    return explicitStatus;
  }

  return scheduledFor ? "scheduled" : "draft";
}

function readMediaAssetIdsFromTargets(targets: PostTargetRow[]) {
  for (const target of targets) {
    const mediaAssetIds = target.payload_json?.mediaAssetIds;

    if (Array.isArray(mediaAssetIds)) {
      const normalized = mediaAssetIds.filter((item): item is string => typeof item === "string");
      if (normalized.length > 0) {
        return dedupeIds(normalized);
      }
    }
  }

  return [];
}

async function insertAuditEvent(
  userClient: UserClient,
  workspaceId: string,
  actorUserId: string,
  eventType: string,
  metadata: Record<string, unknown>
) {
  await userClient.from("audit_events").insert({
    workspace_id: workspaceId,
    actor_user_id: actorUserId,
    event_type: eventType,
    metadata_json: metadata
  });
}

export async function createDraftPost(
  userClient: UserClient,
  params: {
    workspaceId: string;
    actorUserId: string;
    input: DraftCreateInput;
  }
) {
  const normalizedHashtags = normalizeHashtags(params.input.hashtags ?? []);
  const mediaAssets = await ensureMediaAssetsForWorkspace(
    userClient,
    params.workspaceId,
    params.input.mediaAssetIds
  );
  const mediaAssetIds = mediaAssets.map((asset) => asset.id);
  const mediaStoragePaths = mediaAssets.map((asset) => asset.storage_path);
  const connections = await ensureConnectionsForWorkspace(
    userClient,
    params.workspaceId,
    params.input.targetConnectionIds
  );

  const status = resolveDraftStatus(params.input.scheduledFor);
  let targetsWithCapabilities: ReturnType<typeof buildTargetPayloadsForConnections>;
  try {
    targetsWithCapabilities = buildTargetPayloadsForConnections({
      connections,
      canonical: {
        caption: params.input.caption,
        hashtags: normalizedHashtags,
        location: params.input.location ?? null,
        mediaAssetIds,
        mediaStoragePaths
      }
    });
  } catch (error) {
    if (error instanceof DraftCapabilityValidationError) {
      throw new DraftServiceError("PAYLOAD_INVALID", 400, error.message);
    }

    throw error;
  }

  const { data: post, error: postError } = await userClient
    .from("posts")
    .insert({
      workspace_id: params.workspaceId,
      author_user_id: params.actorUserId,
      caption: params.input.caption,
      hashtags: normalizedHashtags,
      location: params.input.location ?? null,
      status,
      scheduled_for: params.input.scheduledFor ?? null
    })
    .select("id, workspace_id, author_user_id, caption, hashtags, location, status, scheduled_for, created_at, updated_at")
    .single();

  if (postError || !post) {
    throw new DraftServiceError("POST_CREATE_FAILED", 500, postError?.message ?? "Failed to create draft post.");
  }

  const targetsToInsert = connections.map((connection) => ({
    post_id: post.id,
    platform: connection.platform,
    connection_id: connection.id,
    payload_json: targetsWithCapabilities.payloadByConnectionId.get(connection.id) ?? {},
    status
  }));

  const { data: insertedTargets, error: targetError } = await userClient
    .from("post_targets")
    .insert(targetsToInsert)
    .select("id, connection_id, platform, payload_json");

  if (targetError) {
    throw new DraftServiceError("POST_TARGET_CREATE_FAILED", 500, targetError.message);
  }

  await insertAuditEvent(userClient, params.workspaceId, params.actorUserId, "post.draft.created", {
    postId: post.id,
    targetCount: (insertedTargets ?? []).length
  });

  return {
    post: post as PostRow,
    targets: (insertedTargets ?? []) as PostTargetRow[],
    warnings: targetsWithCapabilities.warnings
  };
}

export async function updateDraftPost(
  userClient: UserClient,
  params: {
    postId: string;
    workspaceId: string;
    actorUserId: string;
    patch: DraftPatchInput;
  }
) {
  const { data: existingPost, error: existingPostError } = await userClient
    .from("posts")
    .select("id, workspace_id, author_user_id, caption, hashtags, location, status, scheduled_for, created_at, updated_at")
    .eq("id", params.postId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();

  if (existingPostError) {
    throw new DraftServiceError("POST_READ_FAILED", 500, existingPostError.message);
  }

  if (!existingPost) {
    throw new DraftServiceError("POST_NOT_FOUND", 404, "Post not found.");
  }

  if (!["draft", "scheduled"].includes(existingPost.status)) {
    throw new DraftServiceError("POST_EDIT_FORBIDDEN", 409, "Only draft or scheduled posts can be edited.");
  }

  const { data: existingTargets, error: existingTargetsError } = await userClient
    .from("post_targets")
    .select("id, connection_id, platform, payload_json")
    .eq("post_id", params.postId);

  if (existingTargetsError) {
    throw new DraftServiceError("POST_TARGET_READ_FAILED", 500, existingTargetsError.message);
  }

  const existingTargetRows = (existingTargets ?? []) as PostTargetRow[];
  const fallbackConnectionIds = existingTargetRows.map((target) => target.connection_id);

  const nextConnectionIds = params.patch.targetConnectionIds
    ? dedupeIds(params.patch.targetConnectionIds)
    : dedupeIds(fallbackConnectionIds);

  const derivedMediaAssetIds = readMediaAssetIdsFromTargets(existingTargetRows);
  const nextMediaAssetIds = params.patch.mediaAssetIds
    ? dedupeIds(params.patch.mediaAssetIds)
    : derivedMediaAssetIds;

  const validatedConnections = await ensureConnectionsForWorkspace(
    userClient,
    params.workspaceId,
    nextConnectionIds
  );

  const validatedMediaAssets = await ensureMediaAssetsForWorkspace(
    userClient,
    params.workspaceId,
    nextMediaAssetIds
  );
  const validatedMediaAssetIds = validatedMediaAssets.map((asset) => asset.id);
  const validatedMediaStoragePaths = validatedMediaAssets.map((asset) => asset.storage_path);

  const nextCaption = params.patch.caption ?? existingPost.caption;
  const nextHashtags = params.patch.hashtags
    ? normalizeHashtags(params.patch.hashtags)
    : (existingPost.hashtags ?? []);
  const nextLocation =
    params.patch.location !== undefined ? params.patch.location : existingPost.location;
  const nextScheduledFor =
    params.patch.scheduledFor !== undefined ? params.patch.scheduledFor : existingPost.scheduled_for;
  const nextStatus = resolveDraftStatus(nextScheduledFor, params.patch.status);

  const { data: updatedPost, error: updatePostError } = await userClient
    .from("posts")
    .update({
      caption: nextCaption,
      hashtags: nextHashtags,
      location: nextLocation,
      scheduled_for: nextScheduledFor,
      status: nextStatus
    })
    .eq("id", params.postId)
    .eq("workspace_id", params.workspaceId)
    .select("id, workspace_id, author_user_id, caption, hashtags, location, status, scheduled_for, created_at, updated_at")
    .single();

  if (updatePostError || !updatedPost) {
    throw new DraftServiceError(
      "POST_UPDATE_FAILED",
      500,
      updatePostError?.message ?? "Failed to update draft post."
    );
  }

  const { error: deleteTargetsError } = await userClient
    .from("post_targets")
    .delete()
    .eq("post_id", params.postId);

  if (deleteTargetsError) {
    throw new DraftServiceError("POST_TARGET_UPDATE_FAILED", 500, deleteTargetsError.message);
  }

  let targetsWithCapabilities: ReturnType<typeof buildTargetPayloadsForConnections>;
  try {
    targetsWithCapabilities = buildTargetPayloadsForConnections({
      connections: validatedConnections,
      canonical: {
        caption: nextCaption,
        hashtags: nextHashtags,
        location: nextLocation,
        mediaAssetIds: validatedMediaAssetIds,
        mediaStoragePaths: validatedMediaStoragePaths
      }
    });
  } catch (error) {
    if (error instanceof DraftCapabilityValidationError) {
      throw new DraftServiceError("PAYLOAD_INVALID", 400, error.message);
    }

    throw error;
  }

  const { data: updatedTargets, error: insertTargetsError } = await userClient
    .from("post_targets")
    .insert(
      validatedConnections.map((connection) => ({
        post_id: params.postId,
        platform: connection.platform,
        connection_id: connection.id,
        payload_json: targetsWithCapabilities.payloadByConnectionId.get(connection.id) ?? {},
        status: nextStatus
      }))
    )
    .select("id, connection_id, platform, payload_json");

  if (insertTargetsError) {
    throw new DraftServiceError("POST_TARGET_UPDATE_FAILED", 500, insertTargetsError.message);
  }

  await insertAuditEvent(userClient, params.workspaceId, params.actorUserId, "post.draft.updated", {
    postId: params.postId,
    targetCount: (updatedTargets ?? []).length
  });

  return {
    post: updatedPost as PostRow,
    targets: (updatedTargets ?? []) as PostTargetRow[],
    warnings: targetsWithCapabilities.warnings
  };
}
