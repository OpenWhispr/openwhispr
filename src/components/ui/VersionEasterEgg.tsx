import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import logger from "../../utils/logger";

const CLICKS_TO_UNLOCK = 7;
const CLICK_WINDOW_MS = 1800;
const TWISTER_COUNT = 5;
const CONFETTI_COUNT = 42;
const CONFETTI_COLORS = ["#5a50ef", "#8787ff", "#16a34a", "#d97706", "#dc2626", "#f472b6"];
const SITE_URL = "https://TeodorTeo.com";

// Scoped keyframes: the burst is pure CSS, so it costs nothing while the dialog is closed.
const CONFETTI_CSS = `
@keyframes dykt-confetti-fall {
  0% { transform: translate3d(0, -12vh, 0) rotate(0deg); opacity: 0; }
  10% { opacity: 1; }
  100% { transform: translate3d(var(--dx), 100vh, 0) rotate(var(--rot)); opacity: 0.9; }
}
.dykt-confetti { position: fixed; inset: 0; pointer-events: none; z-index: 60; overflow: hidden; }
.dykt-confetti > span {
  position: absolute; top: 0; width: 8px; height: 14px; border-radius: 2px;
  animation: dykt-confetti-fall var(--dur) cubic-bezier(0.22, 0.61, 0.36, 1) var(--delay) forwards;
}
@media (prefers-reduced-motion: reduce) { .dykt-confetti { display: none; } }
`;

interface VersionEasterEggProps {
  children: React.ReactNode;
  className?: string;
}

// Seven quick clicks on the version number open a hidden card. It is the only
// place in the app that names the site, so there is no link to find by accident.
export function VersionEasterEgg({ children, className }: VersionEasterEggProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [twister, setTwister] = useState(0);
  const [burst, setBurst] = useState(0);
  const clicks = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const handleClick = useCallback(() => {
    clicks.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      clicks.current = 0;
    }, CLICK_WINDOW_MS);

    if (clicks.current >= CLICKS_TO_UNLOCK) {
      clicks.current = 0;
      setTwister(Math.floor(Math.random() * TWISTER_COUNT));
      setBurst((n) => n + 1);
      setOpen(true);
    }
  }, []);

  const nextTwister = useCallback(() => {
    setTwister((current) => (current + 1) % TWISTER_COUNT);
    setBurst((n) => n + 1);
  }, []);

  const openSite = useCallback(async () => {
    try {
      const result = await window.electronAPI?.openExternal(SITE_URL);
      if (!result?.success) logger.error("Failed to open site from easter egg", result, "ui");
    } catch (error) {
      logger.error("Failed to open site from easter egg", error, "ui");
    }
  }, []);

  const pieces = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
        key: i,
        left: `${Math.round(((i * 37) % 100) + (i % 3))}%`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        dx: `${((i * 53) % 160) - 80}px`,
        rot: `${360 + ((i * 71) % 540)}deg`,
        dur: `${2.4 + ((i * 13) % 17) / 10}s`,
        delay: `${((i * 7) % 12) / 20}s`,
      })),
    // A new burst replays the animation, so the pieces re-key on `burst`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [burst]
  );

  return (
    <>
      <span
        role="presentation"
        onClick={handleClick}
        className={className}
        style={{ cursor: "default", userSelect: "none" }}
      >
        {children}
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md text-center">
          <DialogHeader className="items-center gap-2 text-center">
            <DialogTitle>{t("easterEgg.title")}</DialogTitle>
            <DialogDescription>{t("easterEgg.intro")}</DialogDescription>
          </DialogHeader>

          <blockquote className="rounded-xl border border-border-subtle bg-surface-1 px-4 py-3 text-base font-medium leading-snug text-foreground">
            {t(`easterEgg.twisters.${twister}`)}
          </blockquote>
          <p className="text-xs text-muted-foreground">{t("easterEgg.hint")}</p>

          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={nextTwister}>
              {t("easterEgg.another")}
            </Button>
            <Button size="sm" onClick={openSite}>
              TeodorTeo.com
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {open && (
        <div key={burst} className="dykt-confetti" aria-hidden="true">
          <style>{CONFETTI_CSS}</style>
          {pieces.map((p) => (
            <span
              key={p.key}
              style={
                {
                  left: p.left,
                  background: p.color,
                  "--dx": p.dx,
                  "--rot": p.rot,
                  "--dur": p.dur,
                  "--delay": p.delay,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
