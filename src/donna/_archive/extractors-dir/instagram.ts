// instagram extractor. shells out to a project-local yt-dlp binary
// (auto-downloaded by ./ytdlp.ts) for metadata (and optionally video
// download), then sends the result to openai whisper for transcription.
//
// no system deps needed at runtime: the yt-dlp binary is fetched into
// .cache/yt-dlp/ on first use. transcription requires OPENAI_API_KEY.
//
// reels and posts only. stories require a logged-in session and are out of
// scope for v1. when transcription is requested but the post is image-only
// (no video stream) we silently skip and leave transcript=null.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureYtDlp } from "./ytdlp.js";

const execFileAsync = promisify(execFile);

const YT_DLP_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // openai hard limit
const MAX_TRANSCRIBE_DURATION_SEC = 600; // skip transcription past 10 min

export interface InstagramExtraction {
  kind: "instagram_reel" | "instagram_post" | "instagram_story";
  url: string;
  shortcode: string | null;
  author: string | null;     // @handle
  author_name: string | null; // display name
  caption: string | null;
  duration_sec: number | null;
  posted_at: string | null;   // iso8601
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  thumbnail_url: string | null;
  transcript: string | null;
  // supabase storage path for the cached video, when onVideo returned one.
  video_path: string | null;
  // populated when something failed but we still returned partial data.
  // error: surface-level reason; details: anything noisy from yt-dlp/whisper.
  error?: string;
  details?: string;
  // raw yt-dlp dump kept around so persistence can store it without us
  // re-running yt-dlp. omitted on error.
  raw?: unknown;
}

interface YtDlpJson {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  duration?: number;
  timestamp?: number;       // unix seconds
  upload_date?: string;     // YYYYMMDD
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  thumbnail?: string;
  webpage_url?: string;
  ext?: string;
  vcodec?: string;          // "none" for image posts
  // present when post has multiple media (carousel). first entry is what
  // yt-dlp returns at top level when --no-playlist isn't used.
  entries?: YtDlpJson[];
}

function isoFromTimestamp(ts: number | undefined): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString();
}

function isoFromUploadDate(d: string | undefined): string | null {
  if (!d || !/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00.000Z`;
}

async function ytDlpDumpJson(bin: string, url: string): Promise<YtDlpJson> {
  const { stdout } = await execFileAsync(
    bin,
    ["--dump-single-json", "--no-warnings", "--no-playlist", url],
    { timeout: YT_DLP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as YtDlpJson;
}

// download the best mp4 we can get into a temp dir. returns absolute path.
async function ytDlpDownload(bin: string, url: string, dir: string): Promise<string> {
  const template = join(dir, "%(id)s.%(ext)s");
  await execFileAsync(
    bin,
    [
      "--no-warnings",
      "--no-playlist",
      "-f", "mp4/bestvideo*+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", template,
      url,
    ],
    { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );
  // resolve actual filename via a follow-up dump (cheap, no re-download).
  const { stdout } = await execFileAsync(
    bin,
    ["--print", "filename", "-o", template, "--no-warnings", "--no-playlist", url],
    { timeout: YT_DLP_TIMEOUT_MS },
  );
  const filename = stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!filename) throw new Error("yt-dlp: could not resolve output filename");
  return filename;
}

async function whisperTranscribe(filePath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const st = await stat(filePath);
  if (st.size > WHISPER_MAX_BYTES) {
    throw new Error(`file too large for whisper (${st.size} > ${WHISPER_MAX_BYTES})`);
  }

  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filePath.split("/").pop() ?? "audio.mp4");
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whisper ${res.status}: ${body.slice(0, 500)}`);
  }
  const text = (await res.text()).trim();
  return text;
}

export interface InstagramExtractOptions {
  include_transcript?: boolean;
  // called when transcription succeeds and the mp4 still exists on disk.
  // the handler uses this hook to upload the file to supabase storage
  // before the extractor cleans up the tmpdir. return a video_path to
  // surface in the result. errors propagate to the caller's catch.
  onVideo?: (filePath: string) => Promise<{ video_path?: string | null }>;
}

export async function extractInstagram(
  url: string,
  kind: "instagram_reel" | "instagram_post" | "instagram_story",
  shortcode: string | null,
  opts: InstagramExtractOptions = {},
): Promise<InstagramExtraction> {
  const base: InstagramExtraction = {
    kind,
    url,
    shortcode,
    author: null,
    author_name: null,
    caption: null,
    duration_sec: null,
    posted_at: null,
    view_count: null,
    like_count: null,
    comment_count: null,
    thumbnail_url: null,
    transcript: null,
    video_path: null,
  };

  // 0. ensure yt-dlp is present (auto-downloads on first call).
  let bin: string;
  try {
    bin = await ensureYtDlp();
  } catch (err) {
    const e = err as { message?: string };
    return {
      ...base,
      error: "yt_dlp_unavailable",
      details: (e.message ?? "").slice(0, 1000),
    };
  }

  // 1. metadata.
  let meta: YtDlpJson;
  try {
    meta = await ytDlpDumpJson(bin, url);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      ...base,
      error: "yt_dlp_failed",
      details: (e.stderr ?? e.message ?? "").slice(0, 1000),
    };
  }

  const filled: InstagramExtraction = {
    ...base,
    shortcode: meta.id ?? shortcode,
    author: meta.uploader_id ? `@${meta.uploader_id.replace(/^@/, "")}` : null,
    author_name: meta.uploader ?? meta.channel ?? null,
    caption: meta.description ?? meta.title ?? null,
    duration_sec: typeof meta.duration === "number" ? meta.duration : null,
    posted_at: isoFromTimestamp(meta.timestamp) ?? isoFromUploadDate(meta.upload_date),
    view_count: meta.view_count ?? null,
    like_count: meta.like_count ?? null,
    comment_count: meta.comment_count ?? null,
    thumbnail_url: meta.thumbnail ?? null,
    transcript: null,
    raw: meta,
  };

  // 2. transcript (optional).
  if (!opts.include_transcript) return filled;

  // image-only post (no video stream) — nothing to transcribe.
  if (meta.vcodec === "none") return filled;

  // too long — skip transcription. caller can re-call with the file or chunk.
  if (filled.duration_sec !== null && filled.duration_sec > MAX_TRANSCRIBE_DURATION_SEC) {
    return {
      ...filled,
      error: "duration_exceeded",
      details: `video is ${filled.duration_sec}s, transcription cap is ${MAX_TRANSCRIBE_DURATION_SEC}s`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "donna-ig-"));
  try {
    const file = await ytDlpDownload(bin, url, dir);
    const transcript = await whisperTranscribe(file);
    // hand the file to the caller before we delete it. storage upload lives
    // here so the extractor stays the only owner of the tmp lifecycle.
    let video_path: string | null = null;
    if (opts.onVideo) {
      try {
        const r = await opts.onVideo(file);
        video_path = r.video_path ?? null;
      } catch (uploadErr) {
        // don't fail the whole extraction just because storage hiccuped —
        // we still have the transcript, which is the more useful artifact.
        const e = uploadErr as { message?: string };
        console.warn(`[instagram] onVideo failed: ${(e.message ?? "").slice(0, 200)}`);
      }
    }
    return { ...filled, transcript, video_path };
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    return {
      ...filled,
      error: "transcription_failed",
      details: (e.stderr ?? e.message ?? "").slice(0, 1000),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
