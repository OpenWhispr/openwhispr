import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import PermissionsSection from "./ui/PermissionsSection";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";

interface TccResetModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

export default function TccResetModal({ open, onOpenChange, onDone }: TccResetModalProps) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const systemAudio = useSystemAudioPermission();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tccReset.title")}</DialogTitle>
          <DialogDescription>{t("tccReset.description")}</DialogDescription>
        </DialogHeader>

        <PermissionsSection permissions={permissions} systemAudio={systemAudio} />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("tccReset.remindLater")}
          </Button>
          <Button onClick={onDone} disabled={!permissions.micPermissionGranted}>
            {t("tccReset.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
