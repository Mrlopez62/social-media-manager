import type { Platform } from "../types.ts";
import { getAdapter } from "../adapters/index.ts";
import type { PublishInput, PublishResult } from "../adapters/base.ts";

export type PublishFailureCategory = "validation" | "provider" | "configuration" | "internal";

export type PublishFailure = {
  code: string;
  message: string;
  userMessage: string;
  retryable: boolean;
  category: PublishFailureCategory;
};

export type PostDeliveryAggregate = "scheduled" | "publishing" | "published" | "failed" | "partial_failed";

export async function publishToTarget(
  platform: Platform,
  connectionId: string,
  input: PublishInput
): Promise<PublishResult> {
  const adapter = getAdapter(platform);
  const validation = adapter.validatePayload(input);

  if (!validation.valid) {
    return {
      success: false,
      retryable: false,
      errorCode: "PAYLOAD_INVALID",
      errorMessage: validation.errors.join("; ")
    };
  }

  return adapter.publish(connectionId, input);
}

function getFailureCategory(code: string): PublishFailureCategory {
  if (code === "PAYLOAD_INVALID") {
    return "validation";
  }

  if (
    code === "NOT_IMPLEMENTED" ||
    code === "PHASE_5_CONNECTOR" ||
    code === "PHASE_2_CONNECTOR"
  ) {
    return "configuration";
  }

  if (code.startsWith("META_") || code.startsWith("TIKTOK_")) {
    return "provider";
  }

  return "internal";
}

function getUserSafeFailureMessage(code: string) {
  if (code === "PAYLOAD_INVALID") {
    return "This post payload is not valid for the selected platform.";
  }

  if (
    code === "NOT_IMPLEMENTED" ||
    code === "PHASE_5_CONNECTOR" ||
    code === "PHASE_2_CONNECTOR"
  ) {
    return "Publishing is not enabled for this platform yet.";
  }

  if (code.startsWith("META_") || code.startsWith("TIKTOK_")) {
    return "The platform rejected this publish attempt.";
  }

  return "The publish attempt failed unexpectedly.";
}

export function categorizePublishFailure(result: PublishResult): PublishFailure {
  const code = result.errorCode ?? "PUBLISH_FAILED";
  const message = result.errorMessage ?? "Publish operation failed.";

  return {
    code,
    message,
    userMessage: getUserSafeFailureMessage(code),
    retryable: result.retryable,
    category: getFailureCategory(code)
  };
}

export function aggregatePostDeliveryStatus(targetStatuses: string[]): PostDeliveryAggregate {
  if (targetStatuses.length === 0) {
    return "failed";
  }

  const publishedCount = targetStatuses.filter((status) => status === "published").length;
  const failedCount = targetStatuses.filter((status) => status === "failed").length;
  const publishingCount = targetStatuses.filter((status) => status === "publishing").length;

  if (publishedCount === targetStatuses.length) {
    return "published";
  }

  if (publishedCount > 0 && failedCount > 0) {
    return "partial_failed";
  }

  if (publishedCount > 0) {
    return "partial_failed";
  }

  if (failedCount === targetStatuses.length) {
    return "failed";
  }

  if (publishingCount > 0) {
    return "publishing";
  }

  return "scheduled";
}

export function getRetryDelaySeconds(attempt: number) {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(30 * 2 ** (boundedAttempt - 1), 15 * 60);
}
