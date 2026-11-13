import { useState, useCallback, useRef, useEffect } from "react";
import { MEETINGS_FOLDER_NAME } from "../components/notes/shared";
import { folderContainerKey, spaceContainerKey } from "../stores/noteStore";

export interface NoteMoveTarget {
  spaceId: number;
  folderId: number | null;
}

export interface DraggedNoteInfo {
  id: number;
  title: string;
  folderId: number | null;
  spaceId: number;
}

interface DropTargetInfo extends NoteMoveTarget {
  folderName?: string;
  isDefaultFolder?: boolean;
}

interface DragState {
  draggingNoteId: number | null;
  dragOverKey: string | null;
  dropSuccessKey: string | null;
}

interface UseNoteDragAndDropOptions {
  untitledLabel: string;
  onMoveToTarget: (noteId: number, target: NoteMoveTarget) => void | Promise<void>;
  /** Cross-space drops change the note's audience — the caller confirms, then calls commit(). */
  onCrossSpaceDrop: (note: DraggedNoteInfo, target: NoteMoveTarget, commit: () => void) => void;
  /** Vetoes cross-space targets: when it returns false the row never accepts the drag. */
  canCrossSpaceDrop?: (note: DraggedNoteInfo, target: NoteMoveTarget) => boolean;
  /**
   * Fired at most once per drag when the dragged note first hovers a target
   * the cross-space veto rejected — the drop would otherwise die silently
   * (no highlight, no dialog), which reads as a broken drag.
   */
  onCrossSpaceVeto?: (note: DraggedNoteInfo, target: NoteMoveTarget) => void;
  /** Fired after hovering a target for 500ms mid-drag (auto-expand collapsed containers). */
  onHoverTarget?: (key: string) => void;
  /**
   * Where a drop on a row lands for the dragged note, when that isn't the row itself (a row that
   * stands for several containers); null refuses the drop. Every check and the move use it.
   */
  resolveDropTarget?: (note: DraggedNoteInfo, target: NoteMoveTarget) => NoteMoveTarget | null;
}

const HOVER_EXPAND_DELAY_MS = 500;

function targetKey(target: NoteMoveTarget): string {
  return target.folderId != null
    ? folderContainerKey(target.folderId)
    : spaceContainerKey(target.spaceId);
}

