import { useCallback, useEffect, useRef, useState } from "react";
import { getOpencodeCatalogModels, type CloudModelDefinition } from "../models/ModelRegistry";
import {
  isOpencodeListFresh,
  refreshOpencodeModels,
  type OpencodeCatalogProviderId,
} from "../models/opencodeModels";
import { isOpencodeCatalogProvider } from "../config/opencodeModelPolicy.js";
import logger from "../utils/logger";

interface UseOpencodeModelsResult {
  models: CloudModelDefinition[];
  loading: boolean;
  error: string | null;
  /** Refetches even when the cache is fresh (the picker's manual refresh). */
  refresh: () => Promise<void>;
}

interface RefreshStatus {
  providerId: string;
  loading: boolean;
  error: string | null;
}

const NO_MODELS: CloudModelDefinition[] = [];

/**
 * OpenCode's live model list for the product the user has selected, refreshed
 * while they have it open. The registry keeps its last known list when the
 * fetch fails, so the picker stays usable offline.
 */
export function useOpencodeModels(providerId: string): UseOpencodeModelsResult {
  const enabled = isOpencodeCatalogProvider(providerId);
  const [, setRevision] = useState(0);
  const [status, setStatus] = useState<RefreshStatus>({
    providerId: "",
    loading: false,
    error: null,
  });
  const latestRequest = useRef(0);
  const isMountedRef = useRef(true);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!isOpencodeCatalogProvider(providerId)) return;
      const id = providerId as OpencodeCatalogProviderId;
      const request = ++latestRequest.current;
      if (options?.force || !isOpencodeListFresh(id)) {
        setStatus({ providerId: id, loading: true, error: null });
      }

      try {
        await refreshOpencodeModels(id, options);
      } catch (err) {
        logger.error("Failed to load OpenCode models", { error: err }, "models");
        if (isMountedRef.current && request === latestRequest.current) {
          setStatus({
            providerId: id,
            loading: false,
            error: (err as Error).message || "Unable to load models",
          });
        }
        return;
      }
      if (!isMountedRef.current) return;
      setRevision((revision) => revision + 1);
      if (request === latestRequest.current) {
        setStatus({ providerId: id, loading: false, error: null });
      }
    },
    [providerId]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, providerId, refresh]);

  const visible = status.providerId === providerId ? status : null;
  return {
    models: enabled ? getOpencodeCatalogModels(providerId) : NO_MODELS,
    loading: visible?.loading ?? false,
    error: visible?.error ?? null,
    refresh: () => refresh({ force: true }),
  };
}
