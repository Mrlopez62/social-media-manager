export type Platform = "instagram" | "facebook" | "tiktok";

export type PostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "partial_failed";

export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export type PublishJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";

export type User = {
  id: string;
  email: string;
  createdAt: string;
};

export type Workspace = {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
};

export type SocialConnection = {
  id: string;
  workspaceId: string;
  platform: Platform;
  accountId: string;
  expiresAt: string | null;
  scopes: string[];
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
};

export type PostRecord = {
  id: string;
  workspaceId: string;
  authorUserId: string;
  caption: string;
  hashtags: string[];
  location: string | null;
  status: PostStatus;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PostTarget = {
  id: string;
  postId: string;
  platform: Platform;
  connectionId: string;
  payloadJson: Record<string, unknown>;
  status: PostStatus;
  externalPostId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
};
