import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSql, closeDb } from "../../src/donna/db.js";
import { runScheduleTickOnce } from "../../src/donna/proactive/executor.js";
import { insertSchedule } from "../../src/donna/proactive/schedule.js";
import type { RunTurnResult } from "../../src/donna/brain.js";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000002";
const TEST_PHONE = "+10000000002";

before(async () => {
  const sql = getSql();
  await sql`
    insert into users (id, phone, profile_name)
    values (${TEST_USER_ID}, ${TEST_PHONE}, 'test-user')
    on conflict (id) do nothing
  `;
});

beforeEach(async () => {
  const sql = getSql();
  await sql`delete from donnaschedule where user_id = ${TEST_USER_ID}`;
  await sql`delete from chat_messages where user_id = ${TEST_USER_ID}`;
});

after(async () => {
  const sql = getSql();
  await sql`delete from donnaschedule where user_id = ${TEST_USER_ID}`;
  await sql`delete from chat_messages where user_id = ${TEST_USER_ID}`;
  await closeDb();
});

function fakeSendBurstResult(messages: string[]): RunTurnResult {
  return {
    messages: [],
    newMessages: [
      { role: "user", content: [{ type: "text", text: "<proactive_cause kind=\"scheduled\">test</proactive_cause>" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "send_burst", input: { messages } } as never,
        ],
      },
    ],
    sends: messages,
    terminator: "send_burst",
    voiceViolations: [],
    model: "fake",
    iterations: 1,
    ptcInvocations: 0,
  };
}

function fakeDoNothingResult(): RunTurnResult {
  return {
    messages: [],
    newMessages: [
      { role: "user", content: [{ type: "text", text: "<proactive_cause>x</proactive_cause>" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "n1", name: "do_nothing", input: { reason: "stale" } } as never] },
    ],
    sends: [],
    terminator: "do_nothing",
    voiceViolations: [],
    model: "fake",
    iterations: 1,
    ptcInvocations: 0,
  };
}

function fakeDeferResult(fireAt: string): RunTurnResult {
  return {
    messages: [],
    newMessages: [
      { role: "user", content: [{ type: "text", text: "<proactive_cause>x</proactive_cause>" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "d1", name: "defer", input: { fire_at: fireAt, cause: { kind: "scheduled", instruction: "next wake" } } } as never] },
    ],
    sends: [],
    terminator: "defer",
    voiceViolations: [],
    model: "fake",
    iterations: 1,
    ptcInvocations: 0,
    nextSchedule: {
      fire_at: fireAt,
      cause: { kind: "scheduled", instruction: "next wake" },
    },
  };
}

test("executor send_burst path: claims row, dispatches, marks fired", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "test",
    created_by: "system",
  });
  const sentBodies: string[] = [];
  await runScheduleTickOnce({
    runTurnFn: async () => fakeSendBurstResult(["hello there"]),
    deliverFn: async (_userId: string, body: string) => { sentBodies.push(body); },
    nowOverride: new Date("2026-05-08T15:00:00Z"),
  });
  assert.deepEqual(sentBodies, ["hello there"]);
  const sql = getSql();
  const rows = await sql<Array<{ status: string }>>`select status from donnaschedule where id = ${id}`;
  assert.equal(rows[0]?.status, "fired");
});

test("executor do_nothing path: no delivery, marks fired", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "stale",
    created_by: "system",
  });
  const sentBodies: string[] = [];
  await runScheduleTickOnce({
    runTurnFn: async () => fakeDoNothingResult(),
    deliverFn: async (_userId: string, body: string) => { sentBodies.push(body); },
    nowOverride: new Date("2026-05-08T15:00:00Z"),
  });
  assert.deepEqual(sentBodies, []);
  const sql = getSql();
  const rows = await sql<Array<{ status: string }>>`select status from donnaschedule where id = ${id}`;
  assert.equal(rows[0]?.status, "fired");
});

test("executor defer path: marks current fired, inserts new pending row", async () => {
  await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "first",
    created_by: "system",
  });
  const future = new Date(Date.now() + 60_000).toISOString();
  await runScheduleTickOnce({
    runTurnFn: async () => fakeDeferResult(future),
    deliverFn: async () => undefined,
    nowOverride: new Date("2026-05-08T15:00:00Z"),
  });
  const sql = getSql();
  const rows = await sql<Array<{ status: string; instruction: string | null }>>`
    select status, instruction from donnaschedule where user_id = ${TEST_USER_ID} order by created_at
  `;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, "fired");
  assert.equal(rows[1]?.status, "pending");
  assert.equal(rows[1]?.instruction, "next wake");
});

test("executor with no due rows is a no-op", async () => {
  let invoked = false;
  await runScheduleTickOnce({
    runTurnFn: async () => { invoked = true; return fakeDoNothingResult(); },
    deliverFn: async () => undefined,
    nowOverride: new Date("2026-05-08T15:00:00Z"),
  });
  assert.equal(invoked, false);
});

test("executor errors on brain throw, marks errored", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "boom",
    created_by: "system",
  });
  await runScheduleTickOnce({
    runTurnFn: async () => { throw new Error("brain blew up"); },
    deliverFn: async () => undefined,
    nowOverride: new Date("2026-05-08T15:00:00Z"),
  });
  const sql = getSql();
  const rows = await sql<Array<{ status: string; error_message: string | null }>>`
    select status, error_message from donnaschedule where id = ${id}
  `;
  assert.equal(rows[0]?.status, "errored");
  assert.match(rows[0]?.error_message ?? "", /brain blew up/);
});

test("executor in quiet hours cancels and reschedules", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "should reschedule",
    created_by: "system",
  });
  await runScheduleTickOnce({
    runTurnFn: async () => fakeSendBurstResult(["should not fire"]),
    deliverFn: async () => undefined,
    nowOverride: new Date("2026-05-08T23:30:00Z"), // UTC quiet hours
  });
  const sql = getSql();
  const rows = await sql<Array<{ status: string; instruction: string | null }>>`
    select status, instruction from donnaschedule where user_id = ${TEST_USER_ID} order by created_at
  `;
  // original cancelled, new pending row inserted at 07:00
  const original = rows.find((r) => r.status === "cancelled");
  const reschedule = rows.find((r) => r.status === "pending");
  assert.ok(original, "expected a cancelled row");
  assert.ok(reschedule, "expected a pending reschedule row");
  assert.equal(reschedule?.instruction, "should reschedule");
});
