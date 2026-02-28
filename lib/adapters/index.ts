import type { Platform } from "../types";
import type { PlatformAdapter } from "./base";
import { MetaAdapter } from "./meta";
import { TikTokAdapter } from "./tiktok";

const adapterRegistry: Record<Platform, PlatformAdapter> = {
  instagram: new MetaAdapter("instagram"),
  facebook: new MetaAdapter("facebook"),
  tiktok: new TikTokAdapter()
};

export function getAdapter(platform: Platform): PlatformAdapter {
  return adapterRegistry[platform];
}
