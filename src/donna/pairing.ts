// in-memory pairing store. the flow:
//   1. mobile (authenticated) calls startPairing(userId) -> short code
//   2. user texts the code to donna's whatsapp number
//   3. whatsapp webhook calls completePairing(code, phone)
//   4. mobile polls statusFor(userId) until "linked"
//
// in-process state is fine for v1: pairing is short-lived and tied to a
// single user session. when we deploy to more than one node, this moves
// to redis or a db row keyed by code.

const TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to switch apps, short enough to feel ephemeral

type PendingEntry = {
  userId: string;
  code: string;
  createdAt: number;
  status: "pending" | "linked";
  phone?: string;
};

const byCode = new Map<string, PendingEntry>();
const byUser = new Map<string, PendingEntry>();

// 6 chars from an unambiguous alphabet (no 0/O/1/I/L). a person reads this
// off a screen and types it on a phone keyboard, so visually clean matters.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
  }
  return out;
}

function gc(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [code, entry] of byCode) {
    if (entry.createdAt < cutoff && entry.status === "pending") {
      byCode.delete(code);
      if (byUser.get(entry.userId)?.code === code) byUser.delete(entry.userId);
    }
  }
}

export function startPairing(userId: string): PendingEntry {
  gc();
  // if there's an existing pending code, return it — idempotent restart.
  const existing = byUser.get(userId);
  if (existing && existing.status === "pending") return existing;

  let code = generateCode();
  while (byCode.has(code)) code = generateCode();

  const entry: PendingEntry = {
    userId,
    code,
    createdAt: Date.now(),
    status: "pending",
  };
  byCode.set(code, entry);
  byUser.set(userId, entry);
  return entry;
}

export function completePairing(rawCode: string, phone: string): PendingEntry | null {
  gc();
  const code = rawCode.trim().toUpperCase();
  const entry = byCode.get(code);
  if (!entry) return null;
  if (entry.status === "linked") return entry;
  entry.status = "linked";
  entry.phone = phone;
  return entry;
}

export function statusFor(userId: string): PendingEntry | null {
  gc();
  return byUser.get(userId) ?? null;
}
