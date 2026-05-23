import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { api } from "./api";

type StartResponse = {
  code: string;
  whatsappNumber: string;
  status: "pending" | "linked";
  createdAt: number;
};

type StatusResponse =
  | { status: "none" }
  | { status: "pending"; code: string; phone: null }
  | { status: "linked"; code: string; phone: string };

type State = {
  code: string | null;
  whatsappNumber: string | null;
  status: "idle" | "pending" | "linked" | "error";
  error: string | null;
};

const POLL_MS = 2000;

// orchestrates the pairing dance from the mobile side:
//   start() -> POST /api/pairing/start -> show code + number
//   then polls /api/pairing/status every 2s until linked.
// polling stops as soon as the component unmounts or status flips to linked.
export function usePairing() {
  const { getToken } = useAuth();
  const [state, setState] = useState<State>({
    code: null,
    whatsappNumber: null,
    status: "idle",
    error: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const tick = useCallback(async () => {
    try {
      const res = await api<StatusResponse>("/api/pairing/status", { getToken });
      if (res.status === "linked") {
        clearPoll();
        setState((s) => ({ ...s, status: "linked" }));
      }
    } catch (err) {
      // transient network errors during polling are non-fatal; keep trying.
      console.warn("pairing poll failed:", err);
    }
  }, [getToken, clearPoll]);

  const start = useCallback(async () => {
    try {
      const res = await api<StartResponse>("/api/pairing/start", {
        method: "POST",
        getToken,
      });
      setState({
        code: res.code,
        whatsappNumber: res.whatsappNumber,
        status: res.status === "linked" ? "linked" : "pending",
        error: null,
      });
      if (res.status !== "linked") {
        clearPoll();
        pollRef.current = setInterval(tick, POLL_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      setState((s) => ({ ...s, status: "error", error: msg }));
    }
  }, [getToken, tick, clearPoll]);

  useEffect(() => clearPoll, [clearPoll]);

  return { ...state, start };
}
