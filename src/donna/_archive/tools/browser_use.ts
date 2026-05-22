// browser_use — direct-only escape hatch onto the open web. drives a real
// chromium via stagehand (browserbase-backed in prod). slow, expensive, used
// only when no native integration covers the task.
//
// shape: single tool with task as a natural-language instruction. multi-step
// browsing happens inside a stagehand agent loop hidden behind one tool_use.
// the brain sees one tool_use + one tool_result; never one tool_use per click.
//
// session lifecycle: blocking handler, 90s wall-clock cap. each call creates a
// fresh browserbase session and releases on finally. no pooling, no per-user
// persistent context (v1.5 problem).

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import { recordExecutionEvent } from "../observability/execution.js";
import { Stagehand } from "@browserbasehq/stagehand";

const WALL_CLOCK_MS = 90_000;
const DEFAULT_MAX_STEPS = 25;
const HARD_CAP_STEPS = 50;
// stagehand uses an AI-SDK-style "provider/model" identifier. matches the
// model donna's brain uses; ANTHROPIC_API_KEY is already required in env.
const DEFAULT_MODEL =
  process.env.BROWSER_USE_MODEL ?? "anthropic/claude-sonnet-4-6";

interface BrowserUseInput {
  task?: string;
  starting_url?: string;
  max_steps?: number;
}

export interface BrowserUseResult {
  ok: boolean;
  result?: { summary?: string; final_message?: string; page_url?: string };
  steps_used: number;
  duration_ms: number;
  session_id?: string | null;
  live_view_url?: string | null;
  error?: string;
  reason?:
    | "captcha"
    | "login_required"
    | "max_steps"
    | "timeout"
    | "site_error"
    | "missing_credentials"
    | "init_failed";
}

export const browserUseTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "browser_use",
  description: `drive a real headless chromium to do something on the open web.

input:
- task: english instruction. one specific goal. e.g. "find 5 hotels in barcelona for jul 12-15 under $250/night, return top results with name + price + rating".
- starting_url: optional. saves a search step.
- max_steps: optional. default 25, hard cap 50. only raise if the task is genuinely multi-page.

returns: {
  ok: boolean,
  result?: { summary, final_message, page_url },
  steps_used: number,
  duration_ms: number,
  session_id, live_view_url,
  error?, reason?: "captcha"|"login_required"|"max_steps"|"timeout"|"site_error"|"missing_credentials"|"init_failed"
}

when to use (LAST RESORT, after these have been ruled out):
- no native integration covers the task (no gmail/calendar/notion/linear etc.)
- extract_url can't help because the user didn't give a link
- the task is on the public web

when NEVER to use:
- anything inside a logged-in account (no passwords ever)
- reading the user's own gmail (use gmail_*)
- arithmetic, dates, conversions (do those yourself)
- if the user already gave you the answer in chat
- summarizing a link they gave you (extract_url is cheaper)

discipline:
- one task per call. don't chain "find X then book Y".
- DO NOT retry on reason="captcha", "login_required", or "max_steps". explain honestly to the user.
- pre-warn the user with a short send_burst when the task is going to take ~30s. otherwise just go.
- summarize results in send_burst. never paste raw results.
- never call from inside code_execution. direct-only.`,
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "english instruction. specific, single goal.",
      },
      starting_url: {
        type: "string",
        description: "optional starting URL. saves a search step.",
      },
      max_steps: {
        type: "number",
        description: "max agent steps. default 25, hard cap 50.",
      },
    },
    required: ["task"],
  },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

function makeError(args: {
  startedAt: number;
  reason: BrowserUseResult["reason"];
  error: string;
  sessionId?: string | null;
  liveViewUrl?: string | null;
  stepsUsed?: number;
}): BrowserUseResult {
  return {
    ok: false,
    steps_used: args.stepsUsed ?? 0,
    duration_ms: Date.now() - args.startedAt,
    session_id: args.sessionId ?? null,
    live_view_url: args.liveViewUrl ?? null,
    error: args.error,
    reason: args.reason,
  };
}

