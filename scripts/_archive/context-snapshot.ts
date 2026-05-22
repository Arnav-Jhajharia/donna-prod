// Generated context snapshot for fast session orientation.
//
// Pulls from authoritative sources (tool registry, migrations dir, db) and
// emits a compact markdown blob to stdout. Intended consumption: paste into
// CLAUDE.md, pipe to a file, or read at the start of a Claude session.
//
// Usage:
//   npm run context                    # all sections
//   npm run context -- --no-db         # skip db sections (no DATABASE_URL)
//   npm run context > .context.md      # write to file

import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  tool_definitions,
  PTC_ELIGIBLE,
  TERMINATORS,
} from "../src/donna/tools/index.ts";
import { closeDb, getSql } from "../src/donna/db.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase/migrations");

const skipDb = process.argv.includes("--no-db") || !process.env.DATABASE_URL;

function firstLine(s: string, max = 140): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

function ago(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function renderTools(): string {
  const out: string[] = [];
  out.push(`## tools (${tool_definitions.length})\n`);

  const direct: string[] = [];
  const ptc: string[] = [];
  const server: string[] = [];

  for (const t of tool_definitions) {
    if ("type" in t && typeof t.type === "string") {
      server.push(`- ${t.name} (${t.type}) — anthropic-managed`);
      continue;
    }
    const desc = firstLine((t as { description?: string }).description ?? "");
    const modes = Array.from((t as { modes: ReadonlySet<string> }).modes).sort().join("/");
    const tags: string[] = [`modes: ${modes}`];
    if (TERMINATORS.has(t.name)) tags.push("terminator");
    const line = `- **${t.name}** — ${desc}  \n  _${tags.join(" · ")}_`;
    if (PTC_ELIGIBLE.has(t.name)) ptc.push(line);
    else direct.push(line);
  }

  out.push(`### direct-only (${direct.length})`);
  out.push(direct.join("\n"));
  out.push(`\n### ptc-callable (${ptc.length})`);
  out.push(ptc.join("\n"));
  if (server.length) {
    out.push(`\n### server tools`);
    out.push(server.join("\n"));
  }
  return out.join("\n");
}

async function renderMigrations(): Promise<string> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  const lines: string[] = [`## migrations (${files.length} total, newest first)\n`];
  for (const f of files.slice(0, 12)) {
    const body = await readFile(join(MIGRATIONS_DIR, f), "utf8");
    const firstComment =
      body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("--") && l.length > 2)
        ?.replace(/^--\s*/, "") ?? firstLine(body);
    lines.push(`- \`${f}\` — ${firstComment}`);
  }
  return lines.join("\n");
}

async function renderRecentRuns(): Promise<string> {
  const sql = getSql();
  const rows = (await sql`
    select id, channel, mode, status, terminator, started_at, ended_at,
           coalesce(jsonb_array_length(final_sends), 0) as send_count,
           coalesce(jsonb_array_length(voice_violations), 0) as violation_count
    from execution_runs
    order by started_at desc
    limit 8
  `) as Array<{
    id: string;
    channel: string;
    mode: string;
    status: string;
    terminator: string | null;
    started_at: Date;
    send_count: number;
    violation_count: number;
  }>;
  if (rows.length === 0) return `## recent runs\n\nnone.`;
  const lines: string[] = [`## recent runs (last ${rows.length})\n`];
  for (const r of rows) {
    const v = r.violation_count > 0 ? ` ⚠️${r.violation_count}` : "";
    lines.push(
      `- ${ago(r.started_at)} — ${r.mode}/${r.channel}/${r.status} → ${r.terminator ?? "(none)"} · ${r.send_count} sends${v}`,
    );
  }
  return lines.join("\n");
}

async function renderToolUsage(): Promise<string> {
  const sql = getSql();
  const rows = (await sql`
    select name, count(*)::int as n
    from execution_events
    where type in ('tool_call', 'tool_result')
      and name is not null
      and created_at > now() - interval '7 days'
    group by name
    order by n desc
    limit 12
  `) as Array<{ name: string; n: number }>;
  if (rows.length === 0) return `## tool usage (7d)\n\nno events.`;
  const lines: string[] = [`## tool usage (7d, top ${rows.length})\n`];
  for (const r of rows) lines.push(`- ${r.name}: ${r.n}`);
  return lines.join("\n");
}

async function renderIntegrations(): Promise<string> {
  const sql = getSql();
  const rows = (await sql`
    select provider, status, mode, count(*)::int as n
    from integrations
    group by provider, status, mode
    order by provider, status
  `) as Array<{ provider: string; status: string; mode: string; n: number }>;
  if (rows.length === 0) return `## integrations\n\nnone connected.`;
  const lines: string[] = [`## integrations\n`];
  for (const r of rows) {
    lines.push(`- ${r.provider} · ${r.status} · mode=${r.mode} · ${r.n}`);
  }
  return lines.join("\n");
}

async function safeSection(label: string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `## ${label}\n\n_skipped: ${msg}_`;
  }
}

async function main(): Promise<void> {
  const sections: string[] = [];
  sections.push(`# donna context snapshot`);
  sections.push(`_generated ${new Date().toISOString()}_`);
  sections.push(renderTools());
  sections.push(await renderMigrations());

  if (!skipDb) {
    sections.push(await safeSection("recent runs", renderRecentRuns));
    sections.push(await safeSection("tool usage (7d)", renderToolUsage));
    sections.push(await safeSection("integrations", renderIntegrations));
    await closeDb();
  } else {
    sections.push(`_db sections skipped (--no-db or DATABASE_URL unset)_`);
  }

  console.log(sections.join("\n\n"));
}

main().catch(async (err) => {
  console.error("error:", err);
  try {
    await closeDb();
  } catch {
    /* noop */
  }
  process.exit(1);
});
