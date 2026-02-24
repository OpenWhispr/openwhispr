import React, { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Download, RefreshCw, Loader2, AlertTriangle, Zap } from "lucide-react";
import UpgradePrompt from "./UpgradePrompt";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/Toast";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import { useUsage } from "../hooks/useUsage";
import {
  useTranscriptions,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
} from "../stores/transcriptionStore";
import ControlPanelSidebar, { type ControlPanelView } from "./ControlPanelSidebar";
import WindowControls from "./WindowControls";
import { getCachedPlatform } from "../utils/platform";
import { setActiveNoteId, setActiveFolderId } from "../stores/noteStore";
import HistoryView from "./HistoryView";
import type { CudaWhisperStatus } from "../types/electron";

const platform = getCachedPlatform();

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const ReferralModal = React.lazy(() => import("./ReferralModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));

export default function ControlPanel() {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [limitData, setLimitData] = useState<{ wordsUsed: number; limit: number } | null>(null);
  const hasShownUpgradePrompt = useRef(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [showReferrals, setShowReferrals] = useState(false);
  const [showCloudMigrationBanner, setShowCloudMigrationBanner] = useState(false);
  const [vulkanBanner, setVulkanBanner] = useState<{ show: boolean; deviceName?: string }>({
    show: false,
  });
  const [activeView, setActiveView] = useState<ControlPanelView>("home");
  const [cudaStatus, setCudaStatus] = useState<CudaWhisperStatus | null>(null);
  const [gpuBannerDismissed, setGpuBannerDismissed] = useState(
    () => localStorage.getItem("gpuBannerDismissed") === "true"
  );
  const cloudMigrationProcessed = useRef(false);
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    useReasoningModel,
    setUseLocalWhisper,
    setCloudTranscriptionMode,
  } = useSettings();
  const { isSignedIn, isLoaded: authLoaded, user } = useAuth();
  const usage = useUsage();

  const {
    status: updateStatus,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
    error: updateError,
  } = useUpdater();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  useEffect(() => {
    loadTranscriptions();
  }, []);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      toast({
        title: t("controlPanel.update.readyTitle"),
        description: t("controlPanel.update.readyDescription"),
        variant: "success",
      });
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    if (updateError) {
      toast({
        title: t("controlPanel.update.problemTitle"),
        description: t("controlPanel.update.problemDescription"),
        variant: "destructive",
      });
    }
  }, [updateError, toast, t]);

  useEffect(() => {
    const dispose = window.electronAPI?.onLimitReached?.(
      (data: { wordsUsed: number; limit: number }) => {
        if (!hasShownUpgradePrompt.current) {
          hasShownUpgradePrompt.current = true;
          setLimitData(data);
          setShowUpgradePrompt(true);
        } else {
          toast({
            title: t("controlPanel.limit.weeklyTitle"),
            description: t("controlPanel.limit.weeklyDescription"),
            duration: 5000,
          });
        }
      }
    );

    return () => {
      dispose?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (!usage?.isPastDue || !usage.hasLoaded) return;
    if (sessionStorage.getItem("pastDueNotified")) return;
    sessionStorage.setItem("pastDueNotified", "true");
    toast({
      title: t("controlPanel.billing.pastDueTitle"),
      description: t("controlPanel.billing.pastDueDescription"),
      variant: "destructive",
      duration: 8000,
    });
  }, [usage?.isPastDue, usage?.hasLoaded, toast, t]);

  useEffect(() => {
    if (!authLoaded || !isSignedIn || cloudMigrationProcessed.current) return;
    const isPending = localStorage.getItem("pendingCloudMigration") === "true";
    const alreadyShown = localStorage.getItem("cloudMigrationShown") === "true";
    if (!isPending || alreadyShown) return;

    cloudMigrationProcessed.current = true;
    setUseLocalWhisper(false);
    setCloudTranscriptionMode("openwhispr");
    localStorage.removeItem("pendingCloudMigration");
    setShowCloudMigrationBanner(true);
  }, [authLoaded, isSignedIn, setUseLocalWhisper, setCloudTranscriptionMode]);

  useEffect(() => {
    if (platform === "darwin" || !useReasoningModel) return;
    if (localStorage.getItem("llamaVulkanBannerDismissed") === "true") return;

    Promise.all([
      window.electronAPI?.detectVulkanGpu?.(),
      window.electronAPI?.getLlamaVulkanStatus?.(),
    ])
      .then(([gpu, vulkan]) => {
        if (gpu?.available && !vulkan?.downloaded) {
          setVulkanBanner({ show: true, deviceName: gpu.deviceName });
        }
      })
      .catch(() => {});
  }, [useReasoningModel]);

  const fetchCudaStatus = useCallback(() => {
    if (platform === "darwin" || gpuBannerDismissed) return;
    if (!useLocalWhisper || localTranscriptionProvider !== "whisper") return;
    window.electronAPI
      ?.getCudaWhisperStatus?.()
      ?.then(setCudaStatus)
      .catch(() => {});
  }, [useLocalWhisper, localTranscriptionProvider, gpuBannerDismissed]);

  useEffect(() => {
    if (!showSettings) fetchCudaStatus();
  }, [showSettings, fetchCudaStatus]);

  const showGpuBanner =
    activeView === "home" &&
    !gpuBannerDismissed &&
    cudaStatus?.gpuInfo.hasNvidiaGpu === true &&
    cudaStatus.downloaded === false;

  const loadTranscriptions = async () => {
    try {
      setIsLoading(true);
      await initializeTranscriptions();
    } catch (error) {
      showAlertDialog({
        title: t("controlPanel.history.couldNotLoadTitle"),
        description: t("controlPanel.history.couldNotLoadDescription"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: t("controlPanel.update.installTitle"),
        description: t("controlPanel.update.installDescription"),
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch (error) {
            toast({
              title: t("controlPanel.update.couldNotInstallTitle"),
              description: t("controlPanel.update.couldNotInstallDescription"),
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch (error) {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t("controlPanel.update.installing")}</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>{t("controlPanel.update.installButton")}</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>{t("controlPanel.update.availableButton")}</span>
        </>
      );
    }
    return null;
  };

  return (
    <div className="h-screen bg-background flex flex-col">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <UpgradePrompt
        open={showUpgradePrompt}
        onOpenChange={setShowUpgradePrompt}
        wordsUsed={limitData?.wordsUsed}
        limit={limitData?.limit}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      {showReferrals && (
        <Suspense fallback={null}>
          <ReferralModal open={showReferrals} onOpenChange={setShowReferrals} />
        </Suspense>
      )}

      <div className="flex flex-1 overflow-hidden">
        <ControlPanelSidebar
          activeView={activeView}
          onViewChange={setActiveView}
          onOpenSettings={() => {
            setSettingsSection(undefined);
            setShowSettings(true);
          }}
          onOpenReferrals={() => setShowReferrals(true)}
          onUpgrade={() => {
            setSettingsSection("plansBilling");
            setShowSettings(true);
          }}
          onUpgradeCheckout={() => usage?.openCheckout()}
          isOverLimit={usage?.isOverLimit ?? false}
          userName={user?.name}
          userEmail={user?.email}
          userImage={user?.image}
          isSignedIn={isSignedIn}
          authLoaded={authLoaded}
          isProUser={!!(usage?.isSubscribed || usage?.isTrial)}
          usageLoaded={usage?.hasLoaded ?? false}
          updateAction={
            !updateStatus.isDevelopment &&
            (updateStatus.updateAvailable ||
              updateStatus.updateDownloaded ||
              isDownloading ||
              isInstalling) ? (
              <Button
                variant={updateStatus.updateDownloaded ? "default" : "outline"}
                size="sm"
                onClick={handleUpdateClick}
                disabled={isInstalling || isDownloading}
                className="gap-1.5 text-xs w-full h-7"
              >
                {getUpdateButtonContent()}
              </Button>
            ) : undefined
          }
        />
        <main className="flex-1 flex flex-col overflow-hidden">
          <div
            className="flex items-center justify-end w-full h-10 shrink-0"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            {platform !== "darwin" && (
              <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                <WindowControls />
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto pt-1">
            {usage?.isPastDue && activeView === "home" && (
              <div className="max-w-3xl mx-auto w-full mb-3">
                <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/50 p-3">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-8 h-8 rounded-md bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
                      <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-amber-900 dark:text-amber-200 mb-0.5">
                        {t("controlPanel.billing.pastDueTitle")}
                      </p>
                      <p className="text-xs text-amber-700 dark:text-amber-300/80 mb-2">
                        {t("controlPanel.billing.bannerDescription", {
                          limit: usage.limit.toLocaleString(),
                        })}
                      </p>
                      <Button
                        variant="default"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setSettingsSection("account");
                          setShowSettings(true);
                        }}
                      >
                        {t("controlPanel.billing.updatePayment")}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {vulkanBanner.show && activeView === "home" && (
              <div className="mx-4 mt-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                <div className="flex items-start gap-2">
                  <Zap className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">
                      {vulkanBanner.deviceName || "GPU"} detected — speed up local AI with Vulkan
                      acceleration
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsSection("reasoning");
                          setShowSettings(true);
                        }}
                        className="text-xs font-medium text-purple-400 hover:text-purple-300 transition-colors"
                      >
                        Enable GPU
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          localStorage.setItem("llamaVulkanBannerDismissed", "true");
                          setVulkanBanner({ show: false });
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {showGpuBanner && (
              <div className="max-w-3xl mx-auto w-full mb-3">
                <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/5 p-3">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center">
                      <Zap size={16} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground mb-0.5">
                        GPU acceleration available
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">
                        {cudaStatus?.gpuInfo.gpuName
                          ? `Your ${cudaStatus.gpuInfo.gpuName} can speed up local transcription.`
                          : "Your NVIDIA GPU can speed up local transcription."}
                      </p>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setSettingsSection("transcription");
                            setShowSettings(true);
                          }}
                        >
                          Enable GPU
                        </Button>
                        <button
                          onClick={() => {
                            setGpuBannerDismissed(true);
                            localStorage.setItem("gpuBannerDismissed", "true");
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Not now
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeView === "home" && (
              <HistoryView
                history={history}
                isLoading={isLoading}
                hotkey={hotkey}
                showCloudMigrationBanner={showCloudMigrationBanner}
                setShowCloudMigrationBanner={setShowCloudMigrationBanner}
                aiCTADismissed={aiCTADismissed}
                setAiCTADismissed={setAiCTADismissed}
                useReasoningModel={useReasoningModel}
                copyToClipboard={copyToClipboard}
                deleteTranscription={deleteTranscription}
                onOpenSettings={(section) => {
                  setSettingsSection(section);
                  setShowSettings(true);
                }}
              />
            )}
            {activeView === "personal-notes" && (
              <Suspense fallback={null}>
                <PersonalNotesView
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              </Suspense>
            )}
            {activeView === "dictionary" && (
              <Suspense fallback={null}>
                <DictionaryView />
              </Suspense>
            )}
            {activeView === "upload" && (
              <Suspense fallback={null}>
                <UploadAudioView
                  onNoteCreated={(noteId, folderId) => {
                    setActiveNoteId(noteId);
                    if (folderId) setActiveFolderId(folderId);
                    setActiveView("personal-notes");
                  }}
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              </Suspense>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
