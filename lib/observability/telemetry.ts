import { randomUUID } from "crypto";

type TelemetryLevel = "info" | "warning" | "error";

type TelemetryEvent = {
  event: string;
  level?: TelemetryLevel;
  message?: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
  data?: Record<string, unknown>;
  error?: unknown;
};

type SentryDsnParts = {
  protocol: string;
  host: string;
  projectId: string;
  publicKey: string;
  secretKey?: string;
};

function serializeError(error: unknown) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function normalizeTags(tags?: TelemetryEvent["tags"]) {
  const normalized: Record<string, string> = {};
  if (!tags) {
    return normalized;
  }

  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) {
      continue;
    }

    normalized[key] = String(value);
  }

  return normalized;
}

function parseSentryDsn(dsn: string): SentryDsnParts | null {
  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!projectId || !parsed.username) {
      return null;
    }

    return {
      protocol: parsed.protocol,
      host: parsed.host,
      projectId,
      publicKey: parsed.username,
      secretKey: parsed.password || undefined
    };
  } catch {
    return null;
  }
}

function buildSentryEndpoint(parts: SentryDsnParts) {
  const query = new URLSearchParams({
    sentry_key: parts.publicKey,
    sentry_version: "7"
  });

  if (parts.secretKey) {
    query.set("sentry_secret", parts.secretKey);
  }

  return `${parts.protocol}//${parts.host}/api/${parts.projectId}/envelope/?${query.toString()}`;
}

async function postSentryEnvelope(input: {
  dsn: string;
  level: TelemetryLevel;
  event: string;
  message: string;
  tags: Record<string, string>;
  data?: Record<string, unknown>;
  error?: unknown;
}) {
  const parts = parseSentryDsn(input.dsn);
  if (!parts) {
    return;
  }

  const eventId = randomUUID().replace(/-/g, "");
  const sentAt = new Date().toISOString();
  const nowSeconds = Date.now() / 1000;
  const endpoint = buildSentryEndpoint(parts);

  const header = {
    event_id: eventId,
    sent_at: sentAt,
    dsn: input.dsn
  };

  const itemHeader = {
    type: "event"
  };

  const errorDetails = serializeError(input.error);

  const eventPayload: Record<string, unknown> = {
    event_id: eventId,
    timestamp: nowSeconds,
    level: input.level === "warning" ? "warning" : input.level,
    logger: "social-media-manager",
    platform: "javascript",
    server_name: process.env.VERCEL_URL ?? "unknown",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    message: input.message,
    tags: {
      ...input.tags,
      event: input.event,
      app_event: input.event
    },
    extra: input.data ?? {}
  };

  if (errorDetails) {
    eventPayload.exception = {
      values: [
        {
          type: errorDetails.name ?? "Error",
          value: errorDetails.message,
          stacktrace: errorDetails.stack ? { frames: [{ filename: "app", function: "unknown" }] } : undefined
        }
      ]
    };
    (eventPayload.extra as Record<string, unknown>).error = errorDetails;
  }

  const envelope = `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(eventPayload)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope"
      },
      body: envelope,
      signal: controller.signal
    });
  } catch {
    // Ignore Sentry transport failures to avoid impacting request paths.
  } finally {
    clearTimeout(timeout);
  }
}

export async function emitTelemetry(event: TelemetryEvent) {
  const level = event.level ?? "info";
  const message = event.message ?? event.event;
  const tags = normalizeTags(event.tags);
  const error = serializeError(event.error);
  const payload = {
    ts: new Date().toISOString(),
    level,
    event: event.event,
    message,
    tags,
    data: event.data ?? {},
    error
  };

  const output = JSON.stringify(payload);
  if (level === "error") {
    console.error(output);
  } else if (level === "warning") {
    console.warn(output);
  } else {
    console.log(output);
  }

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }

  await postSentryEnvelope({
    dsn,
    level,
    event: event.event,
    message,
    tags,
    data: event.data,
    error: event.error
  });
}
