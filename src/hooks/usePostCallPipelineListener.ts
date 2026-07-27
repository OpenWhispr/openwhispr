import { useEffect } from "react";
import { handlePipelineStatus } from "../stores/postCallPipelineStore";

export function usePostCallPipelineListener() {
  useEffect(() => {
    const cleanup = (window as any).electronAPI?.onPostCallPipelineStatus?.(
      (payload: any) => {
        handlePipelineStatus(payload);
      }
    );
    return () => cleanup?.();
  }, []);
}
