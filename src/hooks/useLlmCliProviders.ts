import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LlmCliEvent,
  LlmCliPrefs,
  LlmCliResult,
  LlmCliSeat,
  LlmCliSeatState,
  LlmCliSeatStates,
} from "../types/electron";

// State over the subscription-CLI IPC (src/helpers/llmCli/llmCliIpc.js). Main owns
// every decision and every secret; this hook only mirrors seat state and relays
// user actions. It never receives or stores a token.

export type SignInPromptEvent = Extract<LlmCliEvent, { type: "signin-prompt" }>;

const MAX_INSTALL_LINES = 12;
const INITIAL_SEAT: LlmCliSeatState = { status: "missing" };

type SeatMap<T> = Partial<Record<LlmCliSeat, T>>;

export function useLlmCliProviders() {
  const [seats, setSeats] = useState<LlmCliSeatStates>({
    claude: INITIAL_SEAT,
    codex: INITIAL_SEAT,
    grok: INITIAL_SEAT,
    agy: INITIAL_SEAT,
  });
  const [prefs, setPrefs] = useState<LlmCliPrefs>({ claudeEnabled: false });
  const [loaded, setLoaded] = useState(false);
  const [prompts, setPrompts] = useState<SeatMap<SignInPromptEvent>>({});
  const [installLines, setInstallLines] = useState<SeatMap<string[]>>({});
  const [errors, setErrors] = useState<SeatMap<string>>({});
  const [testing, setTesting] = useState<SeatMap<boolean>>({});
  const [testOk, setTestOk] = useState<SeatMap<boolean>>({});
  const mounted = useRef(true);

  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  const clearSeatNotes = useCallback((seat: LlmCliSeat) => {
    setErrors((prev) => ({ ...prev, [seat]: undefined }));
    setTestOk((prev) => ({ ...prev, [seat]: undefined }));
  }, []);

  const detect = useCallback(async () => {
    if (!api?.llmCliDetect) return;
    try {
      const next = await api.llmCliDetect();
      if (mounted.current && next) setSeats((prev) => ({ ...prev, ...next }));
    } catch {
      // Detection failure leaves the last known state; the row's Re-detect retries.
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    if (!api) return undefined;
    const unsubscribe = api.onLlmCliEvent?.((event) => {
      if (!mounted.current) return;
      switch (event.type) {
        case "state":
          setSeats((prev) => ({ ...prev, [event.seat]: event.state }));
          break;
        case "install-progress":
          setInstallLines((prev) => ({
            ...prev,
            [event.seat]: [...(prev[event.seat] ?? []), event.line].slice(-MAX_INSTALL_LINES),
          }));
          break;
        case "signin-prompt":
          setPrompts((prev) => ({ ...prev, [event.seat]: event }));
          break;
        case "signin-result":
          setPrompts((prev) => ({ ...prev, [event.seat]: undefined }));
          setErrors((prev) => ({ ...prev, [event.seat]: event.ok ? undefined : event.code }));
          break;
      }
    });
    void (async () => {
      await detect();
      try {
        const p = await api.llmCliGetPrefs?.();
        if (mounted.current && p) setPrefs(p);
      } catch {
        // Prefs default to the gated state.
      }
      if (mounted.current) setLoaded(true);
    })();
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [api, detect]);

  const noteResult = useCallback((seat: LlmCliSeat, result: LlmCliResult | undefined) => {
    if (!mounted.current) return;
    if (result && result.ok === false && !result.guided) {
      setErrors((prev) => ({ ...prev, [seat]: result.code ?? "generic" }));
    }
  }, []);

  const test = useCallback(
    async (seat: LlmCliSeat) => {
      if (!api?.llmCliTest) return;
      clearSeatNotes(seat);
      setTesting((prev) => ({ ...prev, [seat]: true }));
      try {
        const result = await api.llmCliTest(seat);
        if (!mounted.current) return;
        if (result?.ok) setTestOk((prev) => ({ ...prev, [seat]: true }));
        else noteResult(seat, result ?? { ok: false, code: "generic" });
      } catch {
        noteResult(seat, { ok: false, code: "generic" });
      } finally {
        if (mounted.current) setTesting((prev) => ({ ...prev, [seat]: false }));
      }
    },
    [api, clearSeatNotes, noteResult]
  );

  // `consentedUrl` is the table url the consent dialog showed, echoed unchanged.
  const install = useCallback(
    async (seat: LlmCliSeat, consentedUrl: string) => {
      if (!api?.llmCliInstallStart) return;
      clearSeatNotes(seat);
      setInstallLines((prev) => ({ ...prev, [seat]: [] }));
      try {
        noteResult(seat, await api.llmCliInstallStart(seat, consentedUrl));
      } catch {
        noteResult(seat, { ok: false, code: "install-failed" });
      }
    },
    [api, clearSeatNotes, noteResult]
  );

  const cancelInstall = useCallback((seat: LlmCliSeat) => api?.llmCliInstallCancel?.(seat), [api]);

  const signIn = useCallback(
    async (seat: LlmCliSeat) => {
      if (!api?.llmCliSignInStart) return;
      clearSeatNotes(seat);
      try {
        noteResult(seat, await api.llmCliSignInStart(seat));
      } catch {
        noteResult(seat, { ok: false, code: "generic" });
      }
    },
    [api, clearSeatNotes, noteResult]
  );

  const submitCode = useCallback(
    async (seat: LlmCliSeat, code: string) => {
      if (!api?.llmCliSignInSubmitCode) return;
      try {
        noteResult(seat, await api.llmCliSignInSubmitCode(seat, code));
      } catch {
        noteResult(seat, { ok: false, code: "generic" });
      }
    },
    [api, noteResult]
  );

  const cancelSignIn = useCallback(
    async (seat: LlmCliSeat) => {
      await api?.llmCliSignInCancel?.(seat);
      if (mounted.current) setPrompts((prev) => ({ ...prev, [seat]: undefined }));
    },
    [api]
  );

  const signOut = useCallback(
    async (seat: LlmCliSeat) => {
      if (!api?.llmCliSignOut) return;
      clearSeatNotes(seat);
      try {
        noteResult(seat, await api.llmCliSignOut(seat));
      } catch {
        noteResult(seat, { ok: false, code: "generic" });
      }
    },
    [api, clearSeatNotes, noteResult]
  );

  const setClaudeEnabled = useCallback(
    async (value: boolean) => {
      const result = await api?.llmCliSetPref?.("claudeEnabled", value);
      if (mounted.current && result?.success && result.prefs) setPrefs(result.prefs);
    },
    [api]
  );

  return {
    seats,
    prefs,
    loaded,
    prompts,
    installLines,
    errors,
    testing,
    testOk,
    detect,
    test,
    install,
    cancelInstall,
    signIn,
    submitCode,
    cancelSignIn,
    signOut,
    setClaudeEnabled,
  };
}
