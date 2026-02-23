import { useState } from "react";

const AGENT_NAME_KEY = "agentName";
const DICTIONARY_KEY = "customDictionary";
const DEFAULT_AGENT_NAME = "OpenWhispr";

export const getAgentName = (): string => {
  return localStorage.getItem(AGENT_NAME_KEY) || DEFAULT_AGENT_NAME;
};

function syncAgentNameToDictionary(newName: string, oldName?: string): void {
  let dictionary: string[] = [];
  try {
    const raw = localStorage.getItem(DICTIONARY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) dictionary = parsed;
    }
  } catch {
    // ignore
  }

  // Remove old agent name if it changed
  if (oldName && oldName !== newName) {
    dictionary = dictionary.filter((w) => w !== oldName);
  }

  const passAgentNameToWhisper = localStorage.getItem("passAgentNameToWhisper") === "true";
  const trimmed = newName.trim();

  if (passAgentNameToWhisper) {
    // Add new name at the front if not already present
    if (trimmed && !dictionary.includes(trimmed)) {
      dictionary = [trimmed, ...dictionary];
    }
  } else {
    // Ensure the name is removed if the setting is disabled
    if (trimmed) {
      dictionary = dictionary.filter((w) => w !== trimmed);
    }
  }

  localStorage.setItem(DICTIONARY_KEY, JSON.stringify(dictionary));

  // Best-effort sync to SQLite
  window.electronAPI?.setDictionary?.(dictionary).catch(() => {});
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
