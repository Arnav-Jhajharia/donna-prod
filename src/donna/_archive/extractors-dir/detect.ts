// url detection + classification. cheap, regex-only, no network.
//
// `detectUrls(text)` finds URLs in a free-form string and classifies each.
// `classifyUrl(url)` runs the same classifier on a single URL.
//
// adding a new platform: add a pattern to PATTERNS and (if extraction is
// non-trivial) an extractor in ../extractors/<name>.ts and dispatch in
// ./index.ts.

export type UrlKind =
  | "instagram_reel"
  | "instagram_post"
  | "instagram_story"
  | "youtube_video"
  | "youtube_shorts"
  | "twitter_status"
  | "tiktok_video"
  | "generic";

export interface DetectedUrl {
  url: string;
  kind: UrlKind;
  // platform-native id when extractable from the path (reel shortcode, video
  // id, status id, etc). best-effort; null when the path doesn't carry one.
  id: string | null;
}

// match URLs in text. permissive on protocol (http/https/bare). stops at
// whitespace, common closing punctuation, and quote/bracket pairs.
const URL_RE =
  /\b((?:https?:\/\/|www\.)[^\s<>"'`)\]]+|(?:instagr\.am|youtu\.be|vm\.tiktok\.com|t\.co)\/[^\s<>"'`)\]]+)/gi;

interface Pattern {
  kind: UrlKind;
  // host suffixes that qualify (e.g. "instagram.com" matches "www.instagram.com")
  hosts: string[];
  // path test. captured group 1 (if any) is the platform-native id.
  path: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    kind: "instagram_reel",
    hosts: ["instagram.com", "instagr.am"],
    path: /^\/reels?\/([A-Za-z0-9_-]+)/,
  },
  {
    kind: "instagram_post",
    hosts: ["instagram.com", "instagr.am"],
    path: /^\/p\/([A-Za-z0-9_-]+)/,
  },
  {
    kind: "instagram_story",
    hosts: ["instagram.com", "instagr.am"],
    path: /^\/stories\/[^/]+\/([0-9]+)/,
  },
  {
    kind: "youtube_shorts",
    hosts: ["youtube.com", "m.youtube.com"],
    path: /^\/shorts\/([A-Za-z0-9_-]{6,})/,
  },
  {
    kind: "youtube_video",
    hosts: ["youtube.com", "m.youtube.com"],
    path: /^\/watch/,
  },
  {
    kind: "youtube_video",
    hosts: ["youtu.be"],
    path: /^\/([A-Za-z0-9_-]{6,})/,
  },
  {
    kind: "twitter_status",
    hosts: ["twitter.com", "x.com", "mobile.twitter.com"],
    path: /^\/[^/]+\/status\/([0-9]+)/,
  },
  {
    kind: "tiktok_video",
    hosts: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    path: /^\/(?:@[^/]+\/video\/([0-9]+)|[A-Za-z0-9]+\/?$)/,
  },
];

function normalize(raw: string): string {
  let s = raw.trim();
  // strip trailing punctuation that often glues onto a URL in prose.
  s = s.replace(/[),.;:!?\]]+$/, "");
  if (s.startsWith("www.")) s = `https://${s}`;
  if (!/^https?:\/\//i.test(s)) {
    // bare hosts like instagr.am/... get https.
    s = `https://${s}`;
  }
  return s;
}

function hostMatches(actual: string, candidates: string[]): boolean {
  const h = actual.toLowerCase();
  return candidates.some((c) => h === c || h.endsWith(`.${c}`));
}

// youtube has its id in ?v= for /watch. handle separately.
function youtubeWatchId(u: URL): string | null {
  if (u.pathname !== "/watch") return null;
  return u.searchParams.get("v");
}

export function classifyUrl(raw: string): DetectedUrl {
  const url = normalize(raw);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url: raw, kind: "generic", id: null };
  }

  const host = parsed.hostname.toLowerCase();

  for (const p of PATTERNS) {
    if (!hostMatches(host, p.hosts)) continue;
    const m = parsed.pathname.match(p.path);
    if (!m) continue;
    let id = m[1] ?? null;
    if (p.kind === "youtube_video" && !id) id = youtubeWatchId(parsed);
    return { url, kind: p.kind, id };
  }

  // youtube /watch without our pattern hitting first — covers query-only ids.
  if (hostMatches(host, ["youtube.com", "m.youtube.com"])) {
    const id = youtubeWatchId(parsed);
    if (id) return { url, kind: "youtube_video", id };
  }

  return { url, kind: "generic", id: null };
}

export function detectUrls(text: string): DetectedUrl[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: DetectedUrl[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[1] ?? m[0];
    if (!raw) continue;
    const d = classifyUrl(raw);
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    out.push(d);
  }
  return out;
}
