// ensureYtDlp — return the path to a working yt-dlp binary, downloading the
// platform-correct standalone build from github releases on first use. these
// binaries have python bundled via pyinstaller, so the host doesn't need
// python (which `youtube-dl-exec`'s python zipapp does require).
//
// cache layout: <project_root>/.cache/yt-dlp/<version>/<asset_name>
// stable across server restarts. trigger an upgrade by bumping YT_DLP_VERSION.
//
// override the binary entirely with DONNA_YT_DLP_PATH=/path/to/yt-dlp.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// pin a version so behavior is reproducible. bump intentionally; check
// https://github.com/yt-dlp/yt-dlp/releases for the latest tag.
const YT_DLP_VERSION = "2026.03.17";

// project root: src/donna/extractors/ytdlp.ts → ../../../..
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CACHE_DIR = join(ROOT, ".cache", "yt-dlp", YT_DLP_VERSION);

interface Asset {
  name: string;
  // is this a binary we can chmod +x, or windows .exe (no chmod needed)
  unixChmod: boolean;
}

function pickAsset(): Asset {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    // universal binary, works on arm64 and x86_64
    return { name: "yt-dlp_macos", unixChmod: true };
  }
  if (platform === "linux") {
    // glibc-based distros. on alpine/musl, set DONNA_YT_DLP_PATH to a musl
    // build (yt-dlp_musllinux*) or to your own yt-dlp.
    if (arch === "x64") return { name: "yt-dlp_linux", unixChmod: true };
    if (arch === "arm64") return { name: "yt-dlp_linux_aarch64", unixChmod: true };
    throw new Error(`yt-dlp: no prebuilt binary for linux/${arch}. set DONNA_YT_DLP_PATH.`);
  }
  if (platform === "win32") {
    if (arch === "x64") return { name: "yt-dlp.exe", unixChmod: false };
    if (arch === "arm64") return { name: "yt-dlp_arm64.exe", unixChmod: false };
    if (arch === "ia32") return { name: "yt-dlp_x86.exe", unixChmod: false };
    throw new Error(`yt-dlp: unsupported win32 arch ${arch}. set DONNA_YT_DLP_PATH.`);
  }
  throw new Error(`yt-dlp: unsupported platform ${platform}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const tmp = `${dest}.partial`;
  // best-effort cleanup of any stale partial from a previous crashed download
  await unlink(tmp).catch(() => {});

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`yt-dlp download ${res.status} ${res.statusText} for ${url}`);
  }
  // Readable.fromWeb gives us a node stream we can pipe to disk efficiently
  const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, createWriteStream(tmp));
  await rename(tmp, dest);
}

// in-flight cache: if two extractions race on a cold cache they share one
// download instead of both fetching the binary.
let inflight: Promise<string> | null = null;

export async function ensureYtDlp(): Promise<string> {
  const override = process.env.DONNA_YT_DLP_PATH;
  if (override) {
    if (!(await exists(override))) {
      throw new Error(`DONNA_YT_DLP_PATH=${override} but file does not exist`);
    }
    return override;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    const asset = pickAsset();
    const target = join(CACHE_DIR, asset.name);

    if (await exists(target)) return target;

    await mkdir(CACHE_DIR, { recursive: true });
    const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${asset.name}`;
    await downloadTo(url, target);
    if (asset.unixChmod) {
      await chmod(target, 0o755);
    }

    // sanity check: the binary runs and reports a version. fail loudly if
    // download corrupted or platform mismatch slipped through.
    try {
      const { stdout } = await execFileAsync(target, ["--version"], { timeout: 15_000 });
      if (!stdout.trim()) throw new Error("yt-dlp --version produced empty output");
    } catch (err) {
      await unlink(target).catch(() => {});
      throw new Error(
        `yt-dlp self-check failed (${(err as Error).message}). cache cleared; will retry on next call.`,
      );
    }

    return target;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
