import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTargetPayloadsForConnections,
  DraftCapabilityValidationError
} from "../../lib/posts/capabilities.ts";

test("draft capabilities reject unsupported TikTok target payloads", () => {
  assert.throws(
    () =>
      buildTargetPayloadsForConnections({
        connections: [{ id: "conn-tiktok", platform: "tiktok" }],
        canonical: {
          caption: "hello",
          hashtags: ["mvp"],
          location: null,
          mediaAssetIds: ["asset-1"],
          mediaStoragePaths: ["workspace-1/asset-1/video.mp4"]
        }
      }),
    (error: unknown) => {
      assert.ok(error instanceof DraftCapabilityValidationError);
      assert.equal(error.platform, "tiktok");
      assert.match(error.message, /TikTok connector is deferred/i);
      return true;
    }
  );
});

test("draft capabilities include adapter warnings and transformed payload", () => {
  const hashtags = Array.from({ length: 31 }, (_, index) => `tag${index + 1}`);
  const result = buildTargetPayloadsForConnections({
    connections: [{ id: "conn-facebook", platform: "facebook" }],
    canonical: {
      caption: "Phase 2 validation",
      hashtags,
      location: "Chicago, IL",
      mediaAssetIds: ["asset-1"],
      mediaStoragePaths: ["workspace-1/asset-1/photo.jpg"]
    }
  });

  const payload = result.payloadByConnectionId.get("conn-facebook");
  assert.ok(payload);
  assert.ok(payload?.platformPayload);
  assert.equal(payload?.mediaAssetIds.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.platform, "facebook");
  assert.match(result.warnings[0]?.messages[0] ?? "", /up to 30 hashtags/i);

  const transformedMessage = payload?.platformPayload.message;
  assert.equal(typeof transformedMessage, "string");
  assert.match(transformedMessage as string, /#tag1/);
});

test("draft capabilities pass without warnings for valid Instagram payload", () => {
  const result = buildTargetPayloadsForConnections({
    connections: [{ id: "conn-instagram", platform: "instagram" }],
    canonical: {
      caption: "Launch day",
      hashtags: ["launch", "product"],
      location: "Austin, TX",
      mediaAssetIds: ["asset-99"],
      mediaStoragePaths: ["workspace-1/asset-99/post.png"]
    }
  });

  const payload = result.payloadByConnectionId.get("conn-instagram");
  assert.ok(payload);
  assert.deepEqual(payload?.capabilityWarnings, []);
  assert.equal(result.warnings.length, 0);
});
