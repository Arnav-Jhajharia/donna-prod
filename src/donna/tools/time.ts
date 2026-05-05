import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: `returns the current wall-clock time in the requested IANA timezone.

when to use:
- the user asks what time it is, anywhere
- the user mentions a deadline, meeting, or schedule and you need "now" to reason about it
- any reasoning where the answer changes depending on what time it currently is

when NOT to use:
- the user gives you a specific time and asks you to reason about it (no need to fetch "now")
- converting between two named times that don't involve "now"
- the user asks about a date in the past or future where current wall-clock time is irrelevant`,
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, e.g. 'Asia/Tokyo'. Defaults to 'UTC'.",
      },
    },
  },
};

interface GetCurrentTimeInput {
  timezone?: string;
}

export async function getCurrentTimeHandler(input: unknown): Promise<string> {
  const { timezone = "UTC" } = (input ?? {}) as GetCurrentTimeInput;

  // throws RangeError on invalid IANA timezone — caller catches and surfaces
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
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  return `${iso} (${timezone})`;
}
