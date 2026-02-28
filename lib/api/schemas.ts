import { z } from "zod";

export const platformSchema = z.enum(["instagram", "facebook", "tiktok"]);

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  workspaceName: z.string().min(1).max(80).optional()
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export const createPostSchema = z.object({
  caption: z.string().max(2200),
  hashtags: z.array(z.string().min(1).max(100)).default([]),
  location: z.string().max(200).nullable().optional(),
  targetConnectionIds: z.array(z.string().uuid()).min(1),
  mediaAssetIds: z.array(z.string().uuid()).min(1),
  scheduledFor: z.string().datetime().nullable().optional()
});

export const patchPostSchema = createPostSchema.partial().extend({
  status: z.enum(["draft", "scheduled"]).optional()
});

export const schedulePostSchema = z.object({
  scheduledFor: z.string().datetime()
});

export const publishDispatchSchema = z.object({
  postId: z.string().uuid().optional(),
  runAtBefore: z.string().datetime().optional()
});

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80)
});

export const selectWorkspaceSchema = z.object({
  workspaceId: z.string().uuid()
});

export const createMediaUploadUrlSchema = z.object({
  fileName: z.string().min(1).max(180),
  mimeType: z.string().min(3).max(120),
  size: z.number().int().min(1).max(1024 * 1024 * 100)
});

export const completeMediaUploadSchema = z.object({
  storagePath: z.string().min(5).max(400),
  mimeType: z.string().min(3).max(120),
  size: z.number().int().min(1).max(1024 * 1024 * 100),
  checksum: z.string().min(8).max(200)
});
