import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePostDeliveryStatus,
  categorizePublishFailure,
  getRetryDelaySeconds,
  publishToTarget
} from "../../lib/publish/service.ts";

test("publishToTarget returns payload-invalid for unsupported connector payloads", async () => {
  const result = await publishToTarget("tiktok", "connection-1", {
    caption: "Phase 3",
    hashtags: ["launch"],
    location: null,
    mediaUrls: ["workspace/asset/video.mp4"]
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "PAYLOAD_INVALID");
  assert.equal(result.retryable, false);
});

test("categorizePublishFailure maps configuration-level errors to user-safe messages", () => {
  const categorized = categorizePublishFailure({
    success: false,
    retryable: false,
    errorCode: "NOT_IMPLEMENTED",
    errorMessage: "Adapter not implemented"
  });

  assert.equal(categorized.category, "configuration");
  assert.equal(categorized.userMessage, "Publishing is not enabled for this platform yet.");
  assert.equal(categorized.retryable, false);
});

test("aggregatePostDeliveryStatus returns partial_failed for mixed outcomes", () => {
  const status = aggregatePostDeliveryStatus(["published", "failed", "failed"]);
  assert.equal(status, "partial_failed");
});

test("aggregatePostDeliveryStatus returns published for all successful targets", () => {
  const status = aggregatePostDeliveryStatus(["published", "published"]);
  assert.equal(status, "published");
});

test("getRetryDelaySeconds applies exponential backoff with upper bound", () => {
  assert.equal(getRetryDelaySeconds(1), 30);
  assert.equal(getRetryDelaySeconds(2), 60);
  assert.equal(getRetryDelaySeconds(3), 120);
  assert.equal(getRetryDelaySeconds(20), 900);
});
