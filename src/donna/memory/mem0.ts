import { MemoryClient } from "mem0ai";

interface Mem0Hit {
  id: string;
  memory?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown> | null;
}

let client: MemoryClient | null | undefined;

function getClient(): MemoryClient | null {
  if (client !== undefined) return client;
  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) {
    client = null;
    return client;
  }
  client = new MemoryClient({ apiKey });
  return client;
}

export function isMem0Enabled(): boolean {
  return Boolean(process.env.MEM0_API_KEY);
}

export async function addEpisodeToMem0(args: {
  userId: string;
  episodeId: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const mem0 = getClient();
  if (!mem0) return;
  await mem0.add(
    [{ role: "user", content: args.content }],
    {
      userId: args.userId,
      metadata: {
        node_type: "episode",
        episode_id: args.episodeId,
        ...(args.metadata ?? {}),
      },
    },
  );
}

export async function searchMem0(args: {
  userId: string;
  query: string;
  limit?: number;
}): Promise<Mem0Hit[]> {
  const mem0 = getClient();
  if (!mem0) return [];
  const result = await mem0.search(args.query, {
    filters: { userId: args.userId },
    topK: args.limit ?? 5,
  });
  return (result.results ?? []).map((hit) => ({
    id: hit.id,
    memory: hit.memory,
    content: hit.memory,
    score: hit.score,
    metadata: hit.metadata ?? null,
  }));
}
