// persistence layer for extract_url. one row per (user_id, url).
// upsert semantics: re-extracting the same URL updates the latest data
// (so transcript backfill on a previously metadata-only row works).

import { getSql } from "../db.js";

export interface MediaExtractionRow {
  id: string;
  user_id: string;
  source: string;
  url: string;
  shortcode: string | null;
  author: string | null;
  author_name: string | null;
  caption: string | null;
  transcript: string | null;
  duration_sec: number | null;
  posted_at: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  thumbnail_url: string | null;
  video_path: string | null;
  supermemory_id: string | null;
  extracted_at: string;
}

export interface UpsertMediaExtractionInput {
  userId: string;
  source: string;
  url: string;
  shortcode?: string | null;
  author?: string | null;
  author_name?: string | null;
  caption?: string | null;
  transcript?: string | null;
  duration_sec?: number | null;
  posted_at?: string | null;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  thumbnail_url?: string | null;
  video_path?: string | null;
  supermemory_id?: string | null;
  raw?: unknown;
}

// upsert by (user_id, url). on conflict: refresh every field except the
// row id and extracted_at (we keep the original first-seen timestamp).
//
// COALESCE on a few fields would let a partial follow-up extraction (e.g.
// just-the-transcript) preserve earlier values — but a fresh extraction is
// authoritative so we overwrite. callers should pass a full snapshot.
export async function upsertMediaExtraction(
  input: UpsertMediaExtractionInput,
): Promise<MediaExtractionRow> {
  const sql = getSql();
  const rows = await sql<MediaExtractionRow[]>`
    insert into media_extractions (
      user_id, source, url, shortcode, author, author_name,
      caption, transcript, duration_sec, posted_at,
      view_count, like_count, comment_count, thumbnail_url,
      video_path, supermemory_id, raw
    ) values (
      ${input.userId}, ${input.source}, ${input.url},
      ${input.shortcode ?? null}, ${input.author ?? null}, ${input.author_name ?? null},
      ${input.caption ?? null}, ${input.transcript ?? null},
      ${input.duration_sec ?? null}, ${input.posted_at ?? null},
      ${input.view_count ?? null}, ${input.like_count ?? null},
      ${input.comment_count ?? null}, ${input.thumbnail_url ?? null},
      ${input.video_path ?? null}, ${input.supermemory_id ?? null},
      ${input.raw === undefined ? null : sql.json(input.raw as never)}
    )
    on conflict (user_id, url) do update set
      source = excluded.source,
      shortcode = excluded.shortcode,
      author = excluded.author,
      author_name = excluded.author_name,
      caption = excluded.caption,
      transcript = coalesce(excluded.transcript, media_extractions.transcript),
      duration_sec = excluded.duration_sec,
      posted_at = excluded.posted_at,
      view_count = excluded.view_count,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      thumbnail_url = excluded.thumbnail_url,
      video_path = coalesce(excluded.video_path, media_extractions.video_path),
      supermemory_id = coalesce(excluded.supermemory_id, media_extractions.supermemory_id),
      raw = excluded.raw
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error("upsertMediaExtraction: no row returned");
  return row;
}

export async function getMediaExtractionByUrl(
  userId: string,
  url: string,
): Promise<MediaExtractionRow | null> {
  const sql = getSql();
  const rows = await sql<MediaExtractionRow[]>`
    select * from media_extractions
    where user_id = ${userId} and url = ${url}
    limit 1
  `;
  return rows[0] ?? null;
}
