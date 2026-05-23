import type { MiddlewareHandler } from "hono";
import { clerkMiddleware, getAuth } from "@hono/clerk-auth";

// every authenticated mobile route runs through this. clerkMiddleware reads
// CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY from env, verifies the bearer jwt,
// and exposes auth() on the context. requireUser is the 401 gate.
export const clerkAuth = clerkMiddleware();

export const requireUser: MiddlewareHandler = async (c, next) => {
  const auth = getAuth(c);
  if (!auth?.userId) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  await next();
};

export function userId(c: Parameters<MiddlewareHandler>[0]): string {
  const auth = getAuth(c);
  if (!auth?.userId) throw new Error("userId called without requireUser");
  return auth.userId;
}
