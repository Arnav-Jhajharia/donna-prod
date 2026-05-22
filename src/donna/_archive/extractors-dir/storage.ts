// supabase storage upload for cached media files (instagram reels today).
// mirrors src/donna/calories/storage.ts — uses the REST endpoint directly so
// we don't pull in the supabase-js dep.
//
// bucket must be created in the supabase dashboard before use (private):
//   media_extractions
// override the name with SUPABASE_STORAGE_BUCKET_MEDIA_EXTRACTIONS.

import { readFile } from "node:fs/promises";

const DEFAULT_BUCKET = "media_extractions";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`storage: ${name} not set`);
  return v;
}

function bucket(): string {
  return process.env.SUPABASE_STORAGE_BUCKET_MEDIA_EXTRACTIONS ?? DEFAULT_BUCKET;
}

export async function uploadMediaFile(args: {
  userId: string;
  source: string; // e.g. "instagram_reel"
  shortcode: string | null;
  localPath: string;
  contentType?: string;
}): Promise<{ path: string }> {
  const bytes = await readFile(args.localPath);
  const ext = args.localPath.split(".").pop() ?? "mp4";
  const id = args.shortcode ?? Date.now().toString();
  const path = `${args.userId}/${args.source}/${id}.${ext}`;
  const url = `${need("SUPABASE_URL")}/storage/v1/object/${bucket()}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": args.contentType ?? "video/mp4",
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    throw new Error(
      `media storage upload ${path}: ${res.status} ${await res.text()}`,
    );
  }
  return { path };
}
