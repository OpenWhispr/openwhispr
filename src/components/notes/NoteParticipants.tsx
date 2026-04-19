import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Users, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import type { CalendarAttendee } from "../../types/calendar";

function getInitials(displayName: string | null, email: string): string {
  if (displayName) return displayName.charAt(0).toUpperCase();
  return email.charAt(0).toUpperCase();
}

function getInitialColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 65%)`;
}

interface ParticipantAvatarProps {
  email: string;
  displayName: string | null;
  gravatarHash?: string;
  failed: boolean;
  onImageError: () => void;
}

function ParticipantAvatar({
  email,
  displayName,
  gravatarHash,
  failed,
  onImageError,
}: ParticipantAvatarProps) {
  if (gravatarHash && !failed) {
    return (
      <img
        src={`https://www.gravatar.com/avatar/${gravatarHash}?d=404&s=64`}
        alt=""
        loading="lazy"
        className="shrink-0 w-6 h-6 rounded-full object-cover"
        onError={onImageError}
      />
    );
  }
  return (
    <span
      className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
      style={{ backgroundColor: getInitialColor(email) }}
    >
      {getInitials(displayName, email)}
    </span>
  );
}

interface NoteParticipantsProps {
  noteId: number;
  participants: CalendarAttendee[];
}

export default function NoteParticipants({ noteId, participants }: NoteParticipantsProps) {
  const { t } = useTranslation();
  const [localParticipants, setLocalParticipants] = useState(participants);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<
    Array<{ email: string; display_name: string | null }>
  >([]);
  const [gravatarHashes, setGravatarHashes] = useState<Record<string, string>>({});
  const [failedGravatars, setFailedGravatars] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setLocalParticipants(participants);
  }, [participants]);

  useEffect(() => {
    const emails = localParticipants.map((p) => p.email);
    const missing = emails.filter((e) => !gravatarHashes[e]);
    if (missing.length === 0) return;

    Promise.all(
      missing.map(async (email) => {
        const hash = await window.electronAPI.getMD5Hash(email);
        return { email, hash };
      })
    ).then((results) => {
      setGravatarHashes((prev) => {
        const next = { ...prev };
        for (const { email, hash } of results) next[email] = hash;
        return next;
      });
    });
  }, [localParticipants, gravatarHashes]);

  useEffect(() => {
    if (!open) return;
    const query = search.trim();
    window.electronAPI.searchContacts(query).then((result) => {
      if (result.success) {
        const existing = new Set(localParticipants.map((p) => p.email));
        setSuggestions(result.contacts.filter((c) => !existing.has(c.email)));
      }
    });
  }, [search, open, localParticipants]);

  const saveParticipants = useCallback(
    (updated: CalendarAttendee[]) => {
      window.electronAPI.updateNote(noteId, {
        participants: JSON.stringify(updated),
      });
    },
    [noteId]
  );

  const addParticipant = useCallback(
    (email: string, displayName?: string | null) => {
      const normalized = email.toLowerCase().trim();
      if (!normalized || localParticipants.some((p) => p.email === normalized)) return;
      const updated = [
        ...localParticipants,
        { email: normalized, displayName: displayName || null, responseStatus: null, self: false },
      ];
      setLocalParticipants(updated);
      saveParticipants(updated);
      window.electronAPI.upsertContact({ email: normalized, displayName: displayName || null });
      setSearch("");
    },
    [localParticipants, saveParticipants]
  );

  const removeParticipant = useCallback(
    (email: string) => {
      const updated = localParticipants.filter((p) => p.email !== email);
      setLocalParticipants(updated);
      saveParticipants(updated);
    },
    [localParticipants, saveParticipants]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && search.includes("@")) {
        e.preventDefault();
        addParticipant(search);
      }
    },
    [search, addParticipant]
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarAttendee[]>();
    for (const p of localParticipants) {
      const domain = p.email.split("@")[1] || "other";
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(p);
    }
    return Array.from(groups.entries());
  }, [localParticipants]);

  const chipLabel =
    localParticipants.length > 0
      ? `${localParticipants.length} ${localParticipants.length === 1 ? t("notes.participants.attendee", "attendee") : t("notes.participants.attendees", "attendees")}`
      : t("notes.participants.addAttendees", "Add attendees");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded-md border border-border/70 dark:border-white/25 text-foreground/50 dark:text-foreground/35 hover:text-foreground/60 hover:border-border/60 hover:bg-foreground/3 dark:hover:text-foreground/40 dark:hover:border-white/10 dark:hover:bg-white/3 transition-all duration-150 cursor-pointer outline-none">
          <Users size={11} className="shrink-0" />
          {chipLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="p-2 border-b border-border/50">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("notes.participants.addPlaceholder", "Add attendees...")}
            className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/20 outline-none border-none appearance-none"
            autoFocus
          />
        </div>

        <div className="max-h-64 overflow-y-auto">
          {search && suggestions.length > 0 && (
            <div className="p-1 border-b border-border/30">
              {suggestions.slice(0, 5).map((contact) => (
                <button
                  key={contact.email}
                  onClick={() => addParticipant(contact.email, contact.display_name)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
                >
                  <ParticipantAvatar
                    email={contact.email}
                    displayName={contact.display_name}
                    failed={false}
                    onImageError={() => {}}
                  />
                  <span className="truncate">{contact.display_name || contact.email}</span>
                </button>
              ))}
            </div>
          )}

          {search && !search.includes("@") && suggestions.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-foreground/30">
              {t("notes.participants.typeEmail", "Type an email to add...")}
            </div>
          )}

          {grouped.map(([domain, members]) => (
            <div key={domain} className="p-1">
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                {domain}
              </div>
              {members.map((p) => (
                <div
                  key={p.email}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-foreground/5 transition-colors"
                >
                  <ParticipantAvatar
                    email={p.email}
                    displayName={p.displayName}
                    gravatarHash={gravatarHashes[p.email]}
                    failed={failedGravatars.has(p.email)}
                    onImageError={() => setFailedGravatars((prev) => new Set(prev).add(p.email))}
                  />

                  <span className="flex-1 min-w-0 truncate text-xs text-foreground/70">
                    {p.displayName || p.email.split("@")[0]}
                    {p.self && (
                      <span className="ml-1 text-foreground/30">
                        {t("notes.participants.me", "(me)")}
                      </span>
                    )}
                  </span>

                  <button
                    onClick={() => removeParticipant(p.email)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-foreground/30 hover:text-foreground/60 transition-opacity cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}

          {localParticipants.length === 0 && !search && (
            <div className="px-3 py-4 text-center text-[11px] text-foreground/30">
              {t("notes.participants.typeEmail", "Type an email to add...")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
