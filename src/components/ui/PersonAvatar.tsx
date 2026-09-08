import { useEffect, useState } from "react";
import { cn } from "../lib/utils";

function getInitial(displayName: string | null, email: string | null): string {
  return (displayName || email || "?").charAt(0).toUpperCase();
}

function getInitialColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 45%, 65%)`;
}

interface PersonAvatarProps {
  email: string | null;
  displayName: string | null;
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/** Gravatar avatar with a colored-initial fallback. Fetches its own MD5 hash. */
export default function PersonAvatar({
  email,
  displayName,
  size = 24,
  className,
}: PersonAvatarProps) {
  const [hash, setHash] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setHash(null);
    setFailed(false);
    if (!email) return;
    let cancelled = false;
    window.electronAPI?.getMD5Hash?.(email).then((result) => {
      if (!cancelled) setHash(result);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  if (hash && !failed) {
    return (
      <img
        src={`https://www.gravatar.com/avatar/${hash}?d=404&s=${Math.min(512, size * 2)}`}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        backgroundColor: getInitialColor(email || displayName || "?"),
      }}
      className={cn(
        "shrink-0 rounded-full flex items-center justify-center font-medium text-white",
        className
      )}
    >
      {getInitial(displayName, email)}
    </span>
  );
}
