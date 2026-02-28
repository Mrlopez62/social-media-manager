// @ts-nocheck
// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function:
// Claims queued publish jobs then executes each claimed job through internal worker endpoints.

type DispatchResponse = {
  data?: {
    claimedCount: number;
    lockToken: string;
    jobs: Array<{
      id: string;
      postId: string;
    }>;
  };
  error?: {
    code: string;
    message: string;
  };
};

type ExecuteResponse = {
  data?: {
    jobId: string;
    postId: string;
    status: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

const APP_BASE_URL = Deno.env.get("APP_BASE_URL") ?? "";
const INTERNAL_WORKER_TOKEN = Deno.env.get("INTERNAL_WORKER_TOKEN") ?? "";
const DISPATCH_LIMIT = Number(Deno.env.get("PUBLISH_DISPATCH_LIMIT") ?? "20");

function assertEnv() {
  if (!APP_BASE_URL) {
    throw new Error("Missing APP_BASE_URL.");
  }

  if (!INTERNAL_WORKER_TOKEN) {
    throw new Error("Missing INTERNAL_WORKER_TOKEN.");
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

async function callDispatch(runAtBefore?: string) {
  const response = await fetch(`${APP_BASE_URL}/internal/publish/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_WORKER_TOKEN
    },
    body: JSON.stringify({
      runAtBefore: runAtBefore ?? new Date().toISOString(),
      limit: DISPATCH_LIMIT
    })
  });

  const payload = (await response.json().catch(() => null)) as DispatchResponse | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? `Dispatch failed with ${response.status}.`);
  }

  return payload.data;
}

async function callExecute(jobId: string, lockToken: string) {
  const response = await fetch(`${APP_BASE_URL}/internal/publish/execute/${jobId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_WORKER_TOKEN
    },
    body: JSON.stringify({ lockToken })
  });

  const payload = (await response.json().catch(() => null)) as ExecuteResponse | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? `Execute failed for ${jobId} with ${response.status}.`);
  }

  return payload.data;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  try {
    assertEnv();
    const requestBody = (await req.json().catch(() => ({}))) as { runAtBefore?: string };
    const dispatch = await callDispatch(requestBody.runAtBefore);
    const results: Array<{ jobId: string; postId: string; status: string }> = [];

    for (const job of dispatch.jobs) {
      const executed = await callExecute(job.id, dispatch.lockToken);
      results.push({
        jobId: executed.jobId,
        postId: executed.postId,
        status: executed.status
      });
    }

    return jsonResponse({
      claimedCount: dispatch.claimedCount,
      executedCount: results.length,
      results
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduler run failed.";
    return jsonResponse({ error: message }, 500);
  }
});
