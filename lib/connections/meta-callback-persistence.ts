export type CallbackConnectionInput = {
  platform: "facebook" | "instagram";
  accountId: string;
  accessToken: string;
  scopes: string[];
};

export type PersistMetaCallbackParams = {
  userClient: unknown;
  workspaceId: string;
  actorUserId: string;
  oauthStateId: string;
  platform: "facebook" | "instagram";
  expiresAt: string | null;
  connections: CallbackConnectionInput[];
  encryptToken: (token: string) => string;
  nowIso?: () => string;
};

type UserClientLike = {
  from: (table: string) => {
    upsert: (
      values: unknown,
      options?: { onConflict?: string }
    ) => {
      select: (columns: string) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    update: (values: unknown) => {
      eq: (column: string, value: unknown) => {
        is: (column: string, value: unknown) => {
          select: (columns: string) => {
            maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
          };
        };
      };
    };
    insert: (values: unknown) => Promise<{ error: { message: string } | null }>;
  };
};

type SavedConnection = {
  id: string;
  platform: "facebook" | "instagram";
  account_id: string;
  status: string;
  expires_at: string | null;
  scopes: string[];
};

export class MetaCallbackPersistenceError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function dedupeConnections(connections: CallbackConnectionInput[]) {
  const byKey = new Map<string, CallbackConnectionInput>();

  for (const connection of connections) {
    const key = `${connection.platform}:${connection.accountId}`;
    if (!byKey.has(key)) {
      byKey.set(key, connection);
    }
  }

  return [...byKey.values()];
}

export async function persistMetaCallbackConnections(params: PersistMetaCallbackParams) {
  const userClient = params.userClient as UserClientLike;
  const nowIso = params.nowIso ?? (() => new Date().toISOString());
  const connections = dedupeConnections(params.connections);

  if (connections.length === 0) {
    throw new MetaCallbackPersistenceError(
      "META_NO_ACCOUNTS",
      400,
      "No eligible Facebook or Instagram business accounts were discovered."
    );
  }

  const upsertRows = connections.map((connection) => ({
    workspace_id: params.workspaceId,
    platform: connection.platform,
    account_id: connection.accountId,
    access_token_enc: params.encryptToken(connection.accessToken),
    refresh_token_enc: null,
    expires_at: params.expiresAt,
    scopes: connection.scopes,
    status: "active"
  }));

  const { data: savedConnectionsRaw, error: upsertError } = await userClient
    .from("social_connections")
    .upsert(upsertRows, { onConflict: "workspace_id,platform,account_id" })
    .select("id, platform, account_id, status, expires_at, scopes");

  if (upsertError) {
    throw new MetaCallbackPersistenceError("CONNECTION_SAVE_FAILED", 500, upsertError.message);
  }

  const consumedAt = nowIso();
  const { data: consumedState, error: consumeError } = await userClient
    .from("oauth_states")
    .update({ consumed_at: consumedAt })
    .eq("id", params.oauthStateId)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();

  if (consumeError) {
    throw new MetaCallbackPersistenceError("OAUTH_STATE_CONSUME_FAILED", 500, consumeError.message);
  }

  if (!consumedState) {
    throw new MetaCallbackPersistenceError(
      "OAUTH_STATE_CONSUME_CONFLICT",
      409,
      "OAuth state has already been consumed."
    );
  }

  const savedConnections = (savedConnectionsRaw ?? []) as SavedConnection[];

  const { error: auditError } = await userClient.from("audit_events").insert({
    workspace_id: params.workspaceId,
    actor_user_id: params.actorUserId,
    event_type: "connection.meta.connected",
    metadata_json: {
      platform: params.platform,
      connectedCount: savedConnections.length
    }
  });

  if (auditError) {
    throw new MetaCallbackPersistenceError("AUDIT_WRITE_FAILED", 500, auditError.message);
  }

  return {
    consumedAt,
    connectedCount: savedConnections.length,
    connections: savedConnections
  };
}
