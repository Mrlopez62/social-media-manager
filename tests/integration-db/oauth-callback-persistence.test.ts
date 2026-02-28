import assert from "node:assert/strict";
import test from "node:test";
import {
  MetaCallbackPersistenceError,
  persistMetaCallbackConnections
} from "../../lib/connections/meta-callback-persistence.ts";
import { createOauthPersistenceFixture, hasDbTestEnv } from "../helpers/db-fixtures.ts";

const dbTestSkip = hasDbTestEnv()
  ? false
  : "Missing DB test env. Set TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).";

type SavedConnectionRow = {
  platform: string;
  account_id: string;
  access_token_enc: string;
  status: string;
  expires_at: string | null;
  scopes: string[];
};

test(
  "oauth callback persistence upserts social_connections and consumes oauth_state",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createOauthPersistenceFixture();

    try {
      const client = fixture.client;
      const existingAccountId = "page_123";

      const { error: existingInsertError } = await client.from("social_connections").insert({
        workspace_id: fixture.workspaceId,
        platform: "facebook",
        account_id: existingAccountId,
        access_token_enc: "enc:old-page-token",
        refresh_token_enc: null,
        expires_at: null,
        scopes: ["pages_show_list"],
        status: "revoked"
      });

      assert.equal(existingInsertError, null);

      const expectedConsumedAt = "2026-02-28T18:00:00.000Z";
      const expectedExpiresAt = "2026-03-01T00:00:00.000Z";

      const persisted = await persistMetaCallbackConnections({
        userClient: client,
        workspaceId: fixture.workspaceId,
        actorUserId: fixture.userId,
        oauthStateId: fixture.oauthStateId,
        platform: "facebook",
        expiresAt: expectedExpiresAt,
        connections: [
          {
            platform: "facebook",
            accountId: existingAccountId,
            accessToken: "new-page-token",
            scopes: ["pages_show_list", "pages_manage_posts"]
          },
          {
            platform: "instagram",
            accountId: "ig_999",
            accessToken: "ig-token",
            scopes: ["instagram_basic", "instagram_content_publish"]
          }
        ],
        encryptToken: (token) => `enc:${token}`,
        nowIso: () => expectedConsumedAt
      });

      assert.equal(persisted.connectedCount, 2);
      assert.equal(persisted.connections.length, 2);

      const { data: savedConnections, error: savedConnectionsError } = await client
        .from("social_connections")
        .select("platform, account_id, access_token_enc, status, expires_at, scopes")
        .eq("workspace_id", fixture.workspaceId)
        .order("platform", { ascending: true });

      const rows = (savedConnections ?? []) as SavedConnectionRow[];
      assert.equal(savedConnectionsError, null);
      assert.equal(rows.length, 2);

      const facebookConnection = rows.find(
        (connection) => connection.platform === "facebook" && connection.account_id === existingAccountId
      );
      const instagramConnection = rows.find(
        (connection) => connection.platform === "instagram" && connection.account_id === "ig_999"
      );

      assert.ok(facebookConnection);
      assert.ok(instagramConnection);

      assert.equal(facebookConnection?.access_token_enc, "enc:new-page-token");
      assert.equal(facebookConnection?.status, "active");
      assert.equal(new Date(facebookConnection?.expires_at ?? "").toISOString(), expectedExpiresAt);

      assert.equal(instagramConnection?.access_token_enc, "enc:ig-token");
      assert.equal(instagramConnection?.status, "active");

      const { data: consumedState, error: consumedStateError } = await client
        .from("oauth_states")
        .select("consumed_at")
        .eq("id", fixture.oauthStateId)
        .single();

      assert.equal(consumedStateError, null);
      assert.equal(new Date(consumedState?.consumed_at ?? "").toISOString(), expectedConsumedAt);
    } finally {
      await fixture.cleanup();
    }
  }
);

test(
  "oauth callback persistence fails when oauth_state is already consumed",
  { skip: dbTestSkip },
  async () => {
    const fixture = await createOauthPersistenceFixture();

    try {
      const client = fixture.client;
      const alreadyConsumedAt = "2026-02-28T10:30:00.000Z";
      const { error: consumeError } = await client
        .from("oauth_states")
        .update({ consumed_at: alreadyConsumedAt })
        .eq("id", fixture.oauthStateId);

      assert.equal(consumeError, null);

      await assert.rejects(
        () =>
          persistMetaCallbackConnections({
            userClient: client,
            workspaceId: fixture.workspaceId,
            actorUserId: fixture.userId,
            oauthStateId: fixture.oauthStateId,
            platform: "facebook",
            expiresAt: "2026-03-01T00:00:00.000Z",
            connections: [
              {
                platform: "facebook",
                accountId: "page_123",
                accessToken: "new-page-token",
                scopes: ["pages_show_list"]
              }
            ],
            encryptToken: (token) => `enc:${token}`,
            nowIso: () => "2026-02-28T18:05:00.000Z"
          }),
        (error: unknown) => {
          assert.ok(error instanceof MetaCallbackPersistenceError);
          assert.equal(error.code, "OAUTH_STATE_CONSUME_CONFLICT");
          assert.equal(error.status, 409);
          return true;
        }
      );
    } finally {
      await fixture.cleanup();
    }
  }
);
