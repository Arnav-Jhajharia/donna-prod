import { randomUUID } from "node:crypto";
import { getSql } from "../db.js";

export type ExecutionStatus = "running" | "completed" | "failed";

export interface CreateExecutionRunArgs {
  userId: string;
  channel: string;
  mode: string;
  inboundMessageId?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export interface FinishExecutionRunArgs {
  status: Exclude<ExecutionStatus, "running">;
  terminator?: string | null;
  finalSends?: string[];
  voiceViolations?: string[];
  error?: string | null;
}

export async function createExecutionRun({
  userId,
  channel,
  mode,
  inboundMessageId = null,
  model = null,
  metadata = {},
}: CreateExecutionRunArgs): Promise<string> {
  const id = randomUUID();
  try {
    const sql = getSql();
    await sql`
      insert into execution_runs (
        id,
        user_id,
        channel,
        mode,
        inbound_message_id,
        status,
        model,
        metadata
      ) values (
        ${id},
        ${userId},
        ${channel},
        ${mode},
        ${inboundMessageId},
        'running',
        ${model},
        ${sql.json(metadata as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[exec] create run failed: ${msg}`);
  }
  return id;
}

export async function recordExecutionEvent(
  runId: string | null | undefined,
  type: string,
  name?: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (!runId) return;
  try {
    const sql = getSql();
    await sql`
      insert into execution_events (run_id, type, name, payload)
      values (
        ${runId},
        ${type},
        ${name ?? null},
        ${sql.json(payload as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[exec] event write failed (${type}:${name ?? "none"}): ${msg}`);
  }
}

export async function finishExecutionRun(
  runId: string | null | undefined,
  {
    status,
    terminator = null,
    finalSends = [],
    voiceViolations = [],
    error = null,
  }: FinishExecutionRunArgs,
): Promise<void> {
  if (!runId) return;
  try {
    const sql = getSql();
    await sql`
      update execution_runs
      set
        status = ${status},
        terminator = ${terminator},
        final_sends = ${sql.json(finalSends as Parameters<typeof sql.json>[0])},
        voice_violations = ${sql.json(voiceViolations as Parameters<typeof sql.json>[0])},
        error = ${error},
        ended_at = now()
      where id = ${runId}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[exec] finish run failed: ${msg}`);
  }
}

export async function listExecutionRuns(limit: number = 50): Promise<unknown[]> {
  const sql = getSql();
  const capped = Math.max(1, Math.min(limit, 200));
  const rows = await sql`
    select
      id,
      user_id,
      channel,
      mode,
      inbound_message_id,
      status,
      model,
      terminator,
      final_sends,
      voice_violations,
      metadata,
      error,
      started_at,
      ended_at
    from execution_runs
    order by started_at desc
    limit ${capped}
  `;
  return [...rows];
}

export async function listExecutionEvents(runId: string): Promise<unknown[]> {
  const sql = getSql();
  const rows = await sql`
    select id, seq, run_id, type, name, payload, created_at
    from execution_events
    where run_id = ${runId}
    order by seq asc
  `;
  return [...rows];
}
