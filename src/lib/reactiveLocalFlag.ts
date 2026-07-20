// Reactive view over a boolean localStorage flag: same-window writers call
// notify(); cross-window flips ride the storage event.
export interface ReactiveLocalFlag {
  read: () => boolean;
  notify: () => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createReactiveLocalFlag(key: string): ReactiveLocalFlag {
  const subscribers = new Set<() => void>();
  return {
    read: () => localStorage.getItem(key) === "true",
    notify: () => subscribers.forEach((n) => n()),
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
