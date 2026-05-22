// extractor dispatcher. classify a URL, then route to the platform-specific
// extractor. unknown / not-yet-implemented kinds return a stub that still
// carries the classification so callers can branch on it.

import { classifyUrl, type DetectedUrl, type UrlKind } from "./detect.js";
import {
  extractInstagram,
  type InstagramExtraction,
  type InstagramExtractOptions,
} from "./instagram.js";

export interface NotImplementedExtraction {
  kind: Exclude<
    UrlKind,
    "instagram_reel" | "instagram_post" | "instagram_story"
  >;
  url: string;
  id: string | null;
  error: "not_implemented";
  details: string;
}

export type Extraction = InstagramExtraction | NotImplementedExtraction;

export type ExtractOptions = InstagramExtractOptions;

const NOT_YET: Record<NotImplementedExtraction["kind"], string> = {
  youtube_video: "youtube extraction not yet implemented; metadata only via yt-dlp coming soon",
  youtube_shorts: "youtube shorts extraction not yet implemented",
  twitter_status: "twitter/x extraction not yet implemented",
  tiktok_video: "tiktok extraction not yet implemented",
  generic: "generic url extraction not yet implemented; consider using an article reader",
};

export async function extractFromUrl(
  url: string,
  opts: ExtractOptions = {},
): Promise<Extraction> {
  const detected = classifyUrl(url);
  return extractDetected(detected, opts);
}

export async function extractDetected(
  detected: DetectedUrl,
  opts: ExtractOptions = {},
): Promise<Extraction> {
  switch (detected.kind) {
    case "instagram_reel":
    case "instagram_post":
    case "instagram_story":
      return extractInstagram(detected.url, detected.kind, detected.id, opts);
    case "youtube_video":
    case "youtube_shorts":
    case "twitter_status":
    case "tiktok_video":
    case "generic":
      return {
        kind: detected.kind,
        url: detected.url,
        id: detected.id,
        error: "not_implemented",
        details: NOT_YET[detected.kind],
      };
  }
}

export { classifyUrl, detectUrls } from "./detect.js";
export type { DetectedUrl, UrlKind } from "./detect.js";
export type { InstagramExtraction } from "./instagram.js";
