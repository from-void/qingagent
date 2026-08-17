import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  CoachMarkId,
  OnboardingSettingsResponse,
  OnboardingState,
  OnboardingStatus,
  UpdateOnboardingStateResponse,
} from "@qingagent/contract-ts";
import { useBackendConnection } from "../backendConnectionStore";

type LoadStatus = "loading" | "ready" | "error";

interface OnboardingSettingsValue {
  status: LoadStatus;
  state: OnboardingState | null;
  coachSeen: ReadonlySet<CoachMarkId>;
  complete: (status: OnboardingStatus) => Promise<boolean>;
  markCoachSeen: (id: CoachMarkId) => Promise<boolean>;
}

const FALLBACK_VALUE: OnboardingSettingsValue = {
  status: "error",
  state: null,
  coachSeen: new Set(),
  complete: async () => false,
  markCoachSeen: async () => false,
};

const OnboardingSettingsContext = createContext<OnboardingSettingsValue>(FALLBACK_VALUE);

export function OnboardingSettingsProvider({ children }: { children: ReactNode }) {
  const backend = useBackendConnection();
  const attachMode = backend?.mode === "attach" || (() => {
    try { return window.electron?.getBackendConnection?.()?.mode === "attach"; } catch { return false; }
  })();
  const [status, setStatus] = useState<LoadStatus>(attachMode ? "ready" : "loading");
  const [state, setState] = useState<OnboardingState | null>(null);
  const [coachSeen, setCoachSeen] = useState<ReadonlySet<CoachMarkId>>(() => new Set());

  useEffect(() => {
    if (attachMode) {
      setStatus("ready");
      setState(null);
      setCoachSeen(new Set());
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void (async () => {
      try {
        const response = await fetch("/api/v1/settings/onboarding", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("onboarding settings unavailable");
        const body = (await response.json()) as OnboardingSettingsResponse;
        if (controller.signal.aborted) return;
        setState(body.state);
        setCoachSeen(new Set(body.coachSeen));
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [attachMode]);

  const complete = useCallback(async (nextStatus: OnboardingStatus): Promise<boolean> => {
    if (attachMode) return false;
    try {
      const response = await fetch("/api/v1/settings/onboarding", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as UpdateOnboardingStateResponse;
      setState(body.state);
      setStatus("ready");
      return true;
    } catch {
      return false;
    }
  }, [attachMode]);

  const markCoachSeen = useCallback(async (id: CoachMarkId): Promise<boolean> => {
    if (attachMode) return false;
    try {
      const response = await fetch(
        `/api/v1/settings/onboarding/coach/${encodeURIComponent(id)}`,
        { method: "PUT" },
      );
      if (!response.ok) return false;
      setCoachSeen((current) => new Set([...current, id]));
      return true;
    } catch {
      return false;
    }
  }, [attachMode]);

  const value = useMemo<OnboardingSettingsValue>(() => ({
    status,
    state,
    coachSeen,
    complete,
    markCoachSeen,
  }), [coachSeen, complete, markCoachSeen, state, status]);

  return (
    <OnboardingSettingsContext.Provider value={value}>
      {children}
    </OnboardingSettingsContext.Provider>
  );
}

export function useOnboardingSettings(): OnboardingSettingsValue {
  return useContext(OnboardingSettingsContext);
}
