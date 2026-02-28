import type {
  AdapterValidationResult,
  PlatformAdapter,
  PublishInput,
  PublishResult
} from "./base.ts";

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;

  validatePayload(_input: PublishInput): AdapterValidationResult {
    return {
      valid: false,
      warnings: [],
      errors: ["TikTok connector is deferred until Phase 5."]
    };
  }

  transformPayload(_input: PublishInput): Record<string, unknown> {
    return {
      unsupported: true
    };
  }

  async publish(_connectionId: string, _input: PublishInput): Promise<PublishResult> {
    return {
      success: false,
      retryable: false,
      errorCode: "PHASE_5_CONNECTOR",
      errorMessage: "TikTok publish adapter is intentionally disabled for MVP."
    };
  }

  async refreshToken(_connectionId: string) {
    return {
      success: false,
      error: "TikTok connector unavailable in MVP."
    };
  }

  mapError(error: unknown) {
    return {
      code: "TIKTOK_ERROR",
      message: error instanceof Error ? error.message : "TikTok adapter unavailable.",
      retryable: false
    };
  }
}
