import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";

type ServiceClient = SupabaseClient;

export type WorkspaceFixture = {
  client: ServiceClient;
  userId: string;
  workspaceId: string;
  cleanup: () => Promise<void>;
};

export type DbFixture = {
  client: ServiceClient;
  userId: string;
  workspaceId: string;
  oauthStateId: string;
  oauthState: string;
  cleanup: () => Promise<void>;
};

export type PublishPipelineFixture = {
  client: ServiceClient;
  userId: string;
  workspaceId: string;
  postId: string;
  targetId: string;
  connectionId: string;
  cleanup: () => Promise<void>;
};

function getDbEnv() {
  const url = process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  return {
    url: url ?? "",
    serviceRoleKey: serviceRoleKey ?? ""
  };
}

export function hasDbTestEnv() {
  const env = getDbEnv();
  return Boolean(env.url && env.serviceRoleKey);
}

function assertServiceRoleKey(serviceRoleKey: string) {
  const key = serviceRoleKey.trim();

  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "TEST_SUPABASE_SERVICE_ROLE_KEY is set to a publishable key (sb_publishable_*). Use a service-role/secret server key instead."
    );
  }

  if (key.startsWith("sb_anon_")) {
    throw new Error(
      "TEST_SUPABASE_SERVICE_ROLE_KEY is set to an anon key (sb_anon_*). Use a service-role/secret server key instead."
    );
  }

  const isServerApiKey = key.startsWith("sb_secret_") || key.startsWith("eyJ");
  if (!isServerApiKey) {
    const looksLikeJwtSigningSecret = /^[A-Za-z0-9+/=]{40,}$/.test(key);
    if (looksLikeJwtSigningSecret) {
      throw new Error(
        "TEST_SUPABASE_SERVICE_ROLE_KEY looks like a JWT signing secret, not an API key. Use the service-role/secret API key from Supabase Dashboard > Project Settings > API."
      );
    }

    throw new Error(
      "TEST_SUPABASE_SERVICE_ROLE_KEY is invalid. Use a Supabase server API key (sb_secret_* or legacy service_role JWT key that starts with eyJ...)."
    );
  }
}

