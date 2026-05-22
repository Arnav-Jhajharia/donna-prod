-- media_extractions: persisted output of the extract_url tool.
-- one row per (user, url). transcript + caption + metadata so future turns
-- can recall what the user has shared without re-fetching from the source
-- (and IG/YT links rot — posts get deleted, accounts go private).
--
-- video_path: optional supabase storage path to the cached mp4. populated
-- only when the extraction included a download (include_transcript=true).

create table if not exists media_extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  source text not null,
  url text not null,
  shortcode text,
  author text,
  author_name text,
  caption text,
  transcript text,
  duration_sec int,
  posted_at timestamptz,
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  thumbnail_url text,
  video_path text,
  supermemory_id text,
  raw jsonb,
  extracted_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists media_extractions_user_extracted_idx
  on media_extractions (user_id, extracted_at desc);

create index if not exists media_extractions_user_source_idx
  on media_extractions (user_id, source);
