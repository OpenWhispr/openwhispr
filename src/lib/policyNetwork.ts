import { refreshEffectivePolicy, usePolicyStore } from "../stores/policyStore";

function allowed(target: string): boolean {
  const url = new URL(target, window.location.href);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return true;
  const policy = usePolicyStore.getState();
  if (!policy.deviceReady || policy.localOnly || policy.code === "DEVICE_POLICY_INVALID")
    return false;
  // As in main: only a device policy that can't be met yet narrows traffic to
  // the control plane, and a verdict still loading stops nothing.
  if (policy.status !== "error" || !policy.deviceManaged) return true;
  const origins = [
    import.meta.env.VITE_AUTH_URL || "https://auth.openwhispr.com",
    import.meta.env.VITE_OPENWHISPR_API_URL || "https://api.openwhispr.com",
  ].map((value) => new URL(value).origin);
  return (
    origins.includes(url.origin) &&
    (url.pathname.startsWith("/api/auth/") ||
      url.pathname === "/api/check-user" ||
      url.pathname === "/api/workspace-policy")
  );
}

export function installPolicyNetworkGuard(): () => void {
  const target = window;
  const original = target.fetch.bind(target);
  const pending = new Map<AbortController, string>();
  const blocked = () =>
    Object.assign(new Error("Blocked by device policy"), { code: "DEVICE_POLICY_BLOCKED" });
  const unsubscribe = usePolicyStore.subscribe(() => {
    for (const [controller, url] of pending) if (!allowed(url)) controller.abort(blocked());
  });
  target.fetch = async (input, init) => {
    if (!usePolicyStore.getState().deviceReady) await refreshEffectivePolicy();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!allowed(url)) throw blocked();
    const controller = new AbortController();
    pending.set(controller, url);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    try {
      const response = await original(input, {
        ...init,
        signal: callerSignal
          ? AbortSignal.any([callerSignal, controller.signal])
          : controller.signal,
      });
      if (!allowed(url)) throw blocked();
      if (!response.body) {
        pending.delete(controller);
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            if (!allowed(url)) throw blocked();
            const chunk = await reader.read();
            if (!allowed(url)) throw blocked();
            if (chunk.done) {
              pending.delete(controller);
              stream.close();
            } else stream.enqueue(chunk.value);
          } catch (error) {
            pending.delete(controller);
            void reader.cancel(error).catch(() => {});
            stream.error(error);
          }
        },
        cancel(reason) {
          pending.delete(controller);
          return reader.cancel(reason);
        },
      });
      const guarded = new Response(body, response);
      for (const key of ["url", "redirected", "type"] as const) {
        Object.defineProperty(guarded, key, { value: response[key] });
      }
      return guarded;
    } catch (error) {
      pending.delete(controller);
      throw error;
    }
  };
  return () => {
    unsubscribe();
    for (const controller of pending.keys()) controller.abort();
    pending.clear();
    target.fetch = original;
  };
}