export function useNoteDragAndDrop({
  untitledLabel,
  onMoveToTarget,
  onCrossSpaceDrop,
  canCrossSpaceDrop,
  onCrossSpaceVeto,
  onHoverTarget,
  resolveDropTarget,
}: UseNoteDragAndDropOptions) {
  const [dragState, setDragState] = useState<DragState>({
    draggingNoteId: null,
    dragOverKey: null,
    dropSuccessKey: null,
  });

  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const enterCounterRef = useRef<Map<string, number>>(new Map());
  const draggedNoteRef = useRef<DraggedNoteInfo | null>(null);
  const vetoNotifiedRef = useRef(false);

  const clearHoverTimeout = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = null;
    hoverKeyRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const noteDragHandlers = useCallback(
    (note: DraggedNoteInfo) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-note-id", String(note.id));

        const ghost = document.createElement("div");
        const label = note.title || untitledLabel;
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

        draggedNoteRef.current = note;
        vetoNotifiedRef.current = false;
        setDragState((prev) => ({ ...prev, draggingNoteId: note.id }));
        enterCounterRef.current.clear();
      },
      onDragEnd: () => {
        draggedNoteRef.current = null;
        vetoNotifiedRef.current = false;
        clearHoverTimeout();
        setDragState((prev) => ({
          ...prev,
          draggingNoteId: null,
          dragOverKey: null,
        }));
        enterCounterRef.current.clear();
      },
    }),
    [clearHoverTimeout, untitledLabel]
  );

  const commitDrop = useCallback(
    (noteId: number, target: NoteMoveTarget, key: string) => {
      setDragState((prev) => ({ ...prev, dropSuccessKey: key }));
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = setTimeout(() => {
        setDragState((prev) =>
          prev.dropSuccessKey === key ? { ...prev, dropSuccessKey: null } : prev
        );
      }, 800);
      void onMoveToTarget(noteId, target);
    },
    [onMoveToTarget]
  );

  const dropTargetHandlers = useCallback(
    (targetInfo: DropTargetInfo) => {
      const target: NoteMoveTarget = { spaceId: targetInfo.spaceId, folderId: targetInfo.folderId };
      const key = targetKey(target);
      const landing = (note: DraggedNoteInfo): NoteMoveTarget | null =>
        resolveDropTarget ? resolveDropTarget(note, target) : target;
      const crossSpaceVetoed = (note: DraggedNoteInfo, to: NoteMoveTarget): boolean =>
        note.spaceId !== to.spaceId && !!canCrossSpaceDrop && !canCrossSpaceDrop(note, to);
      const canDrop = () => {
        const note = draggedNoteRef.current;
        if (!note) return false;
        const to = landing(note);
        if (!to) return false;
        const isSameContainer =
          to.folderId != null
            ? note.folderId === to.folderId
            : note.folderId == null && note.spaceId === to.spaceId;
        if (isSameContainer) return false;
        if (crossSpaceVetoed(note, to)) return false;
        // The default Meetings folder of the note's own space stays a non-target.
        const isOwnMeetings =
          !!targetInfo.isDefaultFolder &&
          targetInfo.folderName === MEETINGS_FOLDER_NAME &&
          targetInfo.spaceId === note.spaceId;
        return !isOwnMeetings;
      };

      return {
        onDragOver: (e: React.DragEvent) => {
          if (!canDrop()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          if (!canDrop()) {
            const note = draggedNoteRef.current;
            const to = note ? landing(note) : null;
            if (note && to && crossSpaceVetoed(note, to) && !vetoNotifiedRef.current) {
              vetoNotifiedRef.current = true;
              onCrossSpaceVeto?.(note, to);
            }
            return;
          }
          const count = (enterCounterRef.current.get(key) ?? 0) + 1;
          enterCounterRef.current.set(key, count);
          if (count === 1) {
            setDragState((prev) => ({ ...prev, dragOverKey: key }));
            if (onHoverTarget) {
              clearHoverTimeout();
              hoverKeyRef.current = key;
              hoverTimeoutRef.current = setTimeout(() => onHoverTarget(key), HOVER_EXPAND_DELAY_MS);
            }
          }
        },
        onDragLeave: () => {
          if (!canDrop()) return;
          const count = (enterCounterRef.current.get(key) ?? 0) - 1;
          enterCounterRef.current.set(key, Math.max(0, count));
          if (count <= 0) {
            enterCounterRef.current.set(key, 0);
            if (hoverKeyRef.current === key) clearHoverTimeout();
            setDragState((prev) =>
              prev.dragOverKey === key ? { ...prev, dragOverKey: null } : prev
            );
          }
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          if (!canDrop()) return;

          const note = draggedNoteRef.current;
          const noteId = parseInt(e.dataTransfer.getData("application/x-note-id"), 10);
          if (!note || isNaN(noteId) || noteId !== note.id) return;
          const to = landing(note);
          if (!to) return;

          clearHoverTimeout();
          enterCounterRef.current.clear();
          draggedNoteRef.current = null;
          setDragState((prev) => ({
            ...prev,
            draggingNoteId: null,
            dragOverKey: null,
          }));

          if (note.spaceId !== to.spaceId) {
            onCrossSpaceDrop(note, to, () => commitDrop(noteId, to, key));
          } else {
            commitDrop(noteId, to, key);
          }
        },
      };
    },
    [
      onCrossSpaceDrop,
      canCrossSpaceDrop,
      onCrossSpaceVeto,
      onHoverTarget,
      resolveDropTarget,
      commitDrop,
      clearHoverTimeout,
    ]
  );

  return { dragState, noteDragHandlers, dropTargetHandlers };
}
