// thin exa client. minimum: /search only. find_similar / research / webset /
// monitor will land when we actually need them.

const EXA_BASE = "https://api.exa.ai";

export interface ExaSearchHit {
  title: string;
  url: string;
  text?: string;
  publishedDate?: string;
  author?: string;
}

interface ExaSearchResponse {
  results?: ExaSearchHit[];
}

export async function exaSearch(args: {
  query: string;
  numResults?: number;
}): Promise<ExaSearchHit[]> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY not set");
  }
  const res = await fetch(`${EXA_BASE}/search`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: args.query,
      numResults: args.numResults ?? 5,
      useAutoprompt: true,
      contents: { text: { maxCharacters: 600 } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`exa search failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as ExaSearchResponse;
  return data.results ?? [];
}
