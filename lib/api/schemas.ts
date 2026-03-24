import { z } from "zod";

export const platformSchema = z.enum(["instagram", "facebook", "tiktok"]);
const MAX_HASHTAGS_PER_POST = 30;
const MAX_TARGET_CONNECTIONS_PER_POST = 10;
const MAX_MEDIA_ASSETS_PER_POST = 10;

function uniqueUuidArray(maxItems: number) {
  return z
    .array(z.string().uuid())
    .min(1)
    .max(maxItems)
    .superRefine((values, ctx) => {
      const deduped = new Set(values);
      if (deduped.size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate ids are not allowed."
        });
      }
    });
}

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
  hashtags: z.array(z.string().trim().min(1).max(100)).max(MAX_HASHTAGS_PER_POST).default([]),
  location: z.string().max(200).nullable().optional(),
  targetConnectionIds: uniqueUuidArray(MAX_TARGET_CONNECTIONS_PER_POST),
  mediaAssetIds: uniqueUuidArray(MAX_MEDIA_ASSETS_PER_POST),
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
  runAtBefore: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).optional()
});

export const executePublishJobSchema = z.object({
  lockToken: z.string().min(8).max(200).optional()
});

export const runPostWorkerSchema = z.object({
  includeFutureScheduled: z.boolean().optional(),
  limit: z.number().int().min(1).max(10).optional()
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
