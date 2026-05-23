import { Hono } from "hono";
import { requireUser, userId } from "./auth.js";
import { startPairing, statusFor } from "../pairing.js";

// /api/pairing — endpoints the mobile app calls during onboarding to link
// the user's phone number (the one they whatsapp from) to their clerk user.
// no body needed: identity comes from the bearer jwt.
export const pairing = new Hono();

pairing.use("*", requireUser);

pairing.post("/start", (c) => {
  const entry = startPairing(userId(c));
  const whatsappNumber = process.env.DONNA_WHATSAPP_NUMBER ?? "";
  return c.json({
    code: entry.code,
    whatsappNumber,
    status: entry.status,
    createdAt: entry.createdAt,
  });
});

pairing.get("/status", (c) => {
  const entry = statusFor(userId(c));
  if (!entry) return c.json({ status: "none" });
  return c.json({
    status: entry.status,
    code: entry.code,
    phone: entry.phone ?? null,
  });
});
