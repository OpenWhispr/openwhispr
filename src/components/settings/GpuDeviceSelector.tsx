import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GpuDevice } from "../../types/electron";
import { SettingsPanel, SettingsPanelRow, SectionHeader } from "../ui/SettingsSection";

export default function GpuDeviceSelector({
  purpose,
}: {
  purpose: "transcription" | "intelligence";
}) {
  const { t } = useTranslation();
  const [gpus, setGpus] = useState<GpuDevice[]>([]);
  const [selectedUuid, setSelectedUuid] = useState("");
  const [loadedPurpose, setLoadedPurpose] = useState<string | null>(null);

  useEffect(() => {
    // Each run owns its own flag, so a cleanup only ever ignores its own reply.
    let cancelled = false;
    Promise.all([
      window.electronAPI?.listGpus?.() ?? Promise.resolve([]),
      window.electronAPI?.getGpuDeviceIndex?.(purpose) ?? Promise.resolve(""),
    ])
      .then(([gpuList, savedUuid]) => {
        if (cancelled) return;
        setGpus(gpuList);
        setSelectedUuid(savedUuid || gpuList[0]?.uuid || "");
        setLoadedPurpose(purpose);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [purpose]);

  if (loadedPurpose !== purpose || gpus.length < 2) return null;

  return (
    <div className="border-t border-border/70 pt-4 mt-4">
      <SectionHeader
        title={t(`settingsPage.${purpose}.gpuDevice.title`)}
        description={t(`settingsPage.${purpose}.gpuDevice.description`)}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="relative w-full">
            <select
              aria-label={t(`settingsPage.${purpose}.gpuDevice.title`)}
              value={selectedUuid}
              onChange={async (event) => {
                const uuid = event.target.value;
                setSelectedUuid(uuid);
                await window.electronAPI?.setGpuDeviceIndex?.(purpose, uuid);
              }}
              className="w-full appearance-none rounded-md border border-border bg-background px-3 pe-10 py-2 text-sm"
            >
              {gpus.map((gpu) => (
                <option key={gpu.uuid} value={gpu.uuid}>
                  GPU {gpu.index}: {gpu.name} ({Math.round(gpu.vramMb / 1024)}GB)
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
