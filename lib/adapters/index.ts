import type { Platform } from "../types.ts";
import type { PlatformAdapter } from "./base.ts";
import { MetaAdapter } from "./meta.ts";
import { TikTokAdapter } from "./tiktok.ts";

const adapterRegistry: Record<Platform, PlatformAdapter> = {
  instagram: new MetaAdapter("instagram"),
  facebook: new MetaAdapter("facebook"),
  tiktok: new TikTokAdapter()
};

export function getAdapter(platform: Platform): PlatformAdapter {
  return adapterRegistry[platform];
}
