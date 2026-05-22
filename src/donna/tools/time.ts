import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// example of a non-terminator tool. demonstrates the pattern:
// - export a `Tool` describing name/description/input_schema for the model
// - export a handler that takes `unknown` input and returns a string result
//
// brain.ts wires the two together via tools/index.ts: model emits a tool_use
// block with this name, brain calls the handler, sends back a tool_result.
export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: `returns the current wall-clock time in the requested IANA timezone.

use when reasoning depends on "now" (deadlines, "what time is it", scheduling).`,
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, e.g. 'Asia/Tokyo'. defaults to 'UTC'.",
      },
    },
  },
};

interface GetCurrentTimeInput {
  timezone?: string;
}

export async function getCurrentTimeHandler(input: unknown): Promise<string> {
  const { timezone = "UTC" } = (input ?? {}) as GetCurrentTimeInput;

  // throws RangeError on invalid IANA timezone — brain.ts catches and surfaces
  // it back to the model as is_error: true so it can recover.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  return `${iso} (${timezone})`;
}
