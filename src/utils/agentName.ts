import { useState } from "react";
import { getSettings, useSettingsStore } from "../stores/settingsStore";

const AGENT_NAME_KEY = "agentName";
const DEFAULT_AGENT_NAME = "OpenWhispr";

export const getAgentName = (): string => {
  return localStorage.getItem(AGENT_NAME_KEY) || DEFAULT_AGENT_NAME;
};

function syncAgentNameToDictionary(newName: string, oldName?: string): void {
  let dictionary = [...getSettings().customDictionary];

  // Remove old agent name if it changed
  if (oldName && oldName !== newName) {
    dictionary = dictionary.filter((w) => w !== oldName);
  }

  // Add new name at the front if not already present
  const trimmed = newName.trim();
  if (trimmed && !dictionary.includes(trimmed)) {
    dictionary = [trimmed, ...dictionary];
  }

  useSettingsStore.getState().setCustomDictionary(dictionary);
}

export const setAgentName = (name: string): void => {
  const oldName = localStorage.getItem(AGENT_NAME_KEY) || "";
  const trimmed = name.trim() || DEFAULT_AGENT_NAME;
  localStorage.setItem(AGENT_NAME_KEY, trimmed);
  syncAgentNameToDictionary(trimmed, oldName);
};

export const ensureAgentNameInDictionary = (): void => {
  const name = getAgentName();
  if (name) syncAgentNameToDictionary(name);
};

export const useAgentName = () => {
  const [agentName, setAgentNameState] = useState<string>(getAgentName());

  const updateAgentName = (name: string) => {
    setAgentName(name);
    setAgentNameState(name.trim() || DEFAULT_AGENT_NAME);
  };

  return { agentName, setAgentName: updateAgentName };
};
