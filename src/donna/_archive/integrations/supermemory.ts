// typed Supermemory wrapper — TS port of the python client at
// InstructKr.Claw-Code-main/backend/memory/clients/supermemory.py.
//
// container_tag = donna user_id (one container per user — strict isolation).
// degrades gracefully when SUPERMEMORY_API_KEY is missing: methods log + return
// empty results / empty ids rather than crashing.

import Supermemory from "supermemory";

// per-user "what to extract" hint sent on add() so supermemory's extractor
// knows what kind of entity it's processing facts for. ported verbatim from
// the python wrapper.
const ENTITY_CONTEXT_TEMPLATE =
  "{name} uses Donna, a personal AI assistant. " +
  "Extract facts about their identity, occupation, location, living situation, " +
  "preferences, routines, habits, relationships, plans, deadlines, " +
  "health, finances, opinions, emotional state, and interests. " +
  "Track recurring topics, disliked patterns, and action preferences. " +
  "Note communication style and preferred depth of interaction.";

export function buildEntityContext(name: string = ""): string {
  if (name) return ENTITY_CONTEXT_TEMPLATE.replace("{name}", name);
  return ENTITY_CONTEXT_TEMPLATE.replace("{name}", "User");
}

// supermemory metadata only accepts scalars + string arrays. anything else
// must be coerced to a string. matches _sanitize_metadata in the python.
type ScalarMeta = string | number | boolean | Array<string>;

export function sanitizeMetadata(
  meta: Record<string, unknown>,
): Record<string, ScalarMeta> {
  const out: Record<string, ScalarMeta> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((i) => String(i));
    } else if (typeof v === "object") {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// result types — flat shapes the rest of the codebase consumes
// ---------------------------------------------------------------------------

export interface MemoryResult {
  id: string;
  content: string;
  score: number;
  updated_at: string;
  metadata: Record<string, unknown>;
  relations: Array<{ relation: string; memory: string }>;
}

export interface ChunkResult {
  content: string;
  score: number;
  doc_id: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MemoryClient
// ---------------------------------------------------------------------------

export class MemoryClient {
  private sm: Supermemory | null;

  constructor(client?: Supermemory) {
    if (client) {
      this.sm = client;
      return;
    }
    const apiKey = process.env.SUPERMEMORY_API_KEY;
    if (!apiKey) {
      console.warn("[supermemory] SUPERMEMORY_API_KEY not set — degraded");
      this.sm = null;
      return;
    }
    this.sm = new Supermemory({ apiKey });
  }

  get available(): boolean {
    return this.sm !== null;
  }

  /**
   * Add an episode (one fact / chunk) to the user's container.
   * Returns the supermemory id, or "" if unavailable / on error.
   */
  async addEpisode(args: {
    userId: string;
    content: string;
    messageType?: string;
    metadata?: Record<string, unknown>;
    customId?: string;
    entityContext?: string;
  }): Promise<string> {
    if (!this.sm) return "";
    try {
      const meta = sanitizeMetadata({
        message_type: args.messageType ?? "text",
        ...(args.metadata ?? {}),
      });
      const result = await this.sm.add({
        content: args.content,
        containerTag: args.userId,
        ...(args.customId ? { customId: args.customId } : {}),
        ...(args.entityContext ? { entityContext: args.entityContext } : {}),
        metadata: meta,
      });
      // SDK returns AddResponse { id, status }
      return (result as { id?: string }).id ?? "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[supermemory] add_episode failed user=${args.userId.slice(0, 8)}: ${msg}`);
      return "";
    }
  }

  /**
   * Hybrid semantic + graph search over the user's memories.
   * Returns related_memories alongside each hit when available.
   */
  async searchWithGraph(args: {
    userId: string;
    query: string;
    limit?: number;
  }): Promise<MemoryResult[]> {
    if (!this.sm) return [];
    try {
      const result = await this.sm.search.memories({
        q: args.query,
        containerTag: args.userId,
        limit: args.limit ?? 10,
        include: { relatedMemories: true } as never,
      } as never);
      const raw = (result as { results?: unknown[] }).results ?? [];
      const out: MemoryResult[] = [];
      for (const r of raw) {
        const rec = r as Record<string, unknown>;
        const content =
          (rec.chunk as string) ??
          (rec.memory as string) ??
          (rec.content as string) ??
          "";
        const score = Number(
          (rec.similarity as number) ?? (rec.score as number) ?? 0,
        );
        const relMemories =
          ((rec.related_memories ?? rec.relatedMemories) as Array<
            Record<string, unknown>
          >) ?? [];
        const relations = relMemories.map((rel) => ({
          relation: (rel.type as string) ?? "related",
          memory:
            (rel.chunk as string) ?? (rel.content as string) ?? "",
        }));
        out.push({
          id: (rec.id as string) ?? "",
          content,
          score,
          updated_at: String(rec.updated_at ?? rec.updatedAt ?? ""),
          metadata: (rec.metadata as Record<string, unknown>) ?? {},
          relations,
        });
      }
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[supermemory] search_with_graph failed user=${args.userId.slice(0, 8)}: ${msg}`);
      return [];
    }
  }

  /**
   * Document-chunk search with rerank. Useful when content was added as a
   * longer document (rather than per-message episodes).
   */
  async searchDocumentChunks(args: {
    userId: string;
    query: string;
    docId?: string;
    limit?: number;
  }): Promise<ChunkResult[]> {
    if (!this.sm) return [];
    try {
      const params: Record<string, unknown> = {
        q: args.query,
        containerTags: [args.userId],
        limit: args.limit ?? 10,
        rerank: true,
        includeSummary: true,
      };
      if (args.docId) params.docId = args.docId;
      const result = await this.sm.search.documents(params as never);
      const docs = (result as { results?: unknown[] }).results ?? [];
      const chunks: ChunkResult[] = [];
      for (const d of docs) {
        const doc = d as Record<string, unknown>;
        const docMeta: Record<string, unknown> = {};
        for (const attr of ["metadata", "customId", "id", "title"] as const) {
          const v = doc[attr];
          if (v !== undefined && v !== null) docMeta[attr] = v;
        }
        const docChunks = (doc.chunks as Array<Record<string, unknown>>) ?? [];
        for (const c of docChunks) {
          chunks.push({
            content:
              (c.content as string) ?? (c.chunk as string) ?? "",
            score: Number(c.score ?? 0),
            doc_id: (docMeta.id as string) ?? "",
            metadata: docMeta,
          });
        }
      }
      return chunks;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[supermemory] search_document_chunks failed user=${args.userId.slice(0, 8)}: ${msg}`);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// singleton
// ---------------------------------------------------------------------------

let _client: MemoryClient | null = null;

export function getMemoryClient(): MemoryClient {
  if (!_client) _client = new MemoryClient();
  return _client;
}
