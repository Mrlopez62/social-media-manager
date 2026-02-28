import type { Platform } from "../types.ts";

export type AdapterValidationResult = {
  valid: boolean;
  warnings: string[];
  errors: string[];
};

export type PublishInput = {
  caption: string;
  hashtags: string[];
  location?: string | null;
  mediaUrls: string[];
  metadata?: Record<string, unknown>;
};

export type PublishResult = {
  success: boolean;
  externalPostId?: string;
  retryable: boolean;
  errorCode?: string;
  errorMessage?: string;
  raw?: unknown;
};

export interface PlatformAdapter {
  readonly platform: Platform;
  validatePayload(input: PublishInput): AdapterValidationResult;
  transformPayload(input: PublishInput): Record<string, unknown>;
  publish(connectionId: string, input: PublishInput): Promise<PublishResult>;
  refreshToken(connectionId: string): Promise<{ success: boolean; expiresAt?: string; error?: string }>;
  mapError(error: unknown): { code: string; message: string; retryable: boolean };
}
