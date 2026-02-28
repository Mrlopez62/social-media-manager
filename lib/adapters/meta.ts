import type {
  AdapterValidationResult,
  PlatformAdapter,
  PublishInput,
  PublishResult
} from "./base.ts";

const MAX_HASHTAGS = 30;

export class MetaAdapter implements PlatformAdapter {
  readonly platform: "instagram" | "facebook";

  constructor(platform: "instagram" | "facebook") {
    this.platform = platform;
  }

  validatePayload(input: PublishInput): AdapterValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!input.caption && input.mediaUrls.length === 0) {
      errors.push("Caption or media is required.");
    }

    if (input.hashtags.length > MAX_HASHTAGS) {
      warnings.push(`Meta currently supports up to ${MAX_HASHTAGS} hashtags reliably.`);
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors
    };
  }

  transformPayload(input: PublishInput): Record<string, unknown> {
    return {
      message: [input.caption, ...input.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`)]
        .filter(Boolean)
        .join("\n"),
      location: input.location ?? undefined,
      media_urls: input.mediaUrls,
      metadata: input.metadata ?? {}
    };
  }

  async publish(_connectionId: string, _input: PublishInput): Promise<PublishResult> {
    return {
      success: false,
      retryable: false,
      errorCode: "NOT_IMPLEMENTED",
      errorMessage: "Meta publish adapter is scaffolded but not implemented yet."
    };
  }

  async refreshToken(_connectionId: string) {
    return {
      success: false,
      error: "Meta token refresh not implemented in scaffold."
    };
  }

  mapError(error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown Meta adapter error.";
    return {
      code: "META_ERROR",
      message,
      retryable: false
    };
  }
}
