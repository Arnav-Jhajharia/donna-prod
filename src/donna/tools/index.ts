import type {
  Tool,
  CodeExecutionTool20250825,
  MessageCreateParams,
} from "@anthropic-ai/sdk/resources/messages";
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/index.js";
import type { BrainMode } from "../brain.js";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";
import { sendBurstTool, sendBurstHandler } from "./send_burst.js";
import {
  gmailListRecentTool,
  gmailListRecentHandler,
  gmailSearchTool,
  gmailSearchHandler,
  gmailListSentTool,
  gmailListSentHandler,
  gmailReadThreadTool,
  gmailReadThreadHandler,
} from "./gmail.js";
import {
  integrationStatusTool,
  integrationStatusHandler,
  integrationConnectTool,
  integrationConnectHandler,
  integrationSetModeTool,
  integrationSetModeHandler,
  integrationDisconnectTool,
  integrationDisconnectHandler,
} from "./integrations.js";
import { doNothingTool, doNothingHandler } from "./do_nothing.js";
import { deferTool, deferHandler } from "./defer.js";
import { createScheduleTool, createScheduleHandler } from "./create_schedule.js";
import { recallTool, recallHandler } from "./recall.js";
import {
  subscriptionsListTool,
  subscriptionsListHandler,
  subscriptionsSummaryTool,
  subscriptionsSummaryHandler,
  subscriptionsRecordTool,
  subscriptionsRecordHandler,
  subscriptionsUpdateTool,
  subscriptionsUpdateHandler,
  subscriptionsMergeTool,
  subscriptionsMergeHandler,
} from "./subscriptions.js";
import {
  threadsOpenForMeTool,
  threadsOpenForMeHandler,
  threadsSearchTool,
  threadsSearchHandler,
  threadsGetTool,
  threadsGetHandler,
  threadsMarkDoneTool,
  threadsMarkDoneHandler,
  threadsPinTool,
  threadsPinHandler,
  peopleTopTool,
  peopleTopHandler,
} from "./threads.js";
import { agendasAdvanceTool, agendasAdvanceHandler } from "./agendas.js";
import {
  logMealTool,
  logMealHandler,
  updateMealTool,
  updateMealHandler,
  deleteMealTool,
  deleteMealHandler,
  setFoodGoalTool,
  setFoodGoalHandler,
  saveMealAliasTool,
  saveMealAliasHandler,
  logMealFromAliasTool,
  logMealFromAliasHandler,
  parseFoodTextTool,
  parseFoodTextHandler,
  lookupFoodTool,
  lookupFoodHandler,
  getFoodGoalTool,
  getFoodGoalHandler,
  getDailySummaryTool,
  getDailySummaryHandler,
  getMealHistoryTool,
  getMealHistoryHandler,
  listMealAliasesTool,
  listMealAliasesHandler,
} from "./calories/index.js";

// Tool already carries cache_control?: CacheControlEphemeral | null | undefined.
// We alias it here to make the intent explicit without narrowing out null (which
// would create an incompatible intersection).
type ToolWithCache = Tool & {
  cache_control?: CacheControlEphemeral | null;
};

export type ToolWithModes = ToolWithCache & {
  modes: ReadonlySet<BrainMode>;
};

// the code_execution server tool. anthropic runs the python sandbox; we only
// see (a) the python claude wrote, (b) any tool_use blocks our handlers must
// answer (now carrying a `caller` field), (c) the final stdout.
//
// tools opted into PTC declare `allowed_callers: ["code_execution_20250825"]`.
// send_burst and the time tool stay direct-only — terminator and single-shot.
export const codeExecutionTool: CodeExecutionTool20250825 = {
  type: "code_execution_20250825",
  name: "code_execution",
};