export function createServiceRoleClient() {
  const env = getDbEnv();

  if (!env.url || !env.serviceRoleKey) {
    throw new Error(
      "Missing DB test env vars. Set TEST_SUPABASE_URL/TEST_SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  assertServiceRoleKey(env.serviceRoleKey);

  return createClient(env.url, env.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export async function createWorkspaceFixture(): Promise<WorkspaceFixture> {
  const client = createServiceRoleClient();
  const unique = randomUUID();
  const email = `phase2-${unique}@example.test`;
  const password = `P@ssw0rd-${unique}`;

  const { data: createdUser, error: userError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (userError || !createdUser.user) {
    throw new Error(`Failed creating auth user fixture: ${userError?.message ?? "unknown error"}`);
  }

  const userId = createdUser.user.id;

  const { error: upsertUserError } = await client.from("users").upsert({
    id: userId,
    email
  });

  if (upsertUserError) {
    await client.auth.admin.deleteUser(userId);
    throw new Error(`Failed upserting public user fixture: ${upsertUserError.message}`);
  }

  const { data: workspace, error: workspaceError } = await client
    .from("workspaces")
    .insert({
      name: `Phase2 Fixture ${unique}`,
      owner_user_id: userId
    })
    .select("id")
    .single();

  if (workspaceError || !workspace) {
    await client.auth.admin.deleteUser(userId);
    throw new Error(`Failed creating workspace fixture: ${workspaceError?.message ?? "unknown error"}`);
  }

  const workspaceId = workspace.id as string;

  const { error: memberError } = await client.from("workspace_members").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role: "owner"
  });

  if (memberError) {
    await client.from("workspaces").delete().eq("id", workspaceId);
    await client.auth.admin.deleteUser(userId);
    throw new Error(`Failed creating workspace member fixture: ${memberError.message}`);
  }

  return {
    client,
    userId,
    workspaceId,
    cleanup: async () => {
      await client.from("workspaces").delete().eq("id", workspaceId);
      await client.auth.admin.deleteUser(userId);
    }
  };
}

export async function createOauthPersistenceFixture(): Promise<DbFixture> {
  const workspaceFixture = await createWorkspaceFixture();
  const oauthState = `state-${randomUUID()}`;

  const { data: stateRow, error: stateError } = await workspaceFixture.client
    .from("oauth_states")
    .insert({
      workspace_id: workspaceFixture.workspaceId,
      actor_user_id: workspaceFixture.userId,
      platform: "facebook",
      state: oauthState,
      redirect_uri: "https://localhost/callback",
      scopes: ["pages_show_list"],
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    })
    .select("id")
    .single();

  if (stateError || !stateRow) {
    await workspaceFixture.cleanup();
    throw new Error(`Failed creating oauth state fixture: ${stateError?.message ?? "unknown error"}`);
  }

  return {
    ...workspaceFixture,
    oauthStateId: stateRow.id as string,
    oauthState
  };
}

export async function ensureMediaBucket(client: ServiceClient, bucketName: string) {
  const { data: buckets, error: listError } = await client.storage.listBuckets();

  if (listError) {
    throw new Error(`Failed listing storage buckets: ${listError.message}`);
  }

  const exists = (buckets ?? []).some((bucket) => bucket.id === bucketName || bucket.name === bucketName);
  if (exists) {
    return;
  }

  const { error: createError } = await client.storage.createBucket(bucketName, {
    public: false
  });

  if (createError && !createError.message.toLowerCase().includes("already")) {
    throw new Error(`Failed to ensure media bucket ${bucketName}: ${createError.message}`);
  }
}

export async function uploadFixtureStorageObject(
  client: ServiceClient,
  params: {
    bucketName: string;
    storagePath: string;
    content: string;
    mimeType: string;
  }
) {
  const bytes = new TextEncoder().encode(params.content);
  const { error } = await client.storage.from(params.bucketName).upload(params.storagePath, bytes, {
    upsert: true,
    contentType: params.mimeType
  });

  if (error) {
    throw new Error(`Failed uploading fixture storage object: ${error.message}`);
  }

  return bytes.length;
}

export async function createPublishPipelineFixture(params?: {
  platform?: "facebook" | "instagram" | "tiktok";
  expiredConnection?: boolean;
  accessTokenEnc?: string;
}) {
  const workspaceFixture = await createWorkspaceFixture();
  const platform = params?.platform ?? "tiktok";
  const expiresAt = params?.expiredConnection
    ? new Date(Date.now() - 60 * 1000).toISOString()
    : null;

  const { data: connection, error: connectionError } = await workspaceFixture.client
    .from("social_connections")
    .insert({
      workspace_id: workspaceFixture.workspaceId,
      platform,
      account_id: `${platform}_acct_${randomUUID()}`,
      access_token_enc: params?.accessTokenEnc ?? "fixture-token",
      refresh_token_enc: null,
      expires_at: expiresAt,
      scopes: ["publish"],
      status: "active"
    })
    .select("id")
    .single();

  if (connectionError || !connection) {
    await workspaceFixture.cleanup();
    throw new Error(`Failed creating social connection fixture: ${connectionError?.message ?? "unknown error"}`);
  }

  const { data: post, error: postError } = await workspaceFixture.client
    .from("posts")
    .insert({
      workspace_id: workspaceFixture.workspaceId,
      author_user_id: workspaceFixture.userId,
      caption: "Phase 3 pipeline fixture",
      hashtags: ["phase3"],
      location: null,
      status: "draft",
      scheduled_for: null
    })
    .select("id")
    .single();

  if (postError || !post) {
    await workspaceFixture.cleanup();
    throw new Error(`Failed creating post fixture: ${postError?.message ?? "unknown error"}`);
  }

  const { data: target, error: targetError } = await workspaceFixture.client
    .from("post_targets")
    .insert({
      post_id: post.id,
      platform,
      connection_id: connection.id,
      payload_json: {
        caption: "Phase 3 post payload",
        hashtags: ["phase3"],
        location: null,
        mediaAssetIds: ["asset-fixture-1"],
        mediaStoragePaths: [`${workspaceFixture.workspaceId}/asset-fixture-1/post.png`]
      },
      status: "draft"
    })
    .select("id")
    .single();

  if (targetError || !target) {
    await workspaceFixture.cleanup();
    throw new Error(`Failed creating post target fixture: ${targetError?.message ?? "unknown error"}`);
  }

  return {
    ...workspaceFixture,
    postId: post.id as string,
    targetId: target.id as string,
    connectionId: connection.id as string
  } satisfies PublishPipelineFixture;
}
