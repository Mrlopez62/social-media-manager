import { getAdapter } from "../adapters/index.ts";
import type { Platform } from "../types.ts";

export type DraftTargetConnection = {
  id: string;
  platform: Platform;
};

export type DraftCanonicalPayload = {
  caption: string;
  hashtags: string[];
  location: string | null;
  mediaAssetIds: string[];
  mediaStoragePaths: string[];
};

export type DraftTargetPayload = {
  caption: string;
  hashtags: string[];
  location: string | null;
  mediaAssetIds: string[];
  mediaStoragePaths: string[];
  platformPayload: Record<string, unknown>;
  capabilityWarnings: string[];
};

export type DraftCapabilityWarning = {
  connectionId: string;
  platform: Platform;
  messages: string[];
};

export class DraftCapabilityValidationError extends Error {
  platform: Platform;
  errors: string[];

  constructor(platform: Platform, errors: string[]) {
    super(`Invalid ${platform} target payload: ${errors.join("; ")}`);
    this.platform = platform;
    this.errors = errors;
  }
}

function buildAdapterInput(payload: DraftCanonicalPayload) {
  return {
    caption: payload.caption,
    hashtags: payload.hashtags,
    location: payload.location,
    mediaUrls: payload.mediaStoragePaths
  };
}

export function buildTargetPayloadsForConnections(params: {
  connections: DraftTargetConnection[];
  canonical: DraftCanonicalPayload;
}) {
  const payloadByConnectionId = new Map<string, DraftTargetPayload>();
  const warnings: DraftCapabilityWarning[] = [];

  for (const connection of params.connections) {
    const adapter = getAdapter(connection.platform);
    const adapterInput = buildAdapterInput(params.canonical);
    const validation = adapter.validatePayload(adapterInput);

    if (!validation.valid) {
      throw new DraftCapabilityValidationError(connection.platform, validation.errors);
    }

    const transformed = adapter.transformPayload(adapterInput);
    const nextPayload: DraftTargetPayload = {
      caption: params.canonical.caption,
      hashtags: params.canonical.hashtags,
      location: params.canonical.location,
      mediaAssetIds: params.canonical.mediaAssetIds,
      mediaStoragePaths: params.canonical.mediaStoragePaths,
      platformPayload: transformed,
      capabilityWarnings: validation.warnings
    };

    payloadByConnectionId.set(connection.id, nextPayload);

    if (validation.warnings.length > 0) {
      warnings.push({
        connectionId: connection.id,
        platform: connection.platform,
        messages: validation.warnings
      });
    }
  }

  return {
    payloadByConnectionId,
    warnings
  };
}
