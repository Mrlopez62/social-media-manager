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

export function createServiceRoleClient() {
  const env = getDbEnv();

  if (!env.url || !env.serviceRoleKey) {
    throw new Error(
      "Missing DB test env vars. Set TEST_SUPABASE_URL/TEST_SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY."
    );
  }

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
  const { error } = await client.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 1024 * 1024 * 100
  });

  if (error && !error.message.toLowerCase().includes("already")) {
    throw new Error(`Failed to ensure media bucket ${bucketName}: ${error.message}`);
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
