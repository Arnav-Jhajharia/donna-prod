import { test } from "node:test";
import assert from "node:assert/strict";
import { selectToolsForMode, tool_definitions } from "../../src/donna/tools/index.js";

test("reactive mode includes send_burst", () => {
  const tools = selectToolsForMode("reactive");
  const names = tools.map((t) => ("name" in t ? t.name : t.type));
  assert.ok(names.includes("send_burst"));
});

test("proactive mode includes send_burst, get_current_time, gmail tools", () => {
  const tools = selectToolsForMode("proactive");
  const names = tools.map((t) => ("name" in t ? t.name : t.type));
  assert.ok(names.includes("send_burst"));
  assert.ok(names.includes("get_current_time"));
  assert.ok(names.includes("gmail_list_recent"));
});

test("code_execution server tool included in both modes", () => {
  const reactive = selectToolsForMode("reactive").map((t) =>
    "type" in t && typeof t.type === "string" && t.type.startsWith("code_execution") ? "code_execution" : ("name" in t ? t.name : ""),
  );
  const proactive = selectToolsForMode("proactive").map((t) =>
    "type" in t && typeof t.type === "string" && t.type.startsWith("code_execution") ? "code_execution" : ("name" in t ? t.name : ""),
  );
  assert.ok(reactive.includes("code_execution"));
  assert.ok(proactive.includes("code_execution"));
});

test("integration_connect is reactive-only (not in proactive)", () => {
  const reactiveNames = selectToolsForMode("reactive").map((t) => ("name" in t ? t.name : ""));
  const proactiveNames = selectToolsForMode("proactive").map((t) => ("name" in t ? t.name : ""));
  assert.ok(reactiveNames.includes("integration_connect"));
  assert.ok(!proactiveNames.includes("integration_connect"));
});

test("filtering returns a subset of tool_definitions", () => {
  const reactive = selectToolsForMode("reactive");
  const proactive = selectToolsForMode("proactive");
  assert.ok(reactive.length <= tool_definitions.length);
  assert.ok(proactive.length <= tool_definitions.length);
  // proactive should be strictly smaller because connect/set_mode/disconnect are reactive-only
  assert.ok(proactive.length < reactive.length);
});
