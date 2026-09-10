import { useCallback, useEffect, useRef, useState } from "react";
import { getXaiModels, type CloudModelDefinition } from "../models/ModelRegistry";
import { isXaiListFresh, refreshXaiModels } from "../models/xaiModels";
import logger from "../utils/logger";

interface UseXaiModelsResult {
  models: CloudModelDefinition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Refreshes xAI's language-model list into the registry while the xAI tab is
 * open. The bundled fallback stays if the fetch fails (no SuperGrok session,
 * or /v1/language-models unreachable).
 */
export function useXaiModels(enabled: boolean): UseXaiModelsResult {
  const [models, setModels] = useState<CloudModelDefinition[]>(() => getXaiModels());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const willFetch = !isXaiListFresh();

    if (willFetch && isMountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const fresh = await refreshXaiModels();
      if (isMountedRef.current) {
        setModels(fresh);
      }
    } catch (err) {
      logger.error("Failed to load xAI models", { error: err }, "models");
      if (isMountedRef.current) {
        setError((err as Error).message || "Unable to load models");
      }
    } finally {
      if (willFetch && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  return { models, loading, error, refresh };
}
