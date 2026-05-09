import { getSql } from "../db.js";

export interface Episode {
  id: string;
  start_seq: string;
  end_seq: string;
  title: string;
  summary: string;
  topics: string[];
  metadata: Record<string, unknown>;
}

export interface Fact {
  id: string;
  content: string;
  category: string;
  confidence: string;
  source_episode_id: string | null;
}

export interface OpenLoop {
  id: string;
  content: string;
  priority: string;
  due_at: string | null;
  source_episode_id: string | null;
}

export interface MemoryState {
  living_profile: string;
  situation_brief: string;
  last_episode_seq: string;
  profile_refreshed_at: string | null;
  brief_refreshed_at: string | null;
}

export interface ChatLedgerRow {
  seq: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: string;
}

export async function ensureMemoryState(userId: string): Promise<MemoryState> {
  const sql = getSql();
  const rows = await sql<MemoryState[]>`
    insert into user_memory_state (user_id)
    values (${userId})
    on conflict (user_id) do update
      set updated_at = user_memory_state.updated_at
    returning living_profile, situation_brief, last_episode_seq,
      profile_refreshed_at, brief_refreshed_at
  `;
  const state = rows[0];
  if (!state) throw new Error("failed to initialize memory state");
  return state;
}

export async function loadMemoryContext(userId: string): Promise<string> {
  const state = await ensureMemoryState(userId);
  const loops = await listOpenLoops(userId, 5);
  const parts: string[] = [];
  if (state.living_profile.trim()) {
    parts.push(`living_profile:\n${state.living_profile.trim()}`);
  }
  if (state.situation_brief.trim()) {
    parts.push(`situation_brief:\n${state.situation_brief.trim()}`);
  }
  if (loops.length > 0) {
    parts.push(
      `active_open_loops:\n${loops.map((loop) => `- ${loop.content}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export async function getRowsAfterSeq(
  userId: string,
  afterSeq: number,
  limit = 30,
): Promise<ChatLedgerRow[]> {
  const sql = getSql();
  return await sql<ChatLedgerRow[]>`
    select seq, role, content, created_at
    from chat_messages
    where user_id = ${userId}
      and seq > ${afterSeq}
    order by seq asc
    limit ${limit}
  `;
}

export async function createEpisode(args: {
  userId: string;
  startSeq: number;
  endSeq: number;
  title: string;
  summary: string;
  topics: string[];
  metadata?: Record<string, unknown>;
}): Promise<Episode> {
  const sql = getSql();
  const rows = await sql<Episode[]>`
    insert into episodes (
      user_id, start_seq, end_seq, title, summary, topics, metadata
    )
    values (
      ${args.userId},
      ${args.startSeq},
      ${args.endSeq},
      ${args.title},
      ${args.summary},
      ${args.topics},
      ${sql.json((args.metadata ?? {}) as Record<string, unknown> as never)}
    )
    on conflict (user_id, start_seq, end_seq) do update
      set title = excluded.title,
          summary = excluded.summary,
          topics = excluded.topics,
          metadata = episodes.metadata || excluded.metadata,
          updated_at = now()
    returning id, start_seq, end_seq, title, summary, topics, metadata
  `;
  const episode = rows[0];
  if (!episode) throw new Error("failed to create episode");
  return episode;
}

export async function markEpisodeSeq(userId: string, seq: number): Promise<void> {
  const sql = getSql();
  await sql`
    update user_memory_state
    set last_episode_seq = greatest(last_episode_seq, ${seq}),
        updated_at = now()
    where user_id = ${userId}
  `;
}

export async function upsertFacts(args: {
  userId: string;
  episodeId: string;
  facts: Array<{ content: string; category: string; confidence?: number }>;
}): Promise<number> {
  if (args.facts.length === 0) return 0;
  const sql = getSql();
  let changed = 0;
  for (const fact of args.facts) {
    const content = fact.content.trim();
    if (!content) continue;
    await sql`
      insert into facts (
        user_id, content, category, confidence, source_episode_id
      )
      values (
        ${args.userId},
        ${content},
        ${fact.category || "general"},
        ${fact.confidence ?? 0.8},
        ${args.episodeId}
      )
      on conflict (user_id, (lower(content)))
        where status = 'active'
      do update set
        category = excluded.category,
        confidence = greatest(facts.confidence, excluded.confidence),
        source_episode_id = excluded.source_episode_id,
        updated_at = now()
    `;
    changed++;
  }
  return changed;
}

export async function upsertOpenLoops(args: {
  userId: string;
  episodeId: string;
  openLoops: Array<{ content: string; priority?: string; due_at?: string | null }>;
}): Promise<number> {
  if (args.openLoops.length === 0) return 0;
  const sql = getSql();
  let changed = 0;
  for (const loop of args.openLoops) {
    const content = loop.content.trim();
    if (!content) continue;
    await sql`
      insert into open_loops (
        user_id, content, priority, due_at, source_episode_id
      )
      values (
        ${args.userId},
        ${content},
        ${loop.priority || "normal"},
        ${loop.due_at ?? null},
        ${args.episodeId}
      )
      on conflict (user_id, (lower(content)))
        where status = 'open'
      do update set
        priority = excluded.priority,
        due_at = coalesce(excluded.due_at, open_loops.due_at),
        source_episode_id = excluded.source_episode_id,
        updated_at = now()
    `;
    changed++;
  }
  return changed;
}

export async function updateMemoryState(args: {
  userId: string;
  situationBrief?: string;
  livingProfile?: string;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into user_memory_state (
      user_id, situation_brief, living_profile, brief_refreshed_at,
      profile_refreshed_at
    )
    values (
      ${args.userId},
      ${args.situationBrief ?? ""},
      ${args.livingProfile ?? ""},
      ${args.situationBrief ? sql`now()` : null},
      ${args.livingProfile ? sql`now()` : null}
    )
    on conflict (user_id) do update set
      situation_brief = case
        when ${args.situationBrief ?? null}::text is null
        then user_memory_state.situation_brief
        else excluded.situation_brief
      end,
      living_profile = case
        when ${args.livingProfile ?? null}::text is null
        then user_memory_state.living_profile
        else excluded.living_profile
      end,
      brief_refreshed_at = case
        when ${args.situationBrief ?? null}::text is null
        then user_memory_state.brief_refreshed_at
        else now()
      end,
      profile_refreshed_at = case
        when ${args.livingProfile ?? null}::text is null
        then user_memory_state.profile_refreshed_at
        else now()
      end,
      updated_at = now()
  `;
}

export async function supersedeFactsByText(
  userId: string,
  texts: string[],
): Promise<number> {
  const sql = getSql();
  let changed = 0;
  for (const text of texts) {
    const needle = text.trim();
    if (!needle) continue;
    const rows = await sql`
      update facts
      set status = 'superseded',
          updated_at = now()
      where user_id = ${userId}
        and status = 'active'
        and content ilike ${`%${needle}%`}
      returning id
    `;
    changed += rows.count;
  }
  return changed;
}

export async function closeOpenLoopsByText(
  userId: string,
  texts: string[],
): Promise<number> {
  const sql = getSql();
  let changed = 0;
  for (const text of texts) {
    const needle = text.trim();
    if (!needle) continue;
    const rows = await sql`
      update open_loops
      set status = 'closed',
          updated_at = now()
      where user_id = ${userId}
        and status = 'open'
        and content ilike ${`%${needle}%`}
      returning id
    `;
    changed += rows.count;
  }
  return changed;
}

export async function listFacts(userId: string, limit = 30): Promise<Fact[]> {
  const sql = getSql();
  return await sql<Fact[]>`
    select id, content, category, confidence, source_episode_id
    from facts
    where user_id = ${userId}
      and status = 'active'
    order by updated_at desc
    limit ${limit}
  `;
}

export async function listOpenLoops(
  userId: string,
  limit = 20,
): Promise<OpenLoop[]> {
  const sql = getSql();
  return await sql<OpenLoop[]>`
    select id, content, priority, due_at, source_episode_id
    from open_loops
    where user_id = ${userId}
      and status = 'open'
    order by updated_at desc
    limit ${limit}
  `;
}

export async function searchEpisodes(
  userId: string,
  query: string,
  limit = 5,
): Promise<Episode[]> {
  const sql = getSql();
  const pattern = `%${query}%`;
  return await sql<Episode[]>`
    select id, start_seq, end_seq, title, summary, topics, metadata
    from episodes
    where user_id = ${userId}
      and (
        title ilike ${pattern}
        or summary ilike ${pattern}
        or exists (
          select 1 from unnest(topics) topic where topic ilike ${pattern}
        )
      )
    order by end_seq desc
    limit ${limit}
  `;
}

export async function searchFacts(
  userId: string,
  query: string,
  limit = 8,
): Promise<Fact[]> {
  const sql = getSql();
  const pattern = `%${query}%`;
  return await sql<Fact[]>`
    select id, content, category, confidence, source_episode_id
    from facts
    where user_id = ${userId}
      and status = 'active'
      and (content ilike ${pattern} or category ilike ${pattern})
    order by updated_at desc
    limit ${limit}
  `;
}

export async function searchOpenLoops(
  userId: string,
  query: string,
  limit = 8,
): Promise<OpenLoop[]> {
  const sql = getSql();
  const pattern = `%${query}%`;
  return await sql<OpenLoop[]>`
    select id, content, priority, due_at, source_episode_id
    from open_loops
    where user_id = ${userId}
      and status = 'open'
      and (content ilike ${pattern} or priority ilike ${pattern})
    order by updated_at desc
    limit ${limit}
  `;
}
