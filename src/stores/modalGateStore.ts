import { useLayoutEffect } from "react";
import { create } from "zustand";

/**
 * Modals that open on their own (at launch, or after joining a workspace). The workspace intro
 * waits while any of them is open or about to open, so two auto-opened modals never stack.
 */
export type GatedModal =
  | "notesStructureIntro"
  | "notesStructureIntroPending"
  | "invitation"
  | "notesHandOff"
  | "joinYourTeam"
  | "joinYourTeamPending"
  | "postMigration"
  | "postMigrationPending"
  | "toneStyleSetup";

interface ModalGateState {
  // A count per modal, since the same modal can be mounted in two places at once.
  open: Partial<Record<GatedModal, number>>;
  setModalOpen: (modal: GatedModal, open: boolean) => void;
}

export const useModalGateStore = create<ModalGateState>((set) => ({
  open: {},
  setModalOpen: (modal, open) =>
    set((state) => {
      const count = Math.max(0, (state.open[modal] ?? 0) + (open ? 1 : -1));
      const next = { ...state.open };
      if (count > 0) next[modal] = count;
      else delete next[modal];
      return { open: next };
    }),
}));

export function selectGatedModalOpen(state: Pick<ModalGateState, "open">): boolean {
  return Object.keys(state.open).length > 0;
}

/**
 * Holds the gate while `open` is true. A layout effect, so the gate changes in the same commit as
 * the modal and the workspace intro never paints for a frame in between.
 */
export function useModalGate(modal: GatedModal, open: boolean): void {
  useLayoutEffect(() => {
    if (!open) return;
    const { setModalOpen } = useModalGateStore.getState();
    setModalOpen(modal, true);
    return () => setModalOpen(modal, false);
  }, [modal, open]);
}
