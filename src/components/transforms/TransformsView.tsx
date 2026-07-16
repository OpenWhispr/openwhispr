import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Plus, Upload } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Transform } from "../../stores/settingsStore";
import TransformEditor from "./TransformEditor";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { useToast } from "../ui/useToast";

const MAX_TRANSFORMS = 10;

function HotkeyBadge({ hotkey }: { hotkey: string }) {
  if (!hotkey) return null;
  const parts = formatHotkeyLabel(hotkey).split("+");
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {parts.map((part, i) => (
        <kbd
          key={i}
          className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border border-border/40 bg-muted/60 text-muted-foreground leading-none"
        >
          {part}
        </kbd>
      ))}
    </div>
  );
}

function TransformCard({
  transform,
  onClick,
}: {
  transform: Transform;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2 p-4 rounded-xl border border-border/40 bg-surface-1 hover:border-border/70 hover:bg-surface-1/80 transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <HotkeyBadge hotkey={transform.hotkey} />
      <div>
        <p className="text-sm font-medium text-foreground leading-snug">{transform.name}</p>
        {transform.description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-2">
            {transform.description}
          </p>
        )}
      </div>
      {!transform.enabled && (
        <span className="text-[10px] text-muted-foreground/60 font-medium uppercase tracking-wide">
          Disabled
        </span>
      )}
    </button>
  );
}

function CreateCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-2 p-4 rounded-xl border border-dashed border-border/50 hover:border-border/80 hover:bg-surface-1/60 transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex h-6 w-6 items-center justify-center rounded-md border border-border/40 bg-muted/50">
        <Plus size={13} className="text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">Create your own</p>
        <p className="text-xs text-muted-foreground mt-0.5">Upload your own prompt</p>
      </div>
    </button>
  );
}

export default function TransformsView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const transforms = useSettingsStore((s) => s.transforms);
  const setTransforms = useSettingsStore((s) => s.setTransforms);

  const [editingTransform, setEditingTransform] = useState<Transform | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleBackup = async () => {
    const result = await window.electronAPI?.transformsBackup?.(transforms);
    if (result?.error) {
      toast({
        title: t("transforms.backupFailed"),
        description: result.error,
        variant: "destructive",
      });
    }
  };

  const handleRestore = async () => {
    const result = await window.electronAPI?.transformsRestore?.();
    if (!result || result.canceled) return;
    if (result.error || !Array.isArray(result.transforms)) {
      toast({
        title: t("transforms.restoreFailed"),
        description: result?.error,
        variant: "destructive",
      });
      return;
    }
    const existingIds = new Set(transforms.map((tr) => tr.id));
    const imported = result.transforms
      .filter((tr) => tr && typeof tr.name === "string" && tr.rules)
      .map((tr) => (existingIds.has(tr.id) ? { ...tr, id: crypto.randomUUID() } : tr));
    const room = Math.max(MAX_TRANSFORMS - transforms.length, 0);
    const toAdd = imported.slice(0, room);
    if (toAdd.length > 0) {
      setTransforms([...transforms, ...toAdd]);
      toast({ title: t("transforms.restoreSuccess", { count: toAdd.length }) });
    }
  };

  const openCreate = () => {
    setEditingTransform(null);
    setIsCreating(true);
  };

  const openEdit = (t: Transform) => {
    setEditingTransform(t);
    setIsCreating(true);
  };

  const handleSave = (transform: Transform) => {
    if (editingTransform) {
      setTransforms(transforms.map((t) => (t.id === transform.id ? transform : t)));
    } else {
      setTransforms([...transforms, transform]);
    }
    setIsCreating(false);
    setEditingTransform(null);
  };

  const handleDelete = (id: string) => {
    setTransforms(transforms.filter((t) => t.id !== id));
    setIsCreating(false);
    setEditingTransform(null);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
        <h1 className="text-lg font-semibold text-foreground">Transforms</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRestore}
            title={t("transforms.restore")}
            aria-label={t("transforms.restore")}
            className="flex items-center justify-center h-8 w-8 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground hover:bg-surface-1/80 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Upload size={13} />
          </button>
          <button
            onClick={handleBackup}
            title={t("transforms.backup")}
            aria-label={t("transforms.backup")}
            className="flex items-center justify-center h-8 w-8 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground hover:bg-surface-1/80 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Download size={13} />
          </button>
          {transforms.length < MAX_TRANSFORMS && (
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground text-background text-xs font-medium hover:bg-foreground/90 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Plus size={13} />
              Create New
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {transforms.map((t) => (
            <TransformCard key={t.id} transform={t} onClick={() => openEdit(t)} />
          ))}
          {transforms.length < MAX_TRANSFORMS && (
            <CreateCard onClick={openCreate} />
          )}
        </div>

        {transforms.length === 0 && (
          <p className="text-sm text-muted-foreground text-center mt-8">
            No transforms yet. Create one to get started.
          </p>
        )}
      </div>

      {isCreating && (
        <TransformEditor
          transform={editingTransform}
          existingHotkeys={transforms
            .filter((t) => !editingTransform || t.id !== editingTransform.id)
            .map((t) => t.hotkey)
            .filter(Boolean)}
          onSave={handleSave}
          onDelete={editingTransform ? () => handleDelete(editingTransform.id) : undefined}
          onClose={() => {
            setIsCreating(false);
            setEditingTransform(null);
          }}
        />
      )}
    </div>
  );
}
