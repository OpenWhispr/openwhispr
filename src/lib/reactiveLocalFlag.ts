// Reactive boolean localStorage flag. Writes notify same-window subscribers;
// cross-window flips ride the storage event.
export interface ReactiveLocalFlag {
  read: () => boolean;
  write: (value: boolean) => void;
  clear: () => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createReactiveLocalFlag(key: string): ReactiveLocalFlag {
  const subscribers = new Set<() => void>();
  const notify = () => subscribers.forEach((subscriber) => subscriber());
  return {
    read: () => localStorage.getItem(key) === "true",
    write: (value) => {
      const next = String(value);
      if (localStorage.getItem(key) === next) return;
      localStorage.setItem(key, next);
      notify();
    },
    clear: () => {
      if (localStorage.getItem(key) == null) return;
      localStorage.removeItem(key);
      notify();
    },
    subscribe: (onChange) => {
      subscribers.add(onChange);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) onChange();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        subscribers.delete(onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
  };
}
