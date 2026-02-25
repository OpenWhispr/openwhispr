import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/Toast";
import logger from "../utils/logger";
import type { FolderItem } from "../types/electron";
import { findDefaultFolder } from "../components/notes/shared";
import {
  useActiveFolderId,
  setActiveFolderId,
  setActiveNoteId,
  getActiveFolderIdValue,
  getActiveNoteIdValue,
  initializeNotes,
} from "../stores/noteStore";

export interface UseFolderManagementReturn {
  folders: FolderItem[];
  folderCounts: Record<number, number>;
  isLoading: boolean;
  isCreatingFolder: boolean;
  newFolderName: string;
  renamingFolderId: number | null;
  renameValue: string;
  showAddNotesDialog: boolean;
  newFolderInputRef: React.RefObject<HTMLInputElement>;
  renameInputRef: React.RefObject<HTMLInputElement>;
  setIsCreatingFolder: (v: boolean) => void;
  setNewFolderName: (v: string) => void;
  setRenamingFolderId: (id: number | null) => void;
  setRenameValue: (v: string) => void;
  setShowAddNotesDialog: (v: boolean) => void;
  loadFolders: () => Promise<FolderItem[]>;
  handleCreateFolder: () => Promise<void>;
  handleConfirmRename: () => Promise<void>;
  handleDeleteFolder: (id: number) => Promise<void>;
}

export function useFolderManagement(): UseFolderManagementReturn {
  const { t } = useTranslation();
  const { toast } = useToast();
  const activeFolderId = useActiveFolderId();

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [folderCounts, setFolderCounts] = useState<Record<number, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);

  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const prevFolderIdRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const loadFolders = useCallback(async () => {
    try {
      const [items, counts] = await Promise.all([
        window.electronAPI.getFolders(),
        window.electronAPI.getFolderNoteCounts(),
      ]);
      if (!isMountedRef.current) return items;
      setFolders(items);
      const countMap: Record<number, number> = {};
      counts.forEach((c) => {
        countMap[c.folder_id] = c.count;
      });
      setFolderCounts(countMap);
      return items;
    } catch (err) {
      logger.warn("Failed to load folders", { error: (err as Error).message }, "notes");
      return [];
    }
  }, []);

  // Load folders on mount, determine initial active folder
  useEffect(() => {
    isMountedRef.current = true;
    const load = async () => {
      try {
        setIsLoading(true);
        const items = await loadFolders();
        if (!isMountedRef.current) return;

        // Respect pre-set activeFolderId (e.g., navigating from "Open Note")
        const presetFolderId = getActiveFolderIdValue();
        const isPresetValid = presetFolderId != null && items.some((f) => f.id === presetFolderId);

        const initialFolderId = isPresetValid
          ? presetFolderId
          : (findDefaultFolder(items)?.id ?? items[0]?.id ?? null);

        if (initialFolderId !== presetFolderId) {
          setActiveFolderId(initialFolderId);
        }
        if (initialFolderId) {
          const notes = await initializeNotes(null, 50, initialFolderId);
          if (!isMountedRef.current) return;
          const presetNoteId = getActiveNoteIdValue();
          if (!presetNoteId && notes.length > 0) {
            setActiveNoteId(notes[0].id);
          }
        }
        prevFolderIdRef.current = initialFolderId;
      } finally {
        if (isMountedRef.current) setIsLoading(false);
      }
    };
    load();
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Re-initialize notes when active folder changes
  useEffect(() => {
    if (!activeFolderId || isLoading) return;
    // Skip if folder hasn't changed (e.g., initial load completing)
    if (prevFolderIdRef.current === activeFolderId) return;
    prevFolderIdRef.current = activeFolderId;
    const loadForFolder = async () => {
      const notes = await initializeNotes(null, 50, activeFolderId);
      setActiveNoteId(notes.length > 0 ? notes[0].id : null);
    };
    loadForFolder();
  }, [activeFolderId, isLoading]);

  // Focus new folder input when creating
  useEffect(() => {
    if (isCreatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [isCreatingFolder]);

  // Focus rename input when renaming
  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFolderId]);

  const handleCreateFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setIsCreatingFolder(false);
      setNewFolderName("");
      return;
    }
    const result = await window.electronAPI.createFolder(trimmed);
    if (result.success && result.folder) {
      await loadFolders();
      setActiveFolderId(result.folder.id);
    } else if (result.error) {
      toast({
        title: t("notes.folders.couldNotCreate"),
        description: result.error,
        variant: "destructive",
      });
    }
    setIsCreatingFolder(false);
    setNewFolderName("");
  }, [newFolderName, loadFolders, toast, t]);

  const handleConfirmRename = useCallback(async () => {
    if (!renamingFolderId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingFolderId(null);
      setRenameValue("");
      return;
    }
    const result = await window.electronAPI.renameFolder(renamingFolderId, trimmed);
    if (result.success) {
      await loadFolders();
    } else if (result.error) {
      toast({
        title: t("notes.folders.couldNotRename"),
        description: result.error,
        variant: "destructive",
      });
    }
    setRenamingFolderId(null);
    setRenameValue("");
  }, [renamingFolderId, renameValue, loadFolders, toast, t]);

  const handleDeleteFolder = useCallback(
    async (folderId: number) => {
      const result = await window.electronAPI.deleteFolder(folderId);
      if (result.success) {
        const personalFolder = findDefaultFolder(folders);
        if (activeFolderId === folderId && personalFolder) {
          setActiveFolderId(personalFolder.id);
        }
        await loadFolders();
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotDelete"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [folders, activeFolderId, loadFolders, toast, t]
  );

  return {
    folders,
    folderCounts,
    isLoading,
    isCreatingFolder,
    newFolderName,
    renamingFolderId,
    renameValue,
    showAddNotesDialog,
    newFolderInputRef,
    renameInputRef,
    setIsCreatingFolder,
    setNewFolderName,
    setRenamingFolderId,
    setRenameValue,
    setShowAddNotesDialog,
    loadFolders,
    handleCreateFolder,
    handleConfirmRename,
    handleDeleteFolder,
  };
}
