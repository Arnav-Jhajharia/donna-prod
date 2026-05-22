// vendor canonicalization. maps the email-domain we see in `from` to a
// stable, human-readable vendor name + category. unknown domains fall back
// to a Title-Cased second-level domain.
//
// keep this file deliberately small + curated. when a vendor pattern is
// wrong or missing, edit here — this is the one knob between "raw email
// chaos" and "the user's actual subscription view".

interface VendorEntry {
  name: string;
  category: string;
}

const VENDORS: Record<string, VendorEntry> = {
  // ── AI / SaaS ──────────────────────────────────────────────────────────
  "anthropic.com":          { name: "Anthropic / Claude",  category: "ai_saas" },
  "mail.anthropic.com":     { name: "Anthropic / Claude",  category: "ai_saas" },
  "claude.com":             { name: "Anthropic / Claude",  category: "ai_saas" },
  "email.claude.com":       { name: "Anthropic / Claude",  category: "ai_saas" },
  "openai.com":             { name: "OpenAI",              category: "ai_saas" },
  "mail.openai.com":        { name: "OpenAI",              category: "ai_saas" },
  "mem0.io":                { name: "Mem0",                category: "ai_saas" },
  "wispr.ai":               { name: "Wispr Flow",          category: "ai_saas" },
  "perplexity.ai":          { name: "Perplexity",          category: "ai_saas" },
  "cursor.com":             { name: "Cursor",              category: "ai_saas" },
  "cursor.sh":              { name: "Cursor",              category: "ai_saas" },
  "supermemory.ai":         { name: "Supermemory",         category: "ai_saas" },

  // ── SaaS ───────────────────────────────────────────────────────────────
  "figma.com":              { name: "Figma",               category: "saas" },
  "notion.so":              { name: "Notion",              category: "saas" },
  "linear.app":             { name: "Linear",              category: "saas" },
  "loom.com":               { name: "Loom",                category: "saas" },
  "1password.com":          { name: "1Password",           category: "saas" },
  "todoist.com":            { name: "Todoist",             category: "saas" },
  "taskade.com":            { name: "Taskade",             category: "saas" },
  "cal.com":                { name: "Cal.com",             category: "saas" },
  "google.com":             { name: "Google Workspace",    category: "saas" },
  "workspace.google.com":   { name: "Google Workspace",    category: "saas" },

  // ── Infra / Dev ────────────────────────────────────────────────────────
  "github.com":             { name: "GitHub",              category: "infra" },
  "notify.railway.app":     { name: "Railway",             category: "infra" },
  "railway.app":            { name: "Railway",             category: "infra" },
  "vercel.com":             { name: "Vercel",              category: "infra" },
  "netlify.com":            { name: "Netlify",             category: "infra" },
  "cloudflare.com":         { name: "Cloudflare",          category: "infra" },
  "twilio.com":             { name: "Twilio",              category: "infra" },
  "cloudinary.com":         { name: "Cloudinary",          category: "infra" },
  "supabase.com":           { name: "Supabase",            category: "infra" },
  "supabase.io":            { name: "Supabase",            category: "infra" },
  "stripe.com":             { name: "Stripe",              category: "infra" },
  "linqapp.com":            { name: "Linq",                category: "infra" },
  "qdrant.tech":            { name: "Qdrant",              category: "infra" },
  "exa.ai":                 { name: "Exa",                 category: "infra" },

  // ── Education ──────────────────────────────────────────────────────────
  "coursera.org":           { name: "Coursera",            category: "education" },
  "edx.org":                { name: "edX",                 category: "education" },
  "udemy.com":              { name: "Udemy",               category: "education" },
  "codecrafters.io":        { name: "CodeCrafters",        category: "education" },
  "codecademy.com":         { name: "Codecademy",          category: "education" },
  "educative.io":           { name: "Educative",           category: "education" },
  "mygreatlearning.com":    { name: "Great Learning",      category: "education" },
  "codingninjas.com":       { name: "Coding Ninjas",       category: "education" },

  // ── Banking / Investing / Fintech ──────────────────────────────────────
  "paypal.com":             { name: "PayPal",              category: "banking" },
  "paypal.com.sg":          { name: "PayPal",              category: "banking" },
  "trustbank.sg":           { name: "Trust Bank Singapore",category: "banking" },
  "dbs.com":                { name: "DBS Bank",            category: "banking" },
  "icicibank.com":          { name: "ICICI Bank",          category: "banking" },
  "icicisecurities.com":    { name: "ICICI Securities",    category: "investing" },
  "zerodha.com":            { name: "Zerodha",             category: "investing" },
  "motilaloswal.com":       { name: "Motilal Oswal",       category: "investing" },
  "vestedfinance.com":      { name: "Vested Finance",      category: "investing" },

  // ── Telecom / Utilities ────────────────────────────────────────────────
  "circles.life":           { name: "Circles.Life",        category: "telecom" },
  "att.com":                { name: "AT&T",                category: "telecom" },
  "verizon.com":            { name: "Verizon",             category: "telecom" },
  "tmobile.com":            { name: "T-Mobile",            category: "telecom" },

  // ── Transport / Food ───────────────────────────────────────────────────
  "uber.com":               { name: "Uber",                category: "transport" },
  "lyft.com":               { name: "Lyft",                category: "transport" },
  "grab.com":               { name: "Grab",                category: "transport" },
  "foodpanda.sg":           { name: "Foodpanda",           category: "food" },
  "doordash.com":           { name: "DoorDash",            category: "food" },
  "ubereats.com":           { name: "Uber Eats",           category: "food" },

  // ── Media / Newsletters ────────────────────────────────────────────────
  "nytimes.com":            { name: "New York Times",      category: "media" },
  "e.newyorktimes.com":     { name: "New York Times",      category: "media" },
  "the-ken.com":            { name: "The Ken",             category: "media" },
  "economictimesnews.com":  { name: "Economic Times",      category: "media" },
  "spotify.com":            { name: "Spotify",             category: "media" },
  "netflix.com":            { name: "Netflix",             category: "media" },
  "youtube.com":            { name: "YouTube Premium",     category: "media" },
};

// extract the bare domain (lowercase) from "Name <addr@domain.tld>" or "addr@domain.tld"
export function extractDomain(rawFrom: string): string {
  const m = rawFrom.match(/<([^>]+)>/);
  const addr = (m?.[1] ?? rawFrom).trim().toLowerCase();
  if (!addr.includes("@")) return rawFrom.toLowerCase().trim();
  return addr.split("@")[1]!.replace(/>$/, "").trim();
}

// Try exact domain → second-level domain → title-cased SLD fallback.
export function canonicalizeVendor(rawFrom: string): VendorEntry {
  const d = extractDomain(rawFrom);
  if (VENDORS[d]) return VENDORS[d];
  const parts = d.split(".");
  const sld = parts.length >= 2 ? parts.slice(-2).join(".") : d;
  if (VENDORS[sld]) return VENDORS[sld];
  const stem = sld.split(".")[0] ?? sld;
  const name = stem.length > 0 ? stem.charAt(0).toUpperCase() + stem.slice(1) : sld;
  return { name, category: "other" };
}