// no cache_control here. the system block in brain.ts carries cache_control,
// which (per anthropic prefix-match rules) caches tools + system together —
// a strict superset of what a tool-level breakpoint would cover. brain.ts
// also adds a message-level breakpoint per turn, which is where the real
// caching win lives once the conversation prefix exceeds the model's
// minimum cacheable size (2048 tokens on sonnet 4.6).
export const tool_definitions: Array<ToolWithModes | CodeExecutionTool20250825> = [
  codeExecutionTool,
  getCurrentTimeTool,
  gmailListRecentTool,
  gmailSearchTool,
  gmailListSentTool,
  gmailReadThreadTool,
  integrationStatusTool,
  integrationConnectTool,
  integrationSetModeTool,
  integrationDisconnectTool,
  recallTool,
  subscriptionsListTool,
  subscriptionsSummaryTool,
  subscriptionsRecordTool,
  subscriptionsUpdateTool,
  subscriptionsMergeTool,
  threadsOpenForMeTool,
  threadsSearchTool,
  threadsGetTool,
  threadsMarkDoneTool,
  threadsPinTool,
  peopleTopTool,
  agendasAdvanceTool,
  sendBurstTool,
  doNothingTool,
  deferTool,
  createScheduleTool,
  // calorie tracker — direct writes
  logMealTool,
  updateMealTool,
  deleteMealTool,
  setFoodGoalTool,
  saveMealAliasTool,
  logMealFromAliasTool,
  // calorie tracker — ptc reads
  parseFoodTextTool,
  lookupFoodTool,
  getFoodGoalTool,
  getDailySummaryTool,
  getMealHistoryTool,
  listMealAliasesTool,
];

// satisfy MessageCreateParams["tools"] (which is a union including the server
// tool variants). this cast is the cleanest way to keep our local inferred
// type while staying compatible with the SDK.
export const sdk_tools = tool_definitions as MessageCreateParams["tools"];

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
  send_burst: sendBurstHandler,
  gmail_list_recent: gmailListRecentHandler,
  gmail_search: gmailSearchHandler,
  gmail_list_sent: gmailListSentHandler,
  gmail_read_thread: gmailReadThreadHandler,
  integration_status: integrationStatusHandler,
  integration_connect: integrationConnectHandler,
  integration_set_mode: integrationSetModeHandler,
  integration_disconnect: integrationDisconnectHandler,
  recall: recallHandler,
  subscriptions_list: subscriptionsListHandler,
  subscriptions_summary: subscriptionsSummaryHandler,
  subscriptions_record: subscriptionsRecordHandler,
  subscriptions_update: subscriptionsUpdateHandler,
  subscriptions_merge: subscriptionsMergeHandler,
  threads_open_for_me: threadsOpenForMeHandler,
  threads_search: threadsSearchHandler,
  threads_get: threadsGetHandler,
  threads_mark_done: threadsMarkDoneHandler,
  threads_pin: threadsPinHandler,
  people_top: peopleTopHandler,
  agendas_advance: agendasAdvanceHandler,
  do_nothing: doNothingHandler,
  defer: deferHandler,
  create_schedule: createScheduleHandler,
  log_meal: logMealHandler,
  update_meal: updateMealHandler,
  delete_meal: deleteMealHandler,
  set_food_goal: setFoodGoalHandler,
  save_meal_alias: saveMealAliasHandler,
  log_meal_from_alias: logMealFromAliasHandler,
  parse_food_text: parseFoodTextHandler,
  lookup_food: lookupFoodHandler,
  get_food_goal: getFoodGoalHandler,
  get_daily_summary: getDailySummaryHandler,
  get_meal_history: getMealHistoryHandler,
  list_meal_aliases: listMealAliasesHandler,
};

export const TERMINATORS = new Set<string>(["send_burst", "do_nothing", "defer"]);

// names of tools opted into PTC. used by the brain to tag observability
// events so we can split direct vs ptc-driven invocations in metrics.
export const PTC_ELIGIBLE = new Set<string>([
  "gmail_list_recent",
  "gmail_search",
  "gmail_list_sent",
  "gmail_read_thread",
  "subscriptions_list",
  "threads_open_for_me",
  "threads_search",
  "threads_get",
  "people_top",
  "parse_food_text",
  "lookup_food",
  "get_food_goal",
  "get_daily_summary",
  "get_meal_history",
  "list_meal_aliases",
]);

function isCodeExecutionTool(
  t: ToolWithModes | CodeExecutionTool20250825,
): t is CodeExecutionTool20250825 {
  return "type" in t && typeof t.type === "string" && t.type.startsWith("code_execution");
}

export function selectToolsForMode(
  mode: BrainMode,
): Array<ToolWithModes | CodeExecutionTool20250825> {
  return tool_definitions.filter((t) => {
    if (isCodeExecutionTool(t)) return true;
    return t.modes.has(mode);
  });
}
