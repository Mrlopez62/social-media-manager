import { expect, test } from "@playwright/test";

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

function json(payload: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(payload)
  };
}

test("composer starts OAuth connect and disconnects an active connection", async ({ page }) => {
  let oauthStartCalls = 0;
  let disconnectCalls = 0;

  let connections: ConnectionItem[] = [
    {
      id: "conn-fb-1",
      platform: "facebook",
      accountId: "fb-account-1",
      status: "active",
      expiresAt: null
    }
  ];

  await page.route("**/api/connections", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill(
      json({
        data: {
          items: connections
        }
      })
    );
  });

  await page.route("**/api/connections/instagram/oauth/start", async (route) => {
    oauthStartCalls += 1;
    await route.fulfill(
      json({
        data: {
          platform: "instagram",
          authorizationUrl: "https://meta.example.com/oauth/instagram",
          expiresAt: "2030-01-01T00:00:00.000Z"
        }
      })
    );
  });

  await page.route("**/api/connections/conn-fb-1", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }

    disconnectCalls += 1;
    connections = [];
    await route.fulfill(
      json({
        data: {
          connection: {
            id: "conn-fb-1",
            platform: "facebook",
            accountId: "fb-account-1",
            status: "revoked",
            expiresAt: "2030-01-01T00:00:00.000Z"
          }
        }
      })
    );
  });

  await page.route("**/api/media", async (route) => {
    await route.fulfill(
      json({
        data: {
          items: []
        }
      })
    );
  });

  await page.route("**/api/posts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill(
      json({
        data: {
          items: []
        }
      })
    );
  });

  await page.goto("/composer");
  await expect(page.getByText("Composer Studio")).toBeVisible();
  await expect(page.getByText("fb-account-1")).toBeVisible();

  await page.getByRole("button", { name: "Connect Instagram" }).click();
  await expect(page.getByText("OAuth connect started for instagram. Open authorization URL to continue.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Instagram Authorization" })).toHaveAttribute(
    "href",
    "https://meta.example.com/oauth/instagram"
  );

  await page
    .getByRole("button", { name: "Disconnect facebook fb-account-1" })
    .click();
  await expect(page.getByText("Disconnected facebook fb-account-1.")).toBeVisible();
  await expect(page.getByText("No active connections. Connect Instagram/Facebook first.")).toBeVisible();

  expect(oauthStartCalls).toBe(1);
  expect(disconnectCalls).toBe(1);
});

test("composer uploads media through upload-url + storage PUT + complete flow", async ({ page }) => {
  let uploadUrlCalls = 0;
  let storagePutCalls = 0;
  let completeCalls = 0;

  const connections: ConnectionItem[] = [
    {
      id: "conn-ig-1",
      platform: "instagram",
      accountId: "ig-account-1",
      status: "active",
      expiresAt: null
    }
  ];

  let mediaItems: MediaItem[] = [];

  await page.route("**/api/connections", async (route) => {
    await route.fulfill(
      json({
        data: {
          items: connections
        }
      })
    );
  });

  await page.route("**/api/media", async (route) => {
    await route.fulfill(
      json({
        data: {
          items: mediaItems
        }
      })
    );
  });

  await page.route("**/api/posts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill(
      json({
        data: {
          items: []
        }
      })
    );
  });

  await page.route("**/api/media/upload-url", async (route) => {
    uploadUrlCalls += 1;
    await route.fulfill(
      json({
        data: {
          assetId: "asset-1",
          bucket: "media-assets",
          storagePath: "workspace-1/uploads/launch.jpg",
          token: "token-1",
          signedUrl: "/mock-storage/upload/asset-1",
          path: "workspace-1/uploads/launch.jpg"
        }
      })
    );
  });

  await page.route("**/mock-storage/upload/asset-1", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }

    storagePutCalls += 1;
    await route.fulfill({
      status: 200,
      body: ""
    });
  });

  await page.route("**/api/media/complete", async (route) => {
    completeCalls += 1;
    const body = route.request().postDataJSON() as {
      storagePath: string;
      mimeType: string;
      size: number;
      checksum: string;
    };

    mediaItems = [
      {
        id: "media-1",
        storagePath: body.storagePath,
        mimeType: body.mimeType,
        size: body.size,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    ];

    await route.fulfill(
      json({
        data: {
          mediaAsset: mediaItems[0]
        }
      })
    );
  });

  await page.goto("/composer");
  await expect(page.getByText("Composer Studio")).toBeVisible();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: "launch.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("mock image bytes")
  });

  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await expect(page.getByText("Uploaded launch.jpg successfully.")).toBeVisible();
  await expect(page.getByText("workspace-1/uploads/launch.jpg")).toBeVisible();

  expect(uploadUrlCalls).toBe(1);
  expect(storagePutCalls).toBe(1);
  expect(completeCalls).toBe(1);
});
