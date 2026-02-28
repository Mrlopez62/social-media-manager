export type OAuthStateValidationCode =
  | "OAUTH_STATE_INVALID"
  | "OAUTH_STATE_PLATFORM_MISMATCH"
  | "OAUTH_STATE_CONSUMED"
  | "OAUTH_STATE_EXPIRED";

export type OAuthStateRecord = {
  platform: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type OAuthStateValidationFailure = {
  ok: false;
  code: OAuthStateValidationCode;
  status: number;
  message: string;
};

export type OAuthStateValidationResult = { ok: true } | OAuthStateValidationFailure;

export function validateOAuthState(params: {
  oauthState: OAuthStateRecord | null;
  expectedPlatform: string;
  now?: Date;
}): OAuthStateValidationResult {
  if (!params.oauthState) {
    return {
      ok: false,
      code: "OAUTH_STATE_INVALID",
      status: 400,
      message: "OAuth state was not found."
    };
  }

  if (params.oauthState.platform !== params.expectedPlatform) {
    return {
      ok: false,
      code: "OAUTH_STATE_PLATFORM_MISMATCH",
      status: 400,
      message: "OAuth platform does not match state."
    };
  }

  if (params.oauthState.consumedAt) {
    return {
      ok: false,
      code: "OAUTH_STATE_CONSUMED",
      status: 409,
      message: "OAuth state has already been used."
    };
  }

  const expiresAtDate = new Date(params.oauthState.expiresAt);
  const now = params.now ?? new Date();

  if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() < now.getTime()) {
    return {
      ok: false,
      code: "OAUTH_STATE_EXPIRED",
      status: 400,
      message: "OAuth state has expired. Restart the connection flow."
    };
  }

  return { ok: true };
}
