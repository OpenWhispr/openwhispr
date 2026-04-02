import type React from "react";
import { useTranslation } from "react-i18next";
import { Shield, Check } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import WindowControls from "./WindowControls";
import PermissionsSection from "./ui/PermissionsSection";
import { AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { areRequiredPermissionsMet } from "../utils/permissions";

interface PermissionsGateProps {
  onComplete: () => void;
}

export default function PermissionsGate({ onComplete }: PermissionsGateProps) {
  const { t } = useTranslation();
  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const permissions = usePermissions(showAlertDialog);
  const systemAudio = useSystemAudioPermission();

  const requiredMet =
    permissions.pasteToolsInfo !== null &&
    areRequiredPermissionsMet(permissions.micPermissionGranted);

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open: boolean) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <div
        className="flex items-center justify-end w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {window.electronAPI?.getPlatform?.() !== "darwin" && (
          <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <WindowControls />
          </div>
        )}
      </div>

      <div className="flex-1 px-6 overflow-y-auto flex items-center">
        <div className="w-full max-w-sm mx-auto">
          <Card className="bg-card/90 backdrop-blur-2xl border border-border/50 dark:border-white/5 shadow-lg rounded-xl overflow-hidden">
            <CardContent className="p-6 space-y-6">
              <div className="text-center">
                <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Shield className="w-7 h-7 text-primary" />
                </div>
                <h2 className="text-2xl font-semibold text-foreground mb-2">
                  {t("permissionsGate.title")}
                </h2>
                <p className="text-muted-foreground">{t("permissionsGate.description")}</p>
              </div>

              <PermissionsSection permissions={permissions} systemAudio={systemAudio} />

              <Button onClick={onComplete} disabled={!requiredMet} className="w-full">
                <Check className="w-4 h-4" />
                {t("permissionsGate.continue")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
