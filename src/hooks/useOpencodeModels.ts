import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = providerId as OpencodeCatalogProviderId;
    const request = ++latestRequest.current;
    if (!isOpencodeListFresh(id)) {
      setStatus({ providerId: id, loading: true, error: null });
    }

    refreshOpencodeModels(id)
      .then(() => {
        if (!isMountedRef.current) return;
        setRevision((revision) => revision + 1);
        if (request === latestRequest.current) {
          setStatus({ providerId: id, loading: false, error: null });
        }
      })
      .catch((err: Error) => {
        logger.error("Failed to load OpenCode models", { error: err }, "models");
        if (isMountedRef.current && request === latestRequest.current) {
          setStatus({
            providerId: id,
            loading: false,
            error: err.message || "Unable to load models",
          });
        }
      });
  }, [enabled, providerId]);

  const visible = status.providerId === providerId ? status : null;
  return {
    models: enabled ? getOpencodeCatalogModels(providerId) : NO_MODELS,
    loading: visible?.loading ?? false,
    error: visible?.error ?? null,
  };
}
