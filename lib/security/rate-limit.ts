import { createHash } from "crypto";
import { emitTelemetry } from "../observability/telemetry.ts";
import { getSupabaseServiceClient } from "../supabase.ts";

type RateLimitPolicy = {
  scope: string;
  limit: number;
  windowSeconds: number;
};

type RateLimitResponseBody = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export type NormalizedRateLimitError = {
  status: number;
  code: string;
  message: string;
  details?: unknown;
};

type RateLimitRpcRow = {
  allowed: boolean;
  remaining: number;
  reset_at: string;
  count: number;
};

function parsePositiveInt(rawValue: string | undefined, fallback: number) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function readPolicy(scope: string, limitEnv: string, windowEnv: string, defaults: { limit: number; windowSeconds: number }) {
  return {
    scope,
    limit: parsePositiveInt(process.env[limitEnv], defaults.limit),
    windowSeconds: parsePositiveInt(process.env[windowEnv], defaults.windowSeconds)
  } satisfies RateLimitPolicy;
}

function getRequestIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
}

function hashIdentifier(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildSubject(params: { req: Request; userId?: string }) {
  if (params.userId) {
    return `user:${params.userId}`;
  }

  return `ip:${hashIdentifier(getRequestIp(params.req))}`;
}

function getRetryAfterSeconds(resetAt: string) {
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) {
    return 60;
  }

  return Math.max(1, Math.ceil((parsed.getTime() - Date.now()) / 1000));
}

function buildRateLimitedResponse(params: {
  scope: string;
  limit: number;
  windowSeconds: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
}) {
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Please try again shortly.",
        details: {
          scope: params.scope,
          limit: params.limit,
          windowSeconds: params.windowSeconds,
          remaining: params.remaining,
          resetAt: params.resetAt
        }
      }
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(params.retryAfterSeconds)
      }
    }
  );
}

export async function normalizeRateLimitResponse(response: Response): Promise<NormalizedRateLimitError> {
  const parsed = (await response.clone().json().catch(() => null)) as RateLimitResponseBody | null;

  return {
    status: response.status,
    code: parsed?.error?.code ?? "RATE_LIMITED",
    message: parsed?.error?.message ?? "Rate limit exceeded.",
    details: parsed?.error?.details
  };
}

export const rateLimitPolicies = {
  authLogin: readPolicy("auth.login", "RATE_LIMIT_AUTH_LOGIN_MAX", "RATE_LIMIT_AUTH_LOGIN_WINDOW_SECONDS", {
    limit: 8,
    windowSeconds: 60
  }),
  authSignup: readPolicy("auth.signup", "RATE_LIMIT_AUTH_SIGNUP_MAX", "RATE_LIMIT_AUTH_SIGNUP_WINDOW_SECONDS", {
    limit: 4,
    windowSeconds: 60
  }),
  oauthStart: readPolicy(
    "connections.oauth.start",
    "RATE_LIMIT_OAUTH_START_MAX",
    "RATE_LIMIT_OAUTH_START_WINDOW_SECONDS",
    {
      limit: 12,
      windowSeconds: 60
    }
  ),
  postsWrite: readPolicy("posts.write", "RATE_LIMIT_POST_WRITE_MAX", "RATE_LIMIT_POST_WRITE_WINDOW_SECONDS", {
    limit: 40,
    windowSeconds: 60
  }),
  publishQueue: readPolicy(
    "posts.publish.queue",
    "RATE_LIMIT_POST_PUBLISH_QUEUE_MAX",
    "RATE_LIMIT_POST_PUBLISH_QUEUE_WINDOW_SECONDS",
    {
      limit: 20,
      windowSeconds: 60
    }
  ),
  mediaWrite: readPolicy("media.write", "RATE_LIMIT_MEDIA_WRITE_MAX", "RATE_LIMIT_MEDIA_WRITE_WINDOW_SECONDS", {
    limit: 30,
    windowSeconds: 60
  })
};

export async function enforceRateLimit(params: {
  req: Request;
  policy: RateLimitPolicy;
  userId?: string;
}) {
  if (process.env.DISABLE_RATE_LIMITS === "true") {
    return null;
  }

  const subject = buildSubject({ req: params.req, userId: params.userId });

  let rpcData: RateLimitRpcRow | null = null;
  try {
    const serviceClient = getSupabaseServiceClient();
    const { data, error } = await serviceClient.rpc("consume_api_rate_limit", {
      p_scope: params.policy.scope,
      p_subject: subject,
      p_window_seconds: params.policy.windowSeconds,
      p_limit: params.policy.limit
    });

    if (error) {
      void emitTelemetry({
        event: "security.rate_limit.consume_failed",
        level: "warning",
        message: "Rate limit consume RPC failed.",
        tags: {
          scope: params.policy.scope
        },
        data: {
          subject
        },
        error
      });
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as RateLimitRpcRow | undefined;
    if (!row) {
      return null;
    }

    rpcData = row;
  } catch (error) {
    void emitTelemetry({
      event: "security.rate_limit.consume_exception",
      level: "warning",
      message: "Rate limit consume call raised an exception.",
      tags: {
        scope: params.policy.scope
      },
      data: {
        subject
      },
      error
    });
    return null;
  }

  if (rpcData.allowed) {
    return null;
  }

  void emitTelemetry({
    event: "security.rate_limit.denied",
    level: "warning",
    message: "Rate limit denied request.",
    tags: {
      scope: params.policy.scope
    },
    data: {
      subject,
      limit: params.policy.limit,
      windowSeconds: params.policy.windowSeconds,
      remaining: rpcData.remaining,
      resetAt: rpcData.reset_at
    }
  });

  const retryAfterSeconds = getRetryAfterSeconds(rpcData.reset_at);
  return buildRateLimitedResponse({
    scope: params.policy.scope,
    limit: params.policy.limit,
    windowSeconds: params.policy.windowSeconds,
    remaining: rpcData.remaining,
    resetAt: rpcData.reset_at,
    retryAfterSeconds
  });
}
