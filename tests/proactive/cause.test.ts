import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCauseXml,
  synthesizeCauseMessage,
  type ProactiveCause,
} from "../../src/donna/proactive/cause.js";

const baseCause: ProactiveCause = {
  kind: "scheduled",
  payload: {},
  set_at: "2026-05-08T18:00:00Z",
  schedule_id: "11111111-1111-1111-1111-111111111111",
  instruction: "remind nikhil about workout",
};

test("renderCauseXml emits tagged xml with kind, set_at, instruction", () => {
  const xml = renderCauseXml(baseCause);
  assert.match(xml, /^<proactive_cause /);
  assert.match(xml, /kind="scheduled"/);
  assert.match(xml, /set_at="2026-05-08T18:00:00Z"/);
  assert.match(xml, /remind nikhil about workout/);
  assert.match(xml, /<\/proactive_cause>$/);
});

test("renderCauseXml escapes xml-unsafe characters in instruction", () => {
  const cause: ProactiveCause = { ...baseCause, instruction: "ping <user> & co" };
  const xml = renderCauseXml(cause);
  assert.match(xml, /ping &lt;user&gt; &amp; co/);
});

test("renderCauseXml includes payload as nested json when non-empty", () => {
  const cause: ProactiveCause = {
    ...baseCause,
    kind: "scan_gmail",
    payload: { since_hours: 4 },
  };
  const xml = renderCauseXml(cause);
  assert.match(xml, /payload=/);
  assert.match(xml, /since_hours/);
});

test("synthesizeCauseMessage returns a user-role message wrapping the xml", () => {
  const msg = synthesizeCauseMessage(baseCause);
  assert.equal(msg.role, "user");
  assert.ok(Array.isArray(msg.content));
  const block = (msg.content as Array<{ type: string; text: string }>)[0];
  assert.equal(block.type, "text");
  assert.match(block.text, /<proactive_cause /);
});
