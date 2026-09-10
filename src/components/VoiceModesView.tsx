import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Pencil, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { useSettingsStore } from "../stores/settingsStore";
import { normalizeAppIdentifier, type VoiceMode } from "../utils/voiceModes";

const NEW_MODE: VoiceMode = { id: "", name: "", apps: [], instructions: "" };

function parseApps(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((app) => app.trim())
        .filter(Boolean)
    ),
  ];
}

interface EditVoiceModeDialogProps {
  mode: VoiceMode | null;
  onOpenChange: (open: boolean) => void;
  onSave: (mode: VoiceMode) => void;
}

function EditVoiceModeDialog({ mode, onOpenChange, onSave }: EditVoiceModeDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [apps, setApps] = useState("");
  const [instructions, setInstructions] = useState("");
  const [lastApp, setLastApp] = useState<string | null>(null);

  useEffect(() => {
    if (!mode) return;
    setName(mode.name);
    setApps(mode.apps.join(", "));
    setInstructions(mode.instructions);
    // The app the user last dictated into is the one they most likely want a
    // mode for, and it spares them guessing how the OS names it.
    setLastApp(null);
    window.electronAPI
      ?.getDictationTargetApp?.()
      .then((target) => setLastApp(target?.name ?? null))
      .catch(() => {});
  }, [mode]);

  const appList = parseApps(apps);
  const lastAppListed =
    !!lastApp &&
    appList.some((app) => normalizeAppIdentifier(app) === normalizeAppIdentifier(lastApp));
  const canSave = !!name.trim() && appList.length > 0 && !!instructions.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mode || !canSave) return;
    onSave({
      id: mode.id || crypto.randomUUID(),
      name: name.trim(),
      apps: appList,
      instructions: instructions.trim(),
    });
  }

  return (
    <Dialog open={!!mode} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode?.id ? t("voiceModes.editTitle") : t("voiceModes.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("voiceModes.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="voice-mode-name">{t("voiceModes.nameLabel")}</Label>
            <Input
              id="voice-mode-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("voiceModes.namePlaceholder")}
              maxLength={60}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voice-mode-apps">{t("voiceModes.appsLabel")}</Label>
            <Input
              id="voice-mode-apps"
              value={apps}
              onChange={(e) => setApps(e.target.value)}
              placeholder={t("voiceModes.appsPlaceholder")}
            />
            <p className="text-xs text-muted-foreground/80 leading-relaxed">
              {t("voiceModes.appsHint")}
            </p>
            {lastApp && !lastAppListed && (
              <button
                type="button"
                onClick={() => setApps([...appList, lastApp].join(", "))}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus size={11} />
                {t("voiceModes.useLastApp", { app: lastApp })}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voice-mode-instructions">{t("voiceModes.instructionsLabel")}</Label>
            <Textarea
              id="voice-mode-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("voiceModes.instructionsPlaceholder")}
              rows={4}
              className="min-h-[96px] text-xs"
            />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {mode?.id ? t("common.save") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function VoiceModesView() {
  const { t } = useTranslation();
  const voiceModes = useSettingsStore((s) => s.voiceModes);
  const setVoiceModes = useSettingsStore((s) => s.setVoiceModes);
  const [editing, setEditing] = useState<VoiceMode | null>(null);

  const handleSave = (mode: VoiceMode) => {
    const exists = voiceModes.some((m) => m.id === mode.id);
    setVoiceModes(
      exists ? voiceModes.map((m) => (m.id === mode.id ? mode : m)) : [...voiceModes, mode]
    );
    setEditing(null);
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <EditVoiceModeDialog
        mode={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={handleSave}
      />

      <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
        {voiceModes.length === 0 ? (
          <div className="max-w-md px-2 py-6">
            <h4 className="text-sm font-semibold text-foreground leading-snug">
              {t("voiceModes.emptyTitle")}
            </h4>
            <p className="mt-1.5 text-xs text-foreground/30 leading-relaxed">
              {t("voiceModes.emptyDescription")}
            </p>
            <Button size="sm" className="mt-4" onClick={() => setEditing(NEW_MODE)}>
              <Plus size={12} />
              {t("voiceModes.new")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground/40">{t("voiceModes.title")}</h3>
              <button
                onClick={() => setEditing(NEW_MODE)}
                className="flex items-center gap-1 text-xs text-foreground/30 hover:text-primary transition-colors"
              >
                <Plus size={11} />
                {t("voiceModes.new")}
              </button>
            </div>
            <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/8" />
            <ul>
              {voiceModes.map((mode) => (
                <li
                  key={mode.id}
                  className="group flex items-start gap-2 py-2.5 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground/70">{mode.name}</span>
                      {mode.apps.map((app) => (
                        <span
                          key={app}
                          className="inline-flex items-center gap-1 rounded-[5px] bg-primary/10 dark:bg-primary/15 border border-primary/15 dark:border-primary/20 px-1.5 py-0.5 text-[11px] text-primary"
                        >
                          <AppWindow size={9} />
                          {app}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-foreground/35 leading-relaxed line-clamp-2">
                      {mode.instructions}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                    <button
                      onClick={() => setEditing(mode)}
                      aria-label={t("voiceModes.edit", { name: mode.name })}
                      className="p-1 text-foreground/25 hover:text-foreground/60 transition-colors"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => setVoiceModes(voiceModes.filter((m) => m.id !== mode.id))}
                      aria-label={t("voiceModes.remove", { name: mode.name })}
                      className="p-1 text-foreground/25 hover:text-destructive/70 transition-colors"
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
