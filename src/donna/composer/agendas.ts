// composer/agendas — load + render the user's active agendas as a context
// block donna can read each reactive turn. one row per active agenda;
// donna calls agendas_advance to mutate.
//
// today only one agenda kind: 'subscriptions_onboarding'. shape generalizes.

import { getSql } from "../db.js";

export interface ActiveAgenda {
  id: string;
  user_id: string;
  kind: string;
  step: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function loadActiveAgendas(userId: string): Promise<ActiveAgenda[]> {
  try {
    const sql = getSql();
    const rows = await sql<ActiveAgenda[]>`
      select id, user_id, kind, step, payload, created_at, updated_at
      from donna_state_agendas
      where user_id = ${userId} and status = 'active'
      order by created_at desc
    `;
    return [...rows];
  } catch (err) {
    // table may not exist yet during early dev — return empty so the brain
    // doesn't fail per-turn over composer state.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[composer/agendas] loadActiveAgendas failed: ${msg}`);
    return [];
  }
}

// render to the xml-tagged block donna already expects in steerings. one tag
// per agenda. step + payload are the load-bearing fields she reasons against.
export function renderAgendasBlock(agendas: ActiveAgenda[]): string {
  if (agendas.length === 0) return "";
  const items = agendas.map((a) => {
    const payloadAttr = Object.keys(a.payload).length > 0
      ? ` payload="${escapeAttr(JSON.stringify(a.payload))}"`
      : "";
    return `  <agenda id="${a.id}" kind="${escapeAttr(a.kind)}" step="${escapeAttr(a.step)}"${payloadAttr} />`;
  }).join("\n");
  return `<active_agendas>\n${items}\n</active_agendas>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
