import { resolveRetiredCloudModel } from "../../config/retiredCloudModelPolicy.js";
import type { LanguageModel } from "ai";
import type { TinfoilAI } from "tinfoil";
import { refreshTinfoilModels } from "../../models/tinfoilModels";

type TinfoilModule = typeof import("tinfoil");
type TinfoilAISDKProvider = Awaited<ReturnType<TinfoilModule["createTinfoilAI"]>>;
// One initialization per key serves every concurrent caller. Each waits on its
// own signal, and the attestation is cancelled only once all of them have; a
// caller arriving after that starts a fresh one.
type SharedProvider = {
  provider: Promise<TinfoilAISDKProvider>;
  initialization: AbortController;
  waiting: number;
};

let tinfoilModulePromise: Promise<TinfoilModule> | null = null;

const chatClientCache = new Map<string, Promise<TinfoilAI>>();
const aiSdkProviderCache = new Map<string, SharedProvider>();

function loadTinfoil(): Promise<TinfoilModule> {
  if (!tinfoilModulePromise) {
    // Don't cache a failed import — the next call should retry.
    tinfoilModulePromise = import("tinfoil").catch((error) => {
      tinfoilModulePromise = null;
      throw error;
    });
  }
  return tinfoilModulePromise;
}

function normalizeApiKey(apiKey: string): string {
  const key = apiKey?.trim() || "";
  if (!key) {
    throw new Error("Tinfoil API key not configured");
  }
  return key;
}

/** Tinfoil adds and retires models often; sync the registry in the background. */
function syncTinfoilCatalog(): void {
  void refreshTinfoilModels().catch(() => {});
}

export async function getTinfoilChatClient(apiKey: string): Promise<TinfoilAI> {
  const key = normalizeApiKey(apiKey);
  syncTinfoilCatalog();
  const cached = chatClientCache.get(key);
  if (cached) return cached;

  const clientPromise = loadTinfoil()
    .then(({ TinfoilAI }) => {
      return new TinfoilAI({
        apiKey: key,
        dangerouslyAllowBrowser: true,
      });
    })
    .catch((error) => {
      chatClientCache.delete(key);
      throw error;
    });
  chatClientCache.set(key, clientPromise);
  return clientPromise;
}

async function getTinfoilAISDKProvider(
  apiKey: string,
  signal?: AbortSignal
): Promise<TinfoilAISDKProvider> {
  signal?.throwIfAborted();
  const key = normalizeApiKey(apiKey);
  syncTinfoilCatalog();
  let shared = aiSdkProviderCache.get(key);
  if (!shared) {
    const initialization = new AbortController();
    const provider = loadTinfoil()
      .then(({ createTinfoilAI }) => createTinfoilAI(key, { signal: initialization.signal }))
      .catch((error) => {
        if (aiSdkProviderCache.get(key) === shared) aiSdkProviderCache.delete(key);
        throw error;
      });
    shared = { provider, initialization, waiting: 0 };
    aiSdkProviderCache.set(key, shared);
  }
  const { provider } = shared;
  shared.waiting++;
  try {
    return await new Promise<TinfoilAISDKProvider>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      provider.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
  } finally {
    if (--shared.waiting === 0 && signal?.aborted) {
      shared.initialization.abort(signal.reason);
      if (aiSdkProviderCache.get(key) === shared) aiSdkProviderCache.delete(key);
    }
  }
}

export async function getTinfoilLanguageModel(
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<LanguageModel> {
  const provider = await getTinfoilAISDKProvider(apiKey, signal);
  return provider(resolveRetiredCloudModel("tinfoil", model));
}

export function clearTinfoilClientCache(): void {
  chatClientCache.clear();
  aiSdkProviderCache.clear();
}
