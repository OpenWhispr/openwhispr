import { useState } from "react";
import { cn } from "./lib/utils";

const SIZES = {
  sm: { box: "w-5 h-5", text: "text-[9px]" },
  md: { box: "w-7 h-7", text: "text-[10px]" },
} as const;

interface MemberAvatarProps {
  name: string | null;
  email: string;
  image?: string | null;
  size?: keyof typeof SIZES;
}

export default function MemberAvatar({ name, email, image, size = "md" }: MemberAvatarProps) {
  const { box, text } = SIZES[size];
  // Avatar URLs go stale (OAuth-hosted images expire/rotate); tracking the
  // failed src — rather than a boolean — retries automatically if it changes.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (image && image !== failedSrc) {
    return (
      <img
        src={image}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(image)}
        className={cn(box, "rounded-full object-cover shrink-0")}
      />
    );
  }
  return (
    <span
      className={cn(
        box,
        text,
        "rounded-full bg-primary/10 text-primary font-semibold flex items-center justify-center shrink-0"
      )}
    >
      {(name || email).slice(0, 2).toUpperCase()}
    </span>
  );
}