export async function browserUseHandler(input: unknown): Promise<BrowserUseResult> {
  const startedAt = Date.now();
  const { task, starting_url, max_steps } = (input ?? {}) as BrowserUseInput;

  if (!task || typeof task !== "string" || task.trim().length === 0) {
    throw new Error("browser_use: task required");
  }

  const ctx = getTurnContext();
  const runId = ctx.runId;

  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    await recordExecutionEvent(runId, "browser_session_end", "browser_use", {
      ok: false,
      reason: "missing_credentials",
      duration_ms: Date.now() - startedAt,
    });
    return makeError({
      startedAt,
      reason: "missing_credentials",
      error: "BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID required",
    });
  }

  const cappedSteps = Math.min(
    Math.max(typeof max_steps === "number" && max_steps > 0 ? max_steps : DEFAULT_MAX_STEPS, 1),
    HARD_CAP_STEPS,
  );

  let stagehand: Stagehand | null = null;
  let sessionId: string | null = null;
  let liveViewUrl: string | null = null;

  try {
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey,
      projectId,
      model: DEFAULT_MODEL,
      verbose: 0,
    });

    // race init against wall clock; if init alone exceeds the budget, bail.
    await Promise.race([
      stagehand.init(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("init timeout")), WALL_CLOCK_MS),
      ),
    ]).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`init_failed: ${msg}`);
    });

    sessionId = stagehand.browserbaseSessionID ?? null;
    liveViewUrl = stagehand.browserbaseSessionURL ?? null;

    await recordExecutionEvent(runId, "browser_session_start", "browser_use", {
      session_id: sessionId,
      live_view_url: liveViewUrl,
      task: task.slice(0, 500),
      starting_url: starting_url ?? null,
      max_steps: cappedSteps,
    });

    // construct the full instruction. starting_url is folded into the agent's
    // instruction so the agent navigates as its first step.
    const fullInstruction = starting_url
      ? `start by navigating to ${starting_url}, then: ${task}`
      : task;

    // run the stagehand agent inside the remaining wall-clock budget.
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(WALL_CLOCK_MS - elapsed, 5_000);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), remaining);

    const agent = stagehand.agent({ model: DEFAULT_MODEL });

    let agentResult: { message?: string; completed?: boolean; actions?: unknown[] } = {};
    let timedOut = false;
    try {
      agentResult = await agent.execute({
        instruction: fullInstruction,
        maxSteps: cappedSteps,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted || /abort|timeout/i.test(msg)) {
        timedOut = true;
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    const stepsUsed = Array.isArray(agentResult.actions) ? agentResult.actions.length : 0;
    const finalMessage = typeof agentResult.message === "string" ? agentResult.message : "";
    const pageUrl: string | undefined = undefined;

    if (timedOut) {
      await recordExecutionEvent(runId, "browser_session_end", "browser_use", {
        ok: false,
        reason: "timeout",
        steps_used: stepsUsed,
        duration_ms: Date.now() - startedAt,
        session_id: sessionId,
        live_view_url: liveViewUrl,
      });
      return makeError({
        startedAt,
        reason: "timeout",
        error: `agent timed out after ${WALL_CLOCK_MS}ms`,
        sessionId,
        liveViewUrl,
        stepsUsed,
      });
    }

    if (!agentResult.completed && stepsUsed >= cappedSteps) {
      await recordExecutionEvent(runId, "browser_session_end", "browser_use", {
        ok: false,
        reason: "max_steps",
        steps_used: stepsUsed,
        duration_ms: Date.now() - startedAt,
        session_id: sessionId,
        live_view_url: liveViewUrl,
      });
      return makeError({
        startedAt,
        reason: "max_steps",
        error: `agent did not complete within ${cappedSteps} steps`,
        sessionId,
        liveViewUrl,
        stepsUsed,
      });
    }

    await recordExecutionEvent(runId, "browser_session_end", "browser_use", {
      ok: true,
      steps_used: stepsUsed,
      duration_ms: Date.now() - startedAt,
      session_id: sessionId,
      live_view_url: liveViewUrl,
      page_url: pageUrl ?? null,
    });

    return {
      ok: true,
      result: {
        summary: finalMessage,
        final_message: finalMessage,
        page_url: pageUrl,
      },
      steps_used: stepsUsed,
      duration_ms: Date.now() - startedAt,
      session_id: sessionId,
      live_view_url: liveViewUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason: BrowserUseResult["reason"] = msg.startsWith("init_failed")
      ? "init_failed"
      : "site_error";
    await recordExecutionEvent(runId, "browser_session_end", "browser_use", {
      ok: false,
      reason,
      error: msg.slice(0, 1000),
      duration_ms: Date.now() - startedAt,
      session_id: sessionId,
      live_view_url: liveViewUrl,
    });
    return makeError({
      startedAt,
      reason,
      error: msg,
      sessionId,
      liveViewUrl,
    });
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[browser_use] close failed: ${msg.slice(0, 200)}`);
      }
    }
  }
}
