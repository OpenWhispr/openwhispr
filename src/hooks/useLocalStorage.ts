import { useCallback, useEffect, useRef, useState } from "react";

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (value: string) => T;
  }
) {
  const serialize = options?.serialize || JSON.stringify;
  const deserialize = options?.deserialize || JSON.parse;

  const [value, setStored] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item === null ? defaultValue : deserialize(item);
    } catch {
      // An unreadable preference keeps its fallback without overwriting storage.
      return defaultValue;
    }
  });

  // Callers put these setters in Effect dependency arrays (usePermissions.ts:161),
  // so the identity has to hold — while an updater function still has to read
  // the newest value within the same tick.
  const current = useRef(value);

  // Direct preference readers need missing defaults, but an abandoned render must not write them.
  useEffect(() => {
    try {
      // Another committed owner/action may already have supplied the value.
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, serialize(defaultValue));
      }
    } catch {
      // Default persistence is best effort, as before.
    }
  }, [key, serialize, defaultValue]);

  const setValue = useCallback(
    (value: T | ((prevState: T) => T)) => {
      try {
        const valueToStore = value instanceof Function ? value(current.current) : value;
        localStorage.setItem(key, serialize(valueToStore));
        current.current = valueToStore;
        setStored(valueToStore);
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, serialize]
  );

  const remove = useCallback(() => {
    try {
      localStorage.removeItem(key);
      current.current = defaultValue;
      // Updater form, so a function-typed T is stored rather than called.
      setStored(() => defaultValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, defaultValue]);

  return [value, setValue, remove] as const;
}
