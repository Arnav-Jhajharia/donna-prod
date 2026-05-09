import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSql, closeDb } from "../../src/donna/db.js";
import {
  insertSchedule,
  claimNextPending,
  sweepStuckClaimed,
  markFired,
  markErrored,
  markCancelled,
} from "../../src/donna/proactive/schedule.js";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

before(async () => {
  const sql = getSql();
  // ensure test user exists. matches 20260506020727_users.sql shape
  // (id uuid, phone text, profile_name text nullable).
  await sql`
    insert into users (id, phone, profile_name)
    values (${TEST_USER_ID}, '+10000000001', 'test-user')
    on conflict (id) do nothing
  `;
});

beforeEach(async () => {
  const sql = getSql();
  await sql`delete from donnaschedule where user_id = ${TEST_USER_ID}`;
});

after(async () => {
  const sql = getSql();
  await sql`delete from donnaschedule where user_id = ${TEST_USER_ID}`;
  await closeDb();
});

test("insertSchedule creates a pending row", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "test instruction",
    created_by: "system",
  });
  assert.ok(id);
  const sql = getSql();
  const rows = await sql<Array<{ status: string }>>`
    select status from donnaschedule where id = ${id}
  `;
  assert.equal(rows[0]?.status, "pending");
});

test("claimNextPending returns null when nothing due", async () => {
  await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() + 60_000).toISOString(),
    cause_kind: "scheduled",
    instruction: "future",
    created_by: "system",
  });
  const claimed = await claimNextPending();
  // could be null OR could be from another test row — assert: not the future one
  if (claimed) {
    assert.notEqual(claimed.user_id, TEST_USER_ID);
  } else {
    assert.equal(claimed, null);
  }
});

test("claimNextPending claims due rows and marks them claimed", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "due",
    created_by: "system",
  });
  // claim until we get our row (other tests may insert too)
  let attempts = 0;
  let claimed = await claimNextPending();
  while (claimed && claimed.id !== id && attempts < 5) {
    claimed = await claimNextPending();
    attempts++;
  }
  assert.ok(claimed);
  assert.equal(claimed?.id, id);
  assert.equal(claimed?.status, "claimed");
});

test("sweepStuckClaimed resets old claimed rows to pending", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "stuck",
    created_by: "system",
  });
  const sql = getSql();
  await sql`
    update donnaschedule
    set status = 'claimed', claimed_at = now() - interval '10 minutes'
    where id = ${id}
  `;
  const swept = await sweepStuckClaimed(5);
  assert.ok(swept >= 1);
  const rows = await sql<Array<{ status: string }>>`select status from donnaschedule where id = ${id}`;
  assert.equal(rows[0]?.status, "pending");
});

test("markFired transitions claimed→fired", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "x",
    created_by: "system",
  });
  // manually mark claimed first
  const sql = getSql();
  await sql`update donnaschedule set status='claimed', claimed_at=now() where id = ${id}`;
  await markFired(id);
  const rows = await sql<Array<{ status: string }>>`select status from donnaschedule where id = ${id}`;
  assert.equal(rows[0]?.status, "fired");
});

test("markErrored stores error message", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "x",
    created_by: "system",
  });
  const sql = getSql();
  await sql`update donnaschedule set status='claimed', claimed_at=now() where id = ${id}`;
  await markErrored(id, "boom");
  const rows = await sql<Array<{ status: string; error_message: string }>>`
    select status, error_message from donnaschedule where id = ${id}
  `;
  assert.equal(rows[0]?.status, "errored");
  assert.equal(rows[0]?.error_message, "boom");
});

test("markCancelled stores cancellation reason in error_message", async () => {
  const id = await insertSchedule({
    user_id: TEST_USER_ID,
    fire_at: new Date(Date.now() - 1000).toISOString(),
    cause_kind: "scheduled",
    instruction: "x",
    created_by: "system",
  });
  await markCancelled(id, "quiet hours");
  const sql = getSql();
  const rows = await sql<Array<{ status: string; error_message: string }>>`
    select status, error_message from donnaschedule where id = ${id}
  `;
  assert.equal(rows[0]?.status, "cancelled");
  assert.equal(rows[0]?.error_message, "quiet hours");
});
