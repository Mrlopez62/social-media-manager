import type {
  AdapterValidationResult,
  PlatformAdapter,
  PublishInput,
  PublishResult
} from "./base.ts";

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;

  validatePayload(input: PublishInput): AdapterValidationResult {
    void input;
    return {
      valid: false,
      warnings: [],
      errors: ["TikTok connector is deferred until Phase 5."]
    };
  }

  transformPayload(input: PublishInput): Record<string, unknown> {
    void input;
    return {
      unsupported: true
    };
  }

  async publish(connectionId: string, input: PublishInput): Promise<PublishResult> {
    void connectionId;
    void input;
    return {
      success: false,
      retryable: false,
      errorCode: "PHASE_5_CONNECTOR",
      errorMessage: "TikTok publish adapter is intentionally disabled for MVP."
    };
  }

  async refreshToken(connectionId: string) {
    void connectionId;
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
