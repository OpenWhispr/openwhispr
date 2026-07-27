import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Tag, ChevronDown, Plus, RefreshCw } from "lucide-react";

interface MeetingType {
  id: number;
  name: string;
  template: string;
  is_builtin: number;
}

interface MeetingTypePickerProps {
  noteId: number;
  currentTypeId: number | null;
  onTypeChange: (typeId: number | null) => void;
  onRegenerateNotes?: (typeId: number) => void;
  onCreateNew?: () => void;
}

export default function MeetingTypePicker({
  noteId,
  currentTypeId,
  onTypeChange,
  onRegenerateNotes,
  onCreateNew,
}: MeetingTypePickerProps) {
  const { t } = useTranslation();
  const [types, setTypes] = useState<MeetingType[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (window as any).electronAPI
      ?.getMeetingTypes?.()
      .then((result: MeetingType[]) => {
        if (Array.isArray(result)) setTypes(result);
      });
  }, []);

  // Click-outside-to-close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const currentType = types.find((mt) => mt.id === currentTypeId);

  const handleSelect = (typeId: number | null) => {
    onTypeChange(typeId);
    setIsOpen(false);
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Tag size={12} />
        <span>
          {currentType?.name || t("meetingTypes.picker.none")}
        </span>
        <ChevronDown size={10} />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-56 rounded-md border border-border bg-popover shadow-md z-50">
          <div className="p-1 max-h-64 overflow-y-auto">
            <button
              className={`w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted ${
                currentTypeId == null ? "bg-muted font-medium" : ""
              }`}
              onClick={() => handleSelect(null)}
            >
              {t("meetingTypes.picker.none")}
            </button>
            {types.map((type) => (
              <div key={type.id} className="flex items-center group">
                <button
                  className={`flex-1 text-left px-2 py-1.5 text-xs rounded hover:bg-muted truncate ${
                    currentTypeId === type.id ? "bg-muted font-medium" : ""
                  }`}
                  onClick={() => handleSelect(type.id)}
                >
                  {type.name}
                  {!type.is_builtin && (
                    <span className="ml-1 text-muted-foreground">
                      {t("meetingTypes.picker.custom")}
                    </span>
                  )}
                </button>
                {currentTypeId !== type.id && onRegenerateNotes && (
                  <button
                    className="p-1 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRegenerateNotes(type.id);
                      setIsOpen(false);
                    }}
                    title={t("meetingTypes.picker.regenerateWith", {
                      name: type.name,
                    })}
                  >
                    <RefreshCw size={10} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {onCreateNew && (
            <div className="border-t border-border p-1">
              <button
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onCreateNew();
                  setIsOpen(false);
                }}
              >
                <Plus size={10} />
                {t("meetingTypes.picker.createNew")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
