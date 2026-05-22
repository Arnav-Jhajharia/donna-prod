// extract_url — ptc-callable. given a URL, classify it and pull the
// human-readable content. v1 implements instagram (reel/post) end-to-end
// with optional whisper transcription; other platforms return a structured
// "not_implemented" so claude can fall back gracefully.
//
// successful extractions are persisted to media_extractions (one row per
// user, url). when include_transcript=true and a video stream exists, the
// mp4 is also uploaded to supabase storage and the path saved alongside.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import {
  classifyUrl,
  extractDetected,
  type Extraction,
} from "../extractors/index.js";
import type { InstagramExtraction } from "../extractors/instagram.js";
import { uploadMediaFile } from "../extractors/storage.js";
import { upsertMediaExtraction } from "../memory/media.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface ExtractUrlInput {
  url?: string;
  include_transcript?: boolean;
}

export const extractUrlTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "extract_url",
  description: `pull the human-readable content of a URL and persist it for later recall.

classifies the URL (instagram_reel | instagram_post | instagram_story | youtube_video | youtube_shorts | twitter_status | tiktok_video | generic) and routes to the right extractor.

implemented end-to-end today: instagram reels and posts.
  - metadata: author (@handle), display name, caption, posted_at, view/like/comment counts, duration, thumbnail.
  - if include_transcript=true and the post has a video stream ≤10min: downloads the mp4, runs whisper for transcript text, and uploads the mp4 to supabase storage so the cached file survives if the IG post is deleted later.
  - failure modes are reported via { error, details } while preserving any partial fields.

persistence: successful extractions are written to media_extractions (unique on user+url). you don't need to do this — it happens after every successful call.

other kinds return { kind, url, id, error:"not_implemented", details:"..." } so you can still tell the user what the link is without claiming you read it.

typically called inside code_execution. fan out multiple URLs with asyncio.gather. then summarize naturally in send_burst — never paste captions or transcripts verbatim.`,
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "the URL to extract. required.",
      },
      include_transcript: {
        type: "boolean",
        description: "if true and the post has a video stream, download, transcribe with whisper, and archive the mp4. default false (metadata only — fast and cheap).",
      },
    },
    required: ["url"],
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [
    { url: "https://www.instagram.com/reel/CxYZabc123/" },
    { url: "https://www.instagram.com/reel/CxYZabc123/", include_transcript: true },
    { url: "https://www.instagram.com/p/Dabc456XYZ/" },
  ],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

function isInstagram(e: Extraction): e is InstagramExtraction {
  return (
    e.kind === "instagram_reel" ||
    e.kind === "instagram_post" ||
    e.kind === "instagram_story"
  );
}

export async function extractUrlHandler(input: unknown): Promise<Extraction> {
  const { url, include_transcript } = (input ?? {}) as ExtractUrlInput;
  if (!url || typeof url !== "string") {
    throw new Error("extract_url: url required");
  }

  const ctx = getTurnContext();
  const detected = classifyUrl(url);

  // for instagram with transcript requested, set up the onVideo callback so
  // the extractor can hand us the downloaded mp4 just before cleanup.
  const onVideo = isInstagramKind(detected.kind) && include_transcript
    ? async (filePath: string) => {
        try {
          const r = await uploadMediaFile({
            userId: ctx.userId,
            source: detected.kind,
            shortcode: detected.id,
            localPath: filePath,
          });
          return { video_path: r.path };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[extract_url] storage upload failed: ${msg.slice(0, 200)}`);
          return { video_path: null };
        }
      }
    : undefined;

  const result = await extractDetected(detected, {
    include_transcript: Boolean(include_transcript),
    onVideo,
  });

  // only persist instagram successes — not_implemented stubs aren't useful
  // to recall, and errors are already noisy without us indexing them.
  if (isInstagram(result) && !result.error) {
    await persistInstagram(ctx.userId, result).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[extract_url] persist failed: ${msg.slice(0, 200)}`);
    });
  }

  return result;
}

function isInstagramKind(
  kind: ReturnType<typeof classifyUrl>["kind"],
): boolean {
  return (
    kind === "instagram_reel" ||
    kind === "instagram_post" ||
    kind === "instagram_story"
  );
}

async function persistInstagram(
  userId: string,
  e: InstagramExtraction,
): Promise<void> {
  await upsertMediaExtraction({
    userId,
    source: e.kind,
    url: e.url,
    shortcode: e.shortcode,
    author: e.author,
    author_name: e.author_name,
    caption: e.caption,
    transcript: e.transcript,
    duration_sec: e.duration_sec === null ? null : Math.round(e.duration_sec),
    posted_at: e.posted_at,
    view_count: e.view_count,
    like_count: e.like_count,
    comment_count: e.comment_count,
    thumbnail_url: e.thumbnail_url,
    video_path: e.video_path,
    supermemory_id: null,
    raw: e.raw,
  });
}
