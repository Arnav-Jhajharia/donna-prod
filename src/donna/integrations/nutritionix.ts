// nutritionix natural-language nutrient lookup. stateless rest client, not an
// oauth integration — does not flow through integrations/service.ts. see
// https://docs.nutritionix.com/

import { getCached, putCached } from "../calories/cache.js";

const NL_URL = "https://trackapi.nutritionix.com/v2/natural/nutrients";
const SEARCH_URL = "https://trackapi.nutritionix.com/v2/search/instant";

export interface NixFood {
  food_name: string;
  serving_qty: number;
  serving_unit: string;
  serving_weight_grams: number | null;
  nf_calories: number;
  nf_protein: number;
  nf_total_carbohydrate: number;
  nf_total_fat: number;
  nf_dietary_fiber: number | null;
  nf_sodium: number | null;
  nix_item_id: string | null;
  tag_id: string | null;
  photo?: { thumb?: string; highres?: string };
}

export interface NixNlResult {
  source: "nutritionix" | "cache";
  foods: NixFood[];
  raw: unknown;
}

function headers(): Record<string, string> {
  const id = process.env.NUTRITIONIX_APP_ID;
  const key = process.env.NUTRITIONIX_API_KEY;
  if (!id || !key) {
    throw new Error("nutritionix: NUTRITIONIX_APP_ID / NUTRITIONIX_API_KEY not set");
  }
  return {
    "x-app-id": id,
    "x-app-key": key,
    "content-type": "application/json",
  };
}

export async function naturalNutrients(query: string): Promise<NixNlResult> {
  const cached = await getCached(query);
  if (cached) {
    const wrapped = cached as { foods: NixFood[] };
    return { source: "cache", foods: wrapped.foods, raw: cached };
  }
  const res = await fetch(NL_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nutritionix nl: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { foods?: NixFood[] };
  const foods = json.foods ?? [];
  await putCached(query, { foods, raw: json });
  return { source: "nutritionix", foods, raw: json };
}

export interface NixInstantResult {
  common: Array<{
    food_name: string;
    tag_id: string;
    serving_qty: number;
    serving_unit: string;
  }>;
  branded: Array<{
    food_name: string;
    nix_item_id: string;
    brand_name: string;
    nf_calories: number;
  }>;
}

export async function instantSearch(
  query: string,
  limit = 5,
): Promise<NixInstantResult> {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&detailed=true&common=true&branded=true`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nutritionix instant: ${res.status} ${text}`);
  }
  const json = (await res.json()) as NixInstantResult;
  return {
    common: (json.common ?? []).slice(0, limit),
    branded: (json.branded ?? []).slice(0, limit),
  };
}
