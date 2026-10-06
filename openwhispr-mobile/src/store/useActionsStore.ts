import { create } from 'zustand';
import { notesRepository } from '@/data';
import type { Action, ActionUpdate } from '@/data';

interface ActionsStore {
  actions: Action[];
  isInitialized: boolean;
  initialize: () => void;
  createAction: (name: string, description: string, prompt: string) => Action;
  updateAction: (id: number, updates: ActionUpdate) => void;
  deleteAction: (id: number) => void;
}

export const useActionsStore = create<ActionsStore>((set) => ({
  actions: [],
  isInitialized: false,

  initialize: () => {
    set({ actions: notesRepository.getActions(), isInitialized: true });
  },

  createAction: (name, description, prompt) => {
    const action = notesRepository.createAction(name, description, prompt);
    set({ actions: notesRepository.getActions() });
    return action;
  },

  updateAction: (id, updates) => {
    notesRepository.updateAction(id, updates);
    set({ actions: notesRepository.getActions() });
  },

  deleteAction: (id) => {
    notesRepository.deleteAction(id);
    set({ actions: notesRepository.getActions() });
  },
}));
