// merchant canonicalization. small seed map for the most common patterns;
// unknown merchants fall through with the raw string title-cased.
//
// the goal isn't perfection — just enough to not split "Netflix" / "NETFLIX.COM" /
// "Netflix US LLC" into 3 rows. user can run subscriptions_merge for misses.

interface CanonicalRule {
  // case-insensitive substring match against the merchant_raw string
  match: string;
  canonical: string;
  category?: string;
}

// hand-curated. order matters — first match wins. add to this as we see misses.
const SEED_MAP: CanonicalRule[] = [
  // streaming
  { match: "netflix",     canonical: "Netflix",          category: "entertainment" },
  { match: "spotify",     canonical: "Spotify",          category: "entertainment" },
  { match: "youtube",     canonical: "YouTube Premium",  category: "entertainment" },
  { match: "hbo",         canonical: "HBO Max",          category: "entertainment" },
  { match: "disney",      canonical: "Disney+",          category: "entertainment" },
  { match: "hulu",        canonical: "Hulu",             category: "entertainment" },
  { match: "apple music", canonical: "Apple Music",      category: "entertainment" },
  { match: "apple tv",    canonical: "Apple TV+",        category: "entertainment" },
  { match: "audible",     canonical: "Audible",          category: "entertainment" },

  // ai / dev tooling
  { match: "openai",      canonical: "OpenAI",           category: "ai" },
  { match: "anthropic",   canonical: "Anthropic",        category: "ai" },
  { match: "claude",      canonical: "Anthropic",        category: "ai" },
  { match: "x.ai",        canonical: "Grok",             category: "ai" },
  { match: "grok",        canonical: "Grok",             category: "ai" },
  { match: "perplexity",  canonical: "Perplexity",       category: "ai" },
  { match: "midjourney",  canonical: "Midjourney",       category: "ai" },
  { match: "cursor",      canonical: "Cursor",           category: "ai" },
  { match: "github",      canonical: "GitHub",           category: "software" },
  { match: "vercel",      canonical: "Vercel",           category: "cloud" },
  { match: "render",      canonical: "Render",           category: "cloud" },
  { match: "railway",     canonical: "Railway",          category: "cloud" },
  { match: "cloudflare",  canonical: "Cloudflare",       category: "cloud" },
  { match: "supabase",    canonical: "Supabase",         category: "cloud" },
  { match: "stripe",      canonical: "Stripe",           category: "software" },

  // cloud
  { match: "aws",         canonical: "AWS",              category: "cloud" },
  { match: "amazon web",  canonical: "AWS",              category: "cloud" },
  { match: "google cloud",canonical: "Google Cloud",     category: "cloud" },
  { match: "gcp",         canonical: "Google Cloud",     category: "cloud" },
  { match: "azure",       canonical: "Microsoft Azure",  category: "cloud" },

  // misc
  { match: "amazon prime",canonical: "Amazon Prime",     category: "shopping" },
  { match: "icloud",      canonical: "iCloud",           category: "cloud" },
  { match: "1password",   canonical: "1Password",        category: "software" },
  { match: "notion",      canonical: "Notion",           category: "software" },
  { match: "linear",      canonical: "Linear",           category: "software" },
  { match: "figma",       canonical: "Figma",            category: "software" },
  { match: "dropbox",     canonical: "Dropbox",          category: "cloud" },
  { match: "google one",  canonical: "Google One",       category: "cloud" },
  { match: "nyt",         canonical: "New York Times",   category: "news" },
  { match: "new york times", canonical: "New York Times", category: "news" },
];

export interface CanonicalResult {
  canonical: string;
  category: string | null;
  matched: boolean;       // false → fell through to title-case
}

export function canonicalizeMerchant(raw: string): CanonicalResult {
  const lower = raw.toLowerCase();
  for (const rule of SEED_MAP) {
    if (lower.includes(rule.match)) {
      return {
        canonical: rule.canonical,
        category: rule.category ?? null,
        matched: true,
      };
    }
  }
  return {
    canonical: titleCase(raw.trim()),
    category: null,
    matched: false,
  };
}

function titleCase(s: string): string {
  if (!s) return s;
  return s
    .split(/\s+/)
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}
