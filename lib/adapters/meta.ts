import type {
  AdapterValidationResult,
  PlatformAdapter,
  PublishInput,
  PublishResult
} from "./base.ts";

const MAX_HASHTAGS = 30;

type MetaApiError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
};

type MetaApiResponse<T> = {
  data?: T;
  error?: MetaApiError;
};

type MetaRefreshResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

type MetaPublishResponse = {
  id?: string;
};

function getMetaConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  const graphVersion = process.env.META_GRAPH_VERSION ?? "v22.0";

  if (!appId || !appSecret || !redirectUri) {
    throw new Error("Missing Meta config. Set META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.");
  }

  return {
    appId,
    appSecret,
    redirectUri,
    graphVersion
  };
}

function isRetryableMetaCode(code: number | undefined) {
  if (!code) {
    return false;
  }

  return [1, 2, 4, 17, 32, 341, 368, 613].includes(code);
}

function getTextMessage(input: PublishInput) {
  return [input.caption, ...input.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`)]
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function parseMetaJson<T>(response: Response): Promise<MetaApiResponse<T>> {
  const body = (await response.json().catch(() => null)) as MetaApiResponse<T> | null;
  return body ?? {};
}

async function postMetaForm<T>(
  graphVersion: string,
  path: string,
  form: Record<string, string>
): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `https://graph.facebook.com/${graphVersion}${normalizedPath}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams(form).toString()
  });

  const parsed = await parseMetaJson<T>(response);

  if (!response.ok || parsed.error) {
    const error = parsed.error ?? { message: `Meta API request failed with status ${response.status}.` };
    throw {
      meta: true,
      ...error
    };
  }

  return parsed as T;
}

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
    const input = _input;

    try {
      const config = getMetaConfig();
      const accessToken =
        typeof input.metadata?.accessToken === "string" ? input.metadata.accessToken : null;
      const accountId = typeof input.metadata?.accountId === "string" ? input.metadata.accountId : null;

      if (!accessToken || !accountId) {
        return {
          success: false,
          retryable: false,
          errorCode: "META_CONFIG_MISSING_TOKEN",
          errorMessage: "Meta publish metadata is missing accountId or accessToken."
        };
      }

      const textMessage = getTextMessage(input);

      if (this.platform === "facebook") {
        const published = await postMetaForm<MetaPublishResponse>(
          config.graphVersion,
          `/${accountId}/feed`,
          {
            message: textMessage,
            access_token: accessToken
          }
        );

        return {
          success: true,
          retryable: false,
          externalPostId: published.id
        };
      }

      const publicMediaUrl = input.mediaUrls.find((url) => /^https?:\/\//i.test(url));
      if (!publicMediaUrl) {
        return {
          success: false,
          retryable: false,
          errorCode: "META_IG_MEDIA_URL_INVALID",
          errorMessage: "Instagram publishing requires at least one public media URL."
        };
      }

      const isVideo = /\.(mp4|mov)(\?|$)/i.test(publicMediaUrl);

      const container = await postMetaForm<MetaPublishResponse>(
        config.graphVersion,
        `/${accountId}/media`,
        isVideo
          ? {
              media_type: "REELS",
              video_url: publicMediaUrl,
              caption: textMessage,
              access_token: accessToken
            }
          : {
              image_url: publicMediaUrl,
              caption: textMessage,
              access_token: accessToken
            }
      );

      if (!container.id) {
        return {
          success: false,
          retryable: false,
          errorCode: "META_IG_CONTAINER_CREATE_FAILED",
          errorMessage: "Meta did not return an Instagram media container id."
        };
      }

      const published = await postMetaForm<MetaPublishResponse>(
        config.graphVersion,
        `/${accountId}/media_publish`,
        {
          creation_id: container.id,
          access_token: accessToken
        }
      );

      return {
        success: true,
        retryable: false,
        externalPostId: published.id ?? container.id
      };
    } catch (error) {
      const mapped = this.mapError(error);
      return {
        success: false,
        retryable: mapped.retryable,
        errorCode: mapped.code,
        errorMessage: mapped.message
      };
    }
  }

  async refreshToken(connectionId: string) {
    try {
      const config = getMetaConfig();
      const currentAccessToken = connectionId;

      if (!currentAccessToken) {
        return {
          success: false,
          error: "Missing access token for Meta refresh flow."
        };
      }

      const refreshed = await postMetaForm<MetaRefreshResponse>(
        config.graphVersion,
        "/oauth/access_token",
        {
          grant_type: "fb_exchange_token",
          client_id: config.appId,
          client_secret: config.appSecret,
          fb_exchange_token: currentAccessToken
        }
      );

      if (!refreshed.access_token) {
        return {
          success: false,
          error: "Meta refresh response did not include access_token."
        };
      }

      const expiresAt =
        typeof refreshed.expires_in === "number"
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : undefined;

      return {
        success: true,
        accessToken: refreshed.access_token,
        expiresAt
      };
    } catch (error) {
      const mapped = this.mapError(error);
      return {
        success: false,
        error: mapped.message
      };
    }
  }

  mapError(error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "meta" in error &&
      "message" in error
    ) {
      const metaError = error as MetaApiError;
      const code = metaError.code ? `META_${metaError.code}` : "META_ERROR";
      const message = metaError.message ?? "Meta API request failed.";
      const retryable = Boolean(metaError.is_transient) || isRetryableMetaCode(metaError.code);

      return {
        code,
        message,
        retryable
      };
    }

    const message =
      error instanceof Error ? error.message : "Unknown Meta adapter error.";

    const retryable = Boolean(
      error instanceof Error &&
        (error.name === "AbortError" || /fetch|network|timeout/i.test(error.message))
    );

    return {
      code: retryable ? "META_NETWORK_ERROR" : "META_ERROR",
      message,
      retryable
    };
  }
}
