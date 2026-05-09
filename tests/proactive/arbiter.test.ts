import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrate } from "../../src/donna/proactive/arbiter.js";
import type { ProactiveCause } from "../../src/donna/proactive/cause.js";

const cause: ProactiveCause = {
  kind: "scheduled",
  payload: {},
  set_at: "2026-05-08T12:00:00Z",
  schedule_id: "11111111-1111-1111-1111-111111111111",
  instruction: "test",
};

test("arbiter allows during day with no recent send", () => {
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    now: new Date("2026-05-08T15:00:00Z"),
    user_tz: "UTC",
  });
  assert.equal(decision.allow, true);
});

test("arbiter rejects during quiet hours (UTC 23:30)", () => {
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    now: new Date("2026-05-08T23:30:00Z"),
    user_tz: "UTC",
  });
  assert.equal(decision.allow, false);
  if (!decision.allow) {
    assert.match(decision.reason, /quiet hours/i);
    assert.ok(decision.reschedule_at);
  }
});

test("arbiter rejects within cooldown window of last assistant message", () => {
  const justSent = new Date("2026-05-08T14:50:00Z");
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    last_assistant_at: justSent,
    now: new Date("2026-05-08T15:00:00Z"),
    user_tz: "UTC",
  });
  assert.equal(decision.allow, false);
  if (!decision.allow) {
    assert.match(decision.reason, /cooldown/i);
  }
});

test("arbiter allows once cooldown has elapsed (>30min ago)", () => {
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    last_assistant_at: new Date("2026-05-08T13:00:00Z"),
    now: new Date("2026-05-08T15:00:00Z"),
    user_tz: "UTC",
  });
  assert.equal(decision.allow, true);
});

test("arbiter quiet-hours reschedule_at points to next 07:00 user-local", () => {
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    now: new Date("2026-05-08T23:30:00Z"),
    user_tz: "UTC",
  });
  if (decision.allow) return;
  assert.ok(decision.reschedule_at);
  const r = new Date(decision.reschedule_at!);
  assert.equal(r.getUTCHours(), 7);
});

test("arbiter handles non-UTC tz (Asia/Singapore = UTC+8) — 06:00 SGT is quiet (22:00 UTC)", () => {
  // 22:00 UTC = 06:00 SGT next day. SGT 06:00 is in quiet window (00:00-07:00 SGT).
  const decision = arbitrate({
    user_id: "u1",
    cause,
    recent_messages: [],
    now: new Date("2026-05-08T22:00:00Z"),
    user_tz: "Asia/Singapore",
  });
  assert.equal(decision.allow, false);
});
