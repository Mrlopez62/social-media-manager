"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ApiEnvelope<T> = {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type ConnectionItem = {
  id: string;
  platform: "instagram" | "facebook" | "tiktok";
  accountId: string;
  status: string;
  expiresAt: string | null;
};

type MediaItem = {
  id: string;
  storagePath: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

type PostItem = {
  id: string;
  caption: string;
  hashtags: string[];
  location: string | null;
  status: string;
  scheduledFor: string | null;
  createdAt: string;
  targets: Array<{
    id: string;
    platform: string;
    connectionId: string;
  }>;
};

type CapabilityWarning = {
  connectionId: string;
  platform: string;
  messages: string[];
};

type SaveResponse = {
  post: {
    id: string;
    caption: string;
    hashtags: string[];
    location: string | null;
    status: string;
    scheduledFor: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
  targets: Array<{
    id: string;
    platform: string;
    connectionId: string;
  }>;
  capabilityWarnings: CapabilityWarning[];
};

type UploadUrlResponse = {
  assetId: string;
  bucket: string;
  storagePath: string;
  token: string;
  signedUrl: string;
  path: string;
};

type CompleteUploadResponse = {
  mediaAsset: MediaItem;
};

type OAuthStartResponse = {
  platform: "instagram" | "facebook" | "tiktok";
  authorizationUrl: string;
  expiresAt: string;
};

type DisconnectResponse = {
  connection: {
    id: string;
    platform: "instagram" | "facebook" | "tiktok";
    accountId: string;
    status: string;
    expiresAt: string | null;
  };
};

type ComposerState = {
  caption: string;
  hashtagsInput: string;
  location: string;
  scheduledForLocal: string;
};

const pageBackground =
  "radial-gradient(circle at 8% 8%, rgba(20,184,166,0.2), transparent 35%), radial-gradient(circle at 92% 12%, rgba(59,130,246,0.17), transparent 34%), linear-gradient(180deg, #f7fbff 0%, #f4f7fb 55%, #f5fffb 100%)";

function toLocalDateTimeInputValue(iso: string | null) {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function toIsoDateTime(value: string) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parseHashtags(input: string) {
  const tokens = input
    .split(/[\s,]+/g)
    .map((token) => token.trim().replace(/^#+/, ""))
    .filter(Boolean);

  const deduped = [...new Set(tokens.map((token) => token.toLowerCase()))];
  return deduped;
}

function bytesToHuman(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(file: File) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is unavailable in this browser.");
  }

  const hash = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return toHex(hash);
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
  }

  if (!payload.data) {
    throw new Error("Missing response payload.");
  }

  return payload.data;
}

export function ComposerStudio() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [replaceMediaOnUpdate, setReplaceMediaOnUpdate] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [form, setForm] = useState<ComposerState>({
    caption: "",
    hashtagsInput: "",
    location: "",
    scheduledForLocal: ""
  });
  const [capabilityWarnings, setCapabilityWarnings] = useState<CapabilityWarning[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [connectingPlatform, setConnectingPlatform] = useState<"instagram" | "facebook" | null>(null);
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<string | null>(null);
  const [oauthStart, setOauthStart] = useState<OAuthStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const activeConnections = useMemo(
    () => connections.filter((connection) => connection.status === "active"),
    [connections]
  );

  const selectedPost = useMemo(
    () => posts.find((post) => post.id === selectedPostId) ?? null,
    [posts, selectedPostId]
  );

  const loadInitialData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [connectionsResponse, mediaResponse, postsResponse] = await Promise.all([
        request<{ items: ConnectionItem[] }>("/api/connections"),
        request<{ items: MediaItem[] }>("/api/media"),
        request<{ items: PostItem[] }>("/api/posts")
      ]);

      setConnections(connectionsResponse.items);
      setMediaItems(mediaResponse.items);
      setPosts(postsResponse.items.filter((post) => post.status === "draft" || post.status === "scheduled"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load composer data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  const resetForm = useCallback(() => {
    setSelectedPostId(null);
    setSelectedConnectionIds([]);
    setSelectedMediaIds([]);
    setReplaceMediaOnUpdate(false);
    setUploadFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setForm({
      caption: "",
      hashtagsInput: "",
      location: "",
      scheduledForLocal: ""
    });
    setCapabilityWarnings([]);
    setOauthStart(null);
    setSuccess(null);
    setError(null);
  }, []);

  const hydrateFormFromPost = useCallback(
    (post: PostItem | null) => {
      if (!post) {
        return;
      }

      setSelectedConnectionIds(post.targets.map((target) => target.connectionId));
      setForm({
        caption: post.caption,
        hashtagsInput: post.hashtags.map((tag) => `#${tag}`).join(" "),
        location: post.location ?? "",
        scheduledForLocal: toLocalDateTimeInputValue(post.scheduledFor)
      });
      setCapabilityWarnings([]);
      setSuccess(`Loaded draft ${post.id.slice(0, 8)} for editing.`);
      setError(null);
    },
    []
  );

  useEffect(() => {
    if (!selectedPost) {
      return;
    }

    hydrateFormFromPost(selectedPost);
  }, [hydrateFormFromPost, selectedPost]);

  const toggleConnection = useCallback((id: string) => {
    setSelectedConnectionIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]
    );
  }, []);

  const toggleMedia = useCallback((id: string) => {
    setSelectedMediaIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]
    );
  }, []);

  const submitCreate = useCallback(async () => {
    if (selectedConnectionIds.length === 0 || selectedMediaIds.length === 0) {
      setError("Select at least one active connection and one media asset.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const payload = {
        caption: form.caption,
        hashtags: parseHashtags(form.hashtagsInput),
        location: form.location.trim() ? form.location.trim() : null,
        targetConnectionIds: selectedConnectionIds,
        mediaAssetIds: selectedMediaIds,
        scheduledFor: toIsoDateTime(form.scheduledForLocal)
      };

      const saved = await request<SaveResponse>("/api/posts", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      setCapabilityWarnings(saved.capabilityWarnings ?? []);
      setSuccess(`Draft ${saved.post.id.slice(0, 8)} saved (${saved.post.status}).`);
      setSelectedPostId(saved.post.id);
      await loadInitialData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create draft.");
    } finally {
      setSaving(false);
    }
  }, [form, loadInitialData, selectedConnectionIds, selectedMediaIds]);

  const submitUpdate = useCallback(async () => {
    if (!selectedPostId) {
      setError("Choose an existing draft to update.");
      return;
    }

    if (selectedConnectionIds.length === 0) {
      setError("Select at least one target connection.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const payload: Record<string, unknown> = {
        caption: form.caption,
        hashtags: parseHashtags(form.hashtagsInput),
        location: form.location.trim() ? form.location.trim() : null,
        targetConnectionIds: selectedConnectionIds,
        scheduledFor: toIsoDateTime(form.scheduledForLocal)
      };

      if (replaceMediaOnUpdate) {
        if (selectedMediaIds.length === 0) {
          setError("Choose at least one media asset before replacing media on update.");
          setSaving(false);
          return;
        }

        payload.mediaAssetIds = selectedMediaIds;
      }

      const saved = await request<SaveResponse>(`/api/posts/${selectedPostId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });

      setCapabilityWarnings(saved.capabilityWarnings ?? []);
      setSuccess(`Draft ${saved.post.id.slice(0, 8)} updated (${saved.post.status}).`);
      await loadInitialData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to update draft.");
    } finally {
      setSaving(false);
    }
  }, [
    form,
    loadInitialData,
    replaceMediaOnUpdate,
    selectedConnectionIds,
    selectedMediaIds,
    selectedPostId
  ]);

  const submitMediaUpload = useCallback(async () => {
    if (!uploadFile) {
      setError("Choose a media file first.");
      return;
    }

    if (uploadFile.size > 1024 * 1024 * 100) {
      setError("Selected file exceeds 100 MB limit.");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);

    try {
      const mimeType = uploadFile.type || "application/octet-stream";
      const uploadTarget = await request<UploadUrlResponse>("/api/media/upload-url", {
        method: "POST",
        body: JSON.stringify({
          fileName: uploadFile.name,
          mimeType,
          size: uploadFile.size
        })
      });

      const uploadResponse = await fetch(uploadTarget.signedUrl, {
        method: "PUT",
        headers: {
          "content-type": mimeType
        },
        body: uploadFile
      });

      if (!uploadResponse.ok) {
        throw new Error(`Storage upload failed (${uploadResponse.status}).`);
      }

      const checksum = await sha256Hex(uploadFile);
      const completed = await request<CompleteUploadResponse>("/api/media/complete", {
        method: "POST",
        body: JSON.stringify({
          storagePath: uploadTarget.storagePath,
          mimeType,
          size: uploadFile.size,
          checksum
        })
      });

      setSelectedMediaIds((current) =>
        current.includes(completed.mediaAsset.id) ? current : [completed.mediaAsset.id, ...current]
      );
      setUploadFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setSuccess(`Uploaded ${uploadFile.name} successfully.`);
      await loadInitialData();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Media upload failed.");
    } finally {
      setUploading(false);
    }
  }, [loadInitialData, uploadFile]);

  const startConnectionOAuth = useCallback(async (platform: "instagram" | "facebook") => {
    setConnectingPlatform(platform);
    setError(null);
    setSuccess(null);

    try {
      const started = await request<OAuthStartResponse>(`/api/connections/${platform}/oauth/start`, {
        method: "POST"
      });
      setOauthStart(started);
      setSuccess(`OAuth connect started for ${platform}. Open authorization URL to continue.`);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : `Failed to start ${platform} OAuth.`);
    } finally {
      setConnectingPlatform(null);
    }
  }, []);

  const disconnectConnection = useCallback(
    async (connection: ConnectionItem) => {
      setDisconnectingConnectionId(connection.id);
      setError(null);
      setSuccess(null);

      try {
        const disconnected = await request<DisconnectResponse>(`/api/connections/${connection.id}`, {
          method: "DELETE"
        });
        setSelectedConnectionIds((current) =>
          current.filter((connectionId) => connectionId !== disconnected.connection.id)
        );
        setSuccess(
          `Disconnected ${disconnected.connection.platform} ${disconnected.connection.accountId}.`
        );
        await loadInitialData();
      } catch (disconnectError) {
        setError(
          disconnectError instanceof Error
            ? disconnectError.message
            : `Failed to disconnect ${connection.platform}.`
        );
      } finally {
        setDisconnectingConnectionId(null);
      }
    },
    [loadInitialData]
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        background: pageBackground,
        fontFamily: "\"Space Grotesk\", \"Avenir Next\", \"Segoe UI\", sans-serif",
        color: "#0f172a",
        padding: "28px 18px 48px"
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 18
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 32, letterSpacing: "-0.02em" }}>Composer Studio</h1>
            <p style={{ margin: "6px 0 0", color: "#475569" }}>
              Create and edit drafts with platform capability warnings before publish.
            </p>
          </div>
          <Link
            href="/"
            style={{
              textDecoration: "none",
              fontWeight: 600,
              color: "#0f766e",
              border: "1px solid #99f6e4",
              background: "#f0fdfa",
              padding: "8px 12px",
              borderRadius: 10
            }}
          >
            Open Delivery Console
          </Link>
        </header>

        {error ? (
          <div
            style={{
              marginBottom: 12,
              border: "1px solid #fecaca",
              background: "#fff1f2",
              color: "#9f1239",
              borderRadius: 10,
              padding: "10px 12px"
            }}
          >
            {error}
          </div>
        ) : null}
        {success ? (
          <div
            style={{
              marginBottom: 12,
              border: "1px solid #bbf7d0",
              background: "#f0fdf4",
              color: "#14532d",
              borderRadius: 10,
              padding: "10px 12px"
            }}
          >
            {success}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
            gap: 16
          }}
        >
          <section
            style={{
              border: "1px solid #dbeafe",
              borderRadius: 14,
              background: "rgba(255,255,255,0.9)",
              padding: 14
            }}
          >
            <h2 style={{ margin: "2px 0 10px", fontSize: 19 }}>Draft</h2>
            <label style={{ display: "block", marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: "#334155", marginBottom: 4 }}>Caption</div>
              <textarea
                value={form.caption}
                onChange={(event) => setForm((current) => ({ ...current, caption: event.target.value }))}
                rows={6}
                placeholder="Write your post caption..."
                style={{
                  width: "100%",
                  resize: "vertical",
                  border: "1px solid #cbd5e1",
                  borderRadius: 10,
                  padding: "10px 11px",
                  font: "inherit"
                }}
              />
            </label>

            <label style={{ display: "block", marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: "#334155", marginBottom: 4 }}>Hashtags</div>
              <input
                value={form.hashtagsInput}
                onChange={(event) => setForm((current) => ({ ...current, hashtagsInput: event.target.value }))}
                placeholder="#launch #mvp #social"
                style={{
                  width: "100%",
                  border: "1px solid #cbd5e1",
                  borderRadius: 10,
                  padding: "9px 11px",
                  font: "inherit"
                }}
              />
            </label>

            <label style={{ display: "block", marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: "#334155", marginBottom: 4 }}>Location (optional)</div>
              <input
                value={form.location}
                onChange={(event) => setForm((current) => ({ ...current, location: event.target.value }))}
                placeholder="Austin, TX"
                style={{
                  width: "100%",
                  border: "1px solid #cbd5e1",
                  borderRadius: 10,
                  padding: "9px 11px",
                  font: "inherit"
                }}
              />
            </label>

            <label style={{ display: "block", marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#334155", marginBottom: 4 }}>Scheduled for (optional)</div>
              <input
                type="datetime-local"
                value={form.scheduledForLocal}
                onChange={(event) =>
                  setForm((current) => ({ ...current, scheduledForLocal: event.target.value }))
                }
                style={{
                  width: "100%",
                  border: "1px solid #cbd5e1",
                  borderRadius: 10,
                  padding: "9px 11px",
                  font: "inherit"
                }}
              />
            </label>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={() => void submitCreate()}
                disabled={saving || loading || uploading}
                style={{
                  border: "1px solid #1d4ed8",
                  background: "#1d4ed8",
                  color: "white",
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontWeight: 600,
                  cursor: saving || uploading ? "not-allowed" : "pointer"
                }}
              >
                Save New Draft
              </button>
              <button
                type="button"
                onClick={() => void submitUpdate()}
                disabled={saving || loading || uploading || !selectedPostId}
                style={{
                  border: "1px solid #0f766e",
                  background: "#0f766e",
                  color: "white",
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontWeight: 600,
                  cursor: saving || uploading || !selectedPostId ? "not-allowed" : "pointer"
                }}
              >
                Update Selected Draft
              </button>
              <button
                type="button"
                onClick={resetForm}
                disabled={saving || uploading}
                style={{
                  border: "1px solid #94a3b8",
                  background: "#f8fafc",
                  color: "#334155",
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontWeight: 600,
                  cursor: saving || uploading ? "not-allowed" : "pointer"
                }}
              >
                Clear
              </button>
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dbeafe",
              borderRadius: 14,
              background: "rgba(255,255,255,0.9)",
              padding: 14
            }}
          >
            <h2 style={{ margin: "2px 0 10px", fontSize: 19 }}>Targets</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button
                type="button"
                onClick={() => void startConnectionOAuth("instagram")}
                disabled={
                  loading ||
                  saving ||
                  uploading ||
                  connectingPlatform !== null ||
                  disconnectingConnectionId !== null
                }
                style={{
                  border: "1px solid #1d4ed8",
                  background: connectingPlatform === "instagram" ? "#93c5fd" : "#1d4ed8",
                  color: "white",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontWeight: 600,
                  cursor:
                    loading ||
                    saving ||
                    uploading ||
                    connectingPlatform !== null ||
                    disconnectingConnectionId !== null
                      ? "not-allowed"
                      : "pointer"
                }}
              >
                {connectingPlatform === "instagram" ? "Starting..." : "Connect Instagram"}
              </button>
              <button
                type="button"
                onClick={() => void startConnectionOAuth("facebook")}
                disabled={
                  loading ||
                  saving ||
                  uploading ||
                  connectingPlatform !== null ||
                  disconnectingConnectionId !== null
                }
                style={{
                  border: "1px solid #0f766e",
                  background: connectingPlatform === "facebook" ? "#5eead4" : "#0f766e",
                  color: "white",
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontWeight: 600,
                  cursor:
                    loading ||
                    saving ||
                    uploading ||
                    connectingPlatform !== null ||
                    disconnectingConnectionId !== null
                      ? "not-allowed"
                      : "pointer"
                }}
              >
                {connectingPlatform === "facebook" ? "Starting..." : "Connect Facebook"}
              </button>
              {oauthStart ? (
                <a
                  href={oauthStart.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    alignSelf: "center",
                    fontSize: 13,
                    color: "#0f766e",
                    textDecoration: "underline"
                  }}
                >
                  Open {oauthStart.platform.charAt(0).toUpperCase()}
                  {oauthStart.platform.slice(1)} Authorization
                </a>
              ) : null}
            </div>
            {loading ? <p>Loading connections...</p> : null}
            {!loading && activeConnections.length === 0 ? (
              <p style={{ color: "#475569" }}>No active connections. Connect Instagram/Facebook first.</p>
            ) : null}
            <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
              {activeConnections.map((connection) => {
                const checked = selectedConnectionIds.includes(connection.id);
                return (
                  <div
                    key={connection.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      border: checked ? "1px solid #2dd4bf" : "1px solid #e2e8f0",
                      borderRadius: 10,
                      padding: "7px 9px",
                      background: checked ? "#f0fdfa" : "white",
                      justifyContent: "space-between"
                    }}
                  >
                    <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleConnection(connection.id)}
                      />
                      <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{connection.platform}</span>
                      <span style={{ color: "#64748b", fontSize: 13 }}>{connection.accountId}</span>
                    </label>
                    <button
                      type="button"
                      aria-label={`Disconnect ${connection.platform} ${connection.accountId}`}
                      onClick={() => void disconnectConnection(connection)}
                      disabled={
                        disconnectingConnectionId !== null ||
                        connectingPlatform !== null ||
                        loading ||
                        saving ||
                        uploading
                      }
                      style={{
                        border: "1px solid #b91c1c",
                        background:
                          disconnectingConnectionId === connection.id ? "#fca5a5" : "#b91c1c",
                        color: "white",
                        borderRadius: 8,
                        padding: "6px 8px",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor:
                          disconnectingConnectionId !== null ||
                          connectingPlatform !== null ||
                          loading ||
                          saving ||
                          uploading
                            ? "not-allowed"
                            : "pointer"
                      }}
                    >
                      {disconnectingConnectionId === connection.id ? "Disconnecting..." : "Disconnect"}
                    </button>
                  </div>
                );
              })}
            </div>

            <h2 style={{ margin: "0 0 8px", fontSize: 19 }}>Media</h2>
            <div
              style={{
                border: "1px dashed #bfdbfe",
                borderRadius: 10,
                padding: "10px 11px",
                marginBottom: 12,
                background: "#f8fbff"
              }}
            >
              <label style={{ display: "block", marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: "#334155", marginBottom: 4 }}>Upload new media</div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  disabled={uploading || saving}
                  onChange={(event) => setUploadFile(event.currentTarget.files?.[0] ?? null)}
                  style={{
                    width: "100%"
                  }}
                />
              </label>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12, color: "#64748b", overflowWrap: "anywhere" }}>
                  {uploadFile ? `${uploadFile.name} (${bytesToHuman(uploadFile.size)})` : "Max 100 MB"}
                </span>
                <button
                  type="button"
                  disabled={!uploadFile || uploading || saving}
                  onClick={() => void submitMediaUpload()}
                  style={{
                    border: "1px solid #2563eb",
                    background: uploading ? "#93c5fd" : "#2563eb",
                    color: "white",
                    borderRadius: 8,
                    padding: "6px 10px",
                    fontWeight: 600,
                    cursor: !uploadFile || uploading || saving ? "not-allowed" : "pointer"
                  }}
                >
                  {uploading ? "Uploading..." : "Upload"}
                </button>
              </div>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={replaceMediaOnUpdate}
                onChange={(event) => setReplaceMediaOnUpdate(event.target.checked)}
              />
              <span style={{ fontSize: 13, color: "#334155" }}>
                Replace media when updating selected draft
              </span>
            </label>
            {loading ? <p>Loading media...</p> : null}
            {!loading && mediaItems.length === 0 ? (
              <p style={{ color: "#475569" }}>No media assets found. Upload media from the API first.</p>
            ) : null}
            <div style={{ maxHeight: 360, overflow: "auto", display: "grid", gap: 8 }}>
              {mediaItems.map((media) => {
                const checked = selectedMediaIds.includes(media.id);
                return (
                  <label
                    key={media.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      border: checked ? "1px solid #1d4ed8" : "1px solid #e2e8f0",
                      borderRadius: 10,
                      padding: "7px 9px",
                      background: checked ? "#eff6ff" : "white"
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleMedia(media.id)} />
                    <span style={{ fontSize: 12, color: "#334155", overflowWrap: "anywhere", flex: 1 }}>
                      {media.storagePath}
                    </span>
                    <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
                      {bytesToHuman(media.size)}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section
            style={{
              border: "1px solid #dbeafe",
              borderRadius: 14,
              background: "rgba(255,255,255,0.9)",
              padding: 14
            }}
          >
            <h2 style={{ margin: "2px 0 10px", fontSize: 19 }}>Existing Drafts</h2>
            {loading ? <p>Loading drafts...</p> : null}
            {!loading && posts.length === 0 ? (
              <p style={{ color: "#475569" }}>No drafts yet.</p>
            ) : null}
            <div style={{ maxHeight: 300, overflow: "auto", display: "grid", gap: 8 }}>
              {posts.map((post) => {
                const selected = selectedPostId === post.id;
                return (
                  <button
                    key={post.id}
                    type="button"
                    onClick={() => setSelectedPostId(post.id)}
                    style={{
                      textAlign: "left",
                      border: selected ? "2px solid #0f766e" : "1px solid #dbeafe",
                      borderRadius: 10,
                      padding: "8px 10px",
                      background: selected ? "#f0fdfa" : "white",
                      cursor: "pointer"
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{post.caption || "(empty caption)"}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      {post.status} • {post.targets.length} target(s)
                    </div>
                  </button>
                );
              })}
            </div>

            <h2 style={{ margin: "16px 0 10px", fontSize: 19 }}>Capability Warnings</h2>
            {capabilityWarnings.length === 0 ? (
              <p style={{ color: "#475569" }}>No warnings on last save.</p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {capabilityWarnings.map((warning) => (
                  <div
                    key={`${warning.connectionId}-${warning.platform}`}
                    style={{
                      border: "1px solid #fde68a",
                      background: "#fffbeb",
                      borderRadius: 10,
                      padding: "8px 10px"
                    }}
                  >
                    <div style={{ fontWeight: 700, textTransform: "capitalize", marginBottom: 4 }}>
                      {warning.platform} ({warning.connectionId.slice(0, 8)})
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "#92400e" }}>
                      {warning.messages.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
