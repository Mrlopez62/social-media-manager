import type { Platform } from "@/lib/types";

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v22.0";
const DEFAULT_META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management"
];

type MetaOAuthTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

type MetaPage = {
  id: string;
  name?: string;
  access_token: string;
};

type MetaPageListResponse = {
  data?: MetaPage[];
};

type MetaInstagramAccount = {
  id: string;
  username?: string;
};

type MetaPageDetailResponse = {
  id: string;
  name?: string;
  instagram_business_account?: MetaInstagramAccount;
};

export type MetaConnectionCandidate = {
  platform: "facebook" | "instagram";
  accountId: string;
  displayName: string;
  accessToken: string;
  scopes: string[];
};

type MetaErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    fbtrace_id?: string;
  };
};

function getMetaConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    throw new Error("Missing Meta config. Set META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI.");
  }

  return {
    appId,
    appSecret,
    redirectUri,
    graphVersion: DEFAULT_GRAPH_VERSION,
    scopes: DEFAULT_META_SCOPES
  };
}

export function isMetaPlatform(platform: Platform): platform is "facebook" | "instagram" {
  return platform === "facebook" || platform === "instagram";
}

export function buildMetaAuthorizationUrl(state: string) {
  const config = getMetaConfig();
  const query = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    scope: config.scopes.join(","),
    response_type: "code"
  });

  return `https://www.facebook.com/${config.graphVersion}/dialog/oauth?${query.toString()}`;
}

function buildGraphUrl(path: string, params: Record<string, string>) {
  const base = `https://graph.facebook.com/${DEFAULT_GRAPH_VERSION}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const query = new URLSearchParams(params);
  return `${base}${normalizedPath}?${query.toString()}`;
}

async function getMetaJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(buildGraphUrl(path, params), {
    headers: {
      Accept: "application/json"
    }
  });

  const body = (await response.json().catch(() => null)) as T | MetaErrorResponse | null;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && body.error?.message
        ? body.error.message
        : `Meta API request failed with status ${response.status}.`;

    throw new Error(message);
  }

  return body as T;
}

async function exchangeCodeForToken(code: string) {
  const config = getMetaConfig();

  const shortLived = await getMetaJson<MetaOAuthTokenResponse>("/oauth/access_token", {
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    client_secret: config.appSecret,
    code
  });

  if (!shortLived.access_token) {
    throw new Error("Meta token exchange returned no access token.");
  }

  try {
    const longLived = await getMetaJson<MetaOAuthTokenResponse>("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: shortLived.access_token
    });

    if (!longLived.access_token) {
      return shortLived;
    }

    return longLived;
  } catch {
    return shortLived;
  }
}

async function fetchPages(userAccessToken: string) {
  const response = await getMetaJson<MetaPageListResponse>("/me/accounts", {
    access_token: userAccessToken,
    fields: "id,name,access_token"
  });

  return response.data ?? [];
}

async function fetchInstagramForPage(page: MetaPage) {
  const response = await getMetaJson<MetaPageDetailResponse>(`/${page.id}`, {
    access_token: page.access_token,
    fields: "id,name,instagram_business_account{id,username}"
  }).catch(() => null);

  if (!response?.instagram_business_account) {
    return null;
  }

  return {
    id: response.instagram_business_account.id,
    username: response.instagram_business_account.username ?? null,
    pageName: response.name ?? page.name ?? page.id
  };
}

function dedupeConnections(connections: MetaConnectionCandidate[]) {
  const byKey = new Map<string, MetaConnectionCandidate>();

  for (const connection of connections) {
    const key = `${connection.platform}:${connection.accountId}`;
    if (!byKey.has(key)) {
      byKey.set(key, connection);
    }
  }

  return [...byKey.values()];
}

export async function connectMetaAccountsFromCode(code: string) {
  const config = getMetaConfig();
  const tokenResponse = await exchangeCodeForToken(code);
  const userAccessToken = tokenResponse.access_token;
  const pages = await fetchPages(userAccessToken);

  if (pages.length === 0) {
    throw new Error(
      "No Facebook pages were found for this account. Connect a business page linked to Instagram."
    );
  }

  const connections: MetaConnectionCandidate[] = [];

  for (const page of pages) {
    if (!page.id || !page.access_token) {
      continue;
    }

    connections.push({
      platform: "facebook",
      accountId: page.id,
      displayName: page.name ?? page.id,
      accessToken: page.access_token,
      scopes: config.scopes
    });

    const instagram = await fetchInstagramForPage(page);

    if (instagram) {
      connections.push({
        platform: "instagram",
        accountId: instagram.id,
        displayName: instagram.username ?? instagram.pageName,
        accessToken: page.access_token,
        scopes: config.scopes
      });
    }
  }

  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    : null;

  return {
    expiresAt,
    scopes: config.scopes,
    connections: dedupeConnections(connections)
  };
}
