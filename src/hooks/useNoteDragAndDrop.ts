import { useState, useCallback, useRef, useEffect } from "react";
import { MEETINGS_FOLDER_NAME } from "../components/notes/shared";

interface DragState {
  draggingNoteId: number | null;
  dragOverFolderId: number | null;
  dropSuccessFolderId: number | null;
}

interface UseNoteDragAndDropOptions {
  onMoveToFolder: (noteId: number, folderId: number) => Promise<void>;
  currentFolderId: number | null;
}

export function useNoteDragAndDrop({ onMoveToFolder, currentFolderId }: UseNoteDragAndDropOptions) {
  const [dragState, setDragState] = useState<DragState>({
    draggingNoteId: null,
    dragOverFolderId: null,
    dropSuccessFolderId: null,
  });

  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const enterCounterRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    };
  }, []);

  const noteDragHandlers = useCallback(
    (noteId: number, noteTitle: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-note-id", String(noteId));

        const ghost = document.createElement("div");
        const label = noteTitle || "Untitled";
        ghost.textContent = label.length > 24 ? label.slice(0, 24) + "…" : label;
        ghost.style.cssText = `
          position: fixed; top: -200px; left: -200px;
          padding: 4px 12px;
          background: color-mix(in oklch, var(--color-popover) 95%, transparent);
          color: var(--color-popover-foreground);
          font-size: 11px;
          font-weight: 500;
          border-radius: 6px;
          border: 1px solid var(--color-border);
          white-space: nowrap;
          pointer-events: none;
        `;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        requestAnimationFrame(() => ghost.remove());

        setDragState((prev) => ({ ...prev, draggingNoteId: noteId }));
        enterCounterRef.current.clear();
      },
      onDragEnd: () => {
        setDragState((prev) => ({
          ...prev,
          draggingNoteId: null,
          dragOverFolderId: null,
        }));
        enterCounterRef.current.clear();
      },
    }),
    []
  );

  const folderDropHandlers = useCallback(
    (folderId: number, folderName: string) => {
      const isMeetings = folderName === MEETINGS_FOLDER_NAME;
      const isSameFolder = folderId === currentFolderId;
      const canDrop = !isMeetings && !isSameFolder;

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!canDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          if (!canDrop) return;
          const count = (enterCounterRef.current.get(folderId) ?? 0) + 1;
          enterCounterRef.current.set(folderId, count);
          if (count === 1) {
            setDragState((prev) => ({ ...prev, dragOverFolderId: folderId }));
          }
        },
        onDragLeave: () => {
          if (!canDrop) return;
          const count = (enterCounterRef.current.get(folderId) ?? 0) - 1;
          enterCounterRef.current.set(folderId, Math.max(0, count));
          if (count <= 0) {
            enterCounterRef.current.set(folderId, 0);
            setDragState((prev) =>
              prev.dragOverFolderId === folderId ? { ...prev, dragOverFolderId: null } : prev
            );
          }
        },
        onDrop: async (e: React.DragEvent) => {
          e.preventDefault();
          if (!canDrop) return;

          const noteIdStr = e.dataTransfer.getData("application/x-note-id");
          const noteId = parseInt(noteIdStr, 10);
          if (isNaN(noteId)) return;

          enterCounterRef.current.clear();
          setDragState((prev) => ({
            ...prev,
            draggingNoteId: null,
            dragOverFolderId: null,
            dropSuccessFolderId: folderId,
          }));

          if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
          successTimeoutRef.current = setTimeout(() => {
            setDragState((prev) =>
              prev.dropSuccessFolderId === folderId ? { ...prev, dropSuccessFolderId: null } : prev
            );
          }, 800);

          await onMoveToFolder(noteId, folderId);
        },
      };
    },
    [currentFolderId, onMoveToFolder]
  );

  return { dragState, noteDragHandlers, folderDropHandlers };
}
