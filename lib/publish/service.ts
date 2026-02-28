import type { Platform } from "../types.ts";
import { getAdapter } from "../adapters/index.ts";
import type { PublishInput, PublishResult } from "../adapters/base.ts";

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
