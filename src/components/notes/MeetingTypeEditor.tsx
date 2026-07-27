import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface MeetingTypeEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editType?: {
    id: number;
    name: string;
    template: string;
    is_builtin: number;
  } | null;
  onSaved?: () => void;
}

export default function MeetingTypeEditor({
  open,
  onOpenChange,
  editType,
  onSaved,
}: MeetingTypeEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && editType) {
      setName(editType.name);
      setTemplate(editType.template);
    } else if (open) {
      setName("");
      setTemplate("");
    }
  }, [open, editType]);

  if (!open) return null;

  const isEdit = editType != null;
  const isBuiltin = editType?.is_builtin === 1;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let finalTemplate = template.trim();
      // Auto-append Action Items if missing
      if (
        finalTemplate &&
        !finalTemplate.toLowerCase().includes("action item")
      ) {
        finalTemplate +=
          "\n\nEnd with an Action Items section with checkboxes.";
      }

      if (isEdit && editType) {
        await (window as any).electronAPI?.updateMeetingType(editType.id, {
          name: name.trim(),
          template: finalTemplate,
        });
      } else {
        await (window as any).electronAPI?.createMeetingType(
          name.trim(),
          finalTemplate,
        );
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save meeting type", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium mb-3">
          {isEdit
            ? t("meetingTypes.editor.editTitle")
            : t("meetingTypes.editor.createTitle")}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              {t("meetingTypes.editor.nameLabel")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("meetingTypes.editor.namePlaceholder")}
              disabled={isBuiltin}
              className="h-8 text-sm"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              {t("meetingTypes.editor.templateLabel")}
            </label>
            <textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={t("meetingTypes.editor.templatePlaceholder")}
              disabled={isBuiltin}
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y min-h-[100px]"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {t("meetingTypes.editor.actionItemsNote")}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("meetingTypes.editor.cancel")}
          </Button>
          {!isBuiltin && (
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !name.trim()}
            >
              {saving
                ? t("meetingTypes.editor.saving")
                : t("meetingTypes.editor.save")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
