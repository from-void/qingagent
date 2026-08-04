import { useCallback, useEffect, useRef, useState } from "react";
import type { DemoBarKind } from "../components/MorphDebugPanel";
import { morphTuning } from "../data/barMorph";
import {
  getRevealPresentationConfig,
  subscribeRevealPresentationConfig,
} from "../data/revealPresentationConfig";

const MORPH_FADE_MS = 180;

export function useWorkspaceDebugControls() {
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [demoBarKind, setDemoBarKind] = useState<DemoBarKind>("bigplan");
  const [demoBarShown, setDemoBarShown] = useState(false);
  const [inputContentOut, setInputContentOut] = useState(false);
  const [debugMode, setDebugMode] = useState(() => {
    try {
      return localStorage.getItem("qingagent:debug-mode") === "1";
    } catch {
      return false;
    }
  });
  const [revealConfig, setRevealConfig] = useState(() =>
    getRevealPresentationConfig(),
  );
  const [revealReplayNonce, setRevealReplayNonce] = useState(0);
  const morphTimersRef = useRef<Set<number>>(new Set());

  const clearMorphTimers = useCallback(() => {
    for (const timer of morphTimersRef.current) window.clearTimeout(timer);
    morphTimersRef.current.clear();
  }, []);

  const scheduleMorph = useCallback((callback: () => void, delayMs: number) => {
    const timer = window.setTimeout(() => {
      morphTimersRef.current.delete(timer);
      callback();
    }, delayMs);
    morphTimersRef.current.add(timer);
  }, []);

  useEffect(() => subscribeRevealPresentationConfig(setRevealConfig), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        (event.key !== "H" && event.key !== "h")
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        target?.closest?.(".wf-doc, [contenteditable], input, textarea")
      )
        return;
      event.preventDefault();
      setDevToolsOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!devToolsOpen) {
      clearMorphTimers();
      setDemoBarShown(false);
      setInputContentOut(false);
    }
    return clearMorphTimers;
  }, [clearMorphTimers, devToolsOpen]);

  const morphEnterFresh = useCallback(() => {
    setInputContentOut(true);
    scheduleMorph(() => setDemoBarShown(true), MORPH_FADE_MS);
  }, [scheduleMorph]);

  const handleMorphReturn = useCallback(() => {
    clearMorphTimers();
    setDemoBarShown(false);
    setInputContentOut(false);
  }, [clearMorphTimers]);

  const handleMorphEnter = useCallback(() => {
    if (!demoBarShown) {
      morphEnterFresh();
      return;
    }
    handleMorphReturn();
    scheduleMorph(
      morphEnterFresh,
      morphTuning.durationMs + MORPH_FADE_MS + 140,
    );
  }, [demoBarShown, handleMorphReturn, morphEnterFresh, scheduleMorph]);

  const handleMorphKind = useCallback(
    (kind: DemoBarKind) => {
      setDemoBarKind(kind);
      if (demoBarShown) {
        handleMorphReturn();
        scheduleMorph(
          morphEnterFresh,
          morphTuning.durationMs + MORPH_FADE_MS + 140,
        );
      }
    },
    [demoBarShown, handleMorphReturn, morphEnterFresh, scheduleMorph],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        !event.shiftKey ||
        (event.key !== "D" && event.key !== "d")
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        target?.closest?.(".wf-doc, [contenteditable], input, textarea")
      )
        return;
      event.preventDefault();
      setDebugMode((value) => {
        const next = !value;
        try {
          localStorage.setItem("qingagent:debug-mode", next ? "1" : "0");
        } catch {
          /* ignore */
        }
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.body.dataset.debug = debugMode ? "1" : "0";
  }, [debugMode]);

  const handleRevealReplay = useCallback(() => {
    setRevealReplayNonce((nonce) => nonce + 1);
  }, []);

  return {
    debugMode,
    demoBarKind,
    demoBarShown,
    devToolsOpen,
    handleMorphEnter,
    handleMorphKind,
    handleMorphReturn,
    handleRevealReplay,
    inputContentOut,
    revealConfig,
    revealReplayNonce,
    setDevToolsOpen,
  };
}
