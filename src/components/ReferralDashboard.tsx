import React, { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Send, Mail, Copy, Check, Link, UserPlus, Gift, CheckCircle2, User } from "lucide-react";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { useToast } from "./ui/Toast";
import { cn } from "./lib/utils";
import { SpectrogramCard } from "./referral-cards/SpectrogramCard";
import logger from "../utils/logger";

const REFERRAL_WORD_GOAL = 2000;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ReferralStats {
  referralCode: string;
  referralLink: string;
  totalReferrals: number;
  completedReferrals: number;
  totalMonthsEarned: number;
  referrals: Referral[];
}

interface Referral {
  id: string;
  email: string;
  name: string;
  status: "pending" | "completed" | "rewarded";
  created_at: string;
  words_used: number;
}

interface ReferralInvite {
  id: string;
  recipientEmail: string;
  status: "sent" | "opened" | "converted" | "failed";
  sentAt: string;
  openedAt?: string;
  convertedAt?: string;
}

const statusVariants: Record<
  ReferralInvite["status"],
  "success" | "info" | "destructive" | "outline"
> = {
  converted: "success",
  opened: "info",
  failed: "destructive",
  sent: "outline",
};

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
  });
}

function AnimatedCounter({ value, delay = 0 }: { value: number; delay?: number }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (value === 0) {
      setDisplay(0);
      return;
    }

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setDisplay(value);
      return;
    }

    const duration = 800;
    let start: number | null = null;

    const timeout = setTimeout(() => {
      const animate = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setDisplay(Math.round(eased * value));
        if (progress < 1) rafRef.current = requestAnimationFrame(animate);
      };
      rafRef.current = requestAnimationFrame(animate);
    }, delay);

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(rafRef.current);
    };
  }, [value, delay]);

  return <span className="tabular-nums">{display}</span>;
}

function TiltCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const prefersReducedMotion = useRef(
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    if (prefersReducedMotion.current) return;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const rect = card.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const nx = (e.clientX - centerX) / (rect.width / 2);
      const ny = (e.clientY - centerY) / (rect.height / 2);
      const tiltX = -ny * 4;
      const tiltY = nx * 4;
      const hx = ((e.clientX - rect.left) / rect.width) * 100;
      const hy = ((e.clientY - rect.top) / rect.height) * 100;

      card.style.setProperty("--tilt-x", `${tiltX}deg`);
      card.style.setProperty("--tilt-y", `${tiltY}deg`);
      card.style.setProperty("--highlight-x", `${hx}%`);
      card.style.setProperty("--highlight-y", `${hy}%`);
      card.style.setProperty("--highlight-opacity", "1");
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    card.style.setProperty("--tilt-x", "0deg");
    card.style.setProperty("--tilt-y", "0deg");
    card.style.setProperty("--highlight-opacity", "0");
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn("tilt-card", className)}
    >
      {children}
    </div>
  );
}

function StatGauge({
  value,
  label,
  delay = 0,
  highlight = false,
}: {
  value: number;
  label: string;
  delay?: number;
  highlight?: boolean;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay + 400);
    return () => clearTimeout(timer);
  }, [delay]);

  return (
    <div
      className={cn(
        "stat-gauge rounded-md px-3 py-2.5",
        "bg-foreground/3 border border-foreground/6",
        "backdrop-blur-sm"
      )}
      data-active={mounted && value > 0 ? "true" : "false"}
    >
      <div
        className={cn(
          "text-lg font-bold tabular-nums leading-none",
          highlight ? "text-success" : "text-foreground"
        )}
      >
        <AnimatedCounter value={value} delay={delay} />
      </div>
      <div className="text-xs text-foreground/30 mt-1 leading-tight">{label}</div>
    </div>
  );
}

export function ReferralDashboard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [invites, setInvites] = useState<ReferralInvite[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [sendingInvite, setSendingInvite] = useState(false);
  const { toast } = useToast();

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await window.electronAPI?.getReferralStats?.();
      setStats(data ?? null);
    } catch (err) {
      logger.error("Failed to fetch referral stats", { error: err }, "referral");
      setError(t("referral.errors.unableToLoadStats"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchInvites = useCallback(async () => {
    try {
      const result = await window.electronAPI?.getReferralInvites?.();
      setInvites(result?.invites ?? []);
    } catch (err) {
      logger.error("Failed to fetch referral invites", { error: err }, "referral");
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchInvites();
  }, [fetchStats, fetchInvites]);

  const copyLink = async () => {
    if (!stats) return;
    try {
      await navigator.clipboard.writeText(stats.referralLink);
      setCopied(true);
      toast({
        title: t("referral.toasts.copiedTitle"),
        description: t("referral.toasts.copiedDescription"),
        variant: "success",
        duration: 2000,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      logger.error("Failed to copy link", { error: err }, "referral");
      toast({
        title: t("referral.toasts.copyFailedTitle"),
        description: t("referral.toasts.copyFailedDescription"),
        variant: "destructive",
      });
    }
  };

  const sendInvite = async () => {
    if (!emailInput.trim()) return;

    if (!RE_EMAIL.test(emailInput.trim())) {
      toast({
        title: t("referral.toasts.invalidEmailTitle"),
        description: t("referral.toasts.invalidEmailDescription"),
        variant: "destructive",
      });
      return;
    }

    try {
      setSendingInvite(true);
      const result = await window.electronAPI?.sendReferralInvite?.(emailInput.trim());

      if (result?.success) {
        toast({
          title: t("referral.toasts.inviteSentTitle"),
          description: t("referral.toasts.inviteSentDescription", { email: emailInput }),
          variant: "success",
        });
        setEmailInput("");
        fetchInvites();
      } else {
        throw new Error("Failed to send invite");
      }
    } catch (err) {
      logger.error("Failed to send invite", { error: err }, "referral");
      toast({
        title: t("referral.toasts.sendFailedTitle"),
        description: t("referral.toasts.sendFailedDescription"),
        variant: "destructive",
      });
    } finally {
      setSendingInvite(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !sendingInvite) {
      sendInvite();
    }
  };

  if (loading) {
    return (
      <div className="bg-card px-7 pt-9 pb-6">
        <div className="h-5 w-36 rounded bg-foreground/4 animate-pulse" />
        <div className="h-3 w-44 rounded bg-foreground/3 animate-pulse mt-2" />
        <div className="h-16 rounded-lg bg-foreground/3 animate-pulse mt-5" />
        <div className="grid grid-cols-3 gap-2.5 mt-5">
          <div className="h-14 rounded-md bg-foreground/3 animate-pulse" />
          <div className="h-14 rounded-md bg-foreground/3 animate-pulse" />
          <div className="h-14 rounded-md bg-foreground/3 animate-pulse" />
        </div>
        <div className="h-px bg-foreground/4 mt-5" />
        <div className="h-3 w-20 rounded bg-foreground/3 animate-pulse mt-5" />
        <div className="h-8 rounded-md bg-foreground/3 animate-pulse mt-2" />
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="flex flex-col items-center justify-center h-85 bg-card text-center px-6">
        <p className="text-xs text-foreground/40 mb-3">
          {error || t("referral.errors.unableToLoad")}
        </p>
        <button
          onClick={fetchStats}
          aria-label={t("referral.tryAgain")}
          className="px-3.5 py-1.5 rounded-md text-xs font-medium bg-foreground/7 text-foreground/55 border border-foreground/5 hover:bg-foreground/12 hover:text-foreground/90 transition-colors duration-200"
        >
          {t("referral.tryAgain")}
        </button>
      </div>
    );
  }

  return (
    <div className="relative bg-card">
      {/* Animated mesh gradient background */}
      <div className="referral-mesh-bg">
        <div
          className="absolute w-50 h-50 rounded-full blur-[80px] opacity-3"
          style={{
            background: "oklch(0.55 0.2 320)",
            top: "40%",
            left: "15%",
            animation: "mesh-drift 25s ease-in-out infinite alternate",
            animationDelay: "-8s",
          }}
        />
      </div>

      <div className="relative z-10 px-7 pt-7 pb-6">
        <h2 className="text-xl font-bold tracking-tight leading-tight text-foreground">
          {t("referral.title")}
        </h2>
        <p className="text-xs text-foreground/30 mt-1">{t("referral.subtitle")}</p>

        <Tabs defaultValue="refer" className="mt-4">
          <TabsList className="w-full justify-start bg-transparent! p-0! h-auto! gap-4 rounded-none! border-b border-foreground/6">
            <TabsTrigger
              value="refer"
              className="rounded-none! bg-transparent! shadow-none! px-0! pb-2! pt-0! text-xs border-b-2 border-transparent text-foreground/30 hover:text-foreground/50 data-[state=active]:bg-transparent! data-[state=active]:shadow-none! data-[state=active]:border-foreground/50 data-[state=active]:text-foreground"
            >
              {t("referral.tabs.refer")}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="rounded-none! bg-transparent! shadow-none! px-0! pb-2! pt-0! text-xs border-b-2 border-transparent text-foreground/30 hover:text-foreground/50 data-[state=active]:bg-transparent! data-[state=active]:shadow-none! data-[state=active]:border-foreground/50 data-[state=active]:text-foreground"
            >
              {t("referral.tabs.pastInvites")} ({invites.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="refer" className="mt-5">
            <div className="space-y-5">
              <TiltCard>
                <SpectrogramCard referralCode={stats.referralCode} />
              </TiltCard>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded bg-foreground/4 flex items-center justify-center shrink-0">
                    <Link className="w-2.5 h-2.5 text-foreground/30" />
                  </div>
                  <span className="text-xs text-foreground/40">
                    {t("referral.howItWorks.shareLink")}
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded bg-foreground/4 flex items-center justify-center shrink-0">
                    <UserPlus className="w-2.5 h-2.5 text-foreground/30" />
                  </div>
                  <span className="text-xs text-foreground/40">
                    {t("referral.howItWorks.theySignUp")}
                    <strong className="text-foreground/60">
                      {t("referral.howItWorks.freeMonthOfPro")}
                    </strong>
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="w-5 h-5 rounded bg-foreground/4 flex items-center justify-center shrink-0">
                    <Gift className="w-2.5 h-2.5 text-foreground/30" />
                  </div>
                  <span className="text-xs text-foreground/40">
                    {t("referral.howItWorks.youGet")}
                    <strong className="text-foreground/60">
                      {t("referral.howItWorks.freeMonth")}
                    </strong>
                    {t("referral.howItWorks.whenTheyDictate")}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-medium text-foreground/25 uppercase tracking-wider">
                  {t("referral.inviteLink.title")}
                </h4>
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 h-8 px-3 rounded-md bg-foreground/4 border border-foreground/7 overflow-hidden">
                    <Link className="w-3 h-3 text-foreground/20 shrink-0" />
                    <span className="text-xs text-foreground/50 font-mono truncate select-all">
                      {stats.referralLink}
                    </span>
                  </div>
                  <button
                    onClick={copyLink}
                    aria-label={t("referral.inviteLink.copy")}
                    className={cn(
                      "shrink-0 h-8 px-3.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-[background-color,color,transform] duration-200 active:scale-[0.97]",
                      copied
                        ? "bg-emerald-500/15 text-emerald-400/80"
                        : "bg-foreground/7 text-foreground/55 border border-foreground/5 hover:bg-foreground/12 hover:text-foreground/90"
                    )}
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? t("referral.inviteLink.copied") : t("referral.inviteLink.copy")}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-medium text-foreground/25 uppercase tracking-wider">
                  {t("referral.sendInvites.title")}
                </h4>
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    placeholder={t("referral.sendInvites.placeholder")}
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={sendingInvite}
                    className="flex-1 h-8 px-3 text-xs rounded-md bg-foreground/4 border border-foreground/7 text-foreground/70 placeholder:text-foreground/20 focus:outline-none focus:border-foreground/15 focus:ring-1 focus:ring-foreground/10 disabled:opacity-50"
                  />
                  <button
                    onClick={sendInvite}
                    disabled={sendingInvite || !emailInput.trim()}
                    aria-label={t("referral.sendInvites.send")}
                    className="shrink-0 h-8 px-3.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-[background-color,color,transform] duration-200 bg-foreground/7 text-foreground/55 border border-foreground/5 hover:bg-foreground/12 hover:text-foreground/90 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {sendingInvite ? (
                      <div className="w-3 h-3 border-1.5 border-current border-r-transparent rounded-full animate-spin" />
                    ) : (
                      <Send className="w-3 h-3" />
                    )}
                    {sendingInvite
                      ? t("referral.sendInvites.sending")
                      : t("referral.sendInvites.send")}
                  </button>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-5">
            <div className="grid grid-cols-3 gap-2.5">
              <StatGauge
                value={stats.totalReferrals}
                label={t("referral.stats.referred")}
                delay={0}
              />
              <StatGauge
                value={stats.completedReferrals}
                label={t("referral.stats.converted")}
                delay={150}
              />
              <StatGauge
                value={stats.totalMonthsEarned}
                label={t("referral.stats.monthsEarned")}
                delay={300}
                highlight={stats.totalMonthsEarned > 0}
              />
            </div>

            {/* Friends section — actual signups with word progress */}
            {stats.referrals.length > 0 && (
              <div className="mt-5">
                <h4 className="text-xs font-medium text-foreground/25 uppercase tracking-wider mb-2">
                  {t("referral.friends.title")}
                </h4>
                <div className="space-y-1.5">
                  {stats.referrals.map((referral) => {
                    const isComplete = referral.status === "rewarded";
                    const wordsUsed = Math.min(referral.words_used, REFERRAL_WORD_GOAL);
                    const progress = Math.round((wordsUsed / REFERRAL_WORD_GOAL) * 100);
                    const displayName = referral.name || referral.email;

                    return (
                      <div
                        key={referral.id}
                        className="py-2 px-2.5 rounded-md bg-foreground/3 border border-foreground/5"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <User className="w-3 h-3 text-foreground/20 shrink-0" />
                            <span className="text-xs text-foreground/60 truncate">
                              {displayName}
                            </span>
                          </div>
                          {isComplete ? (
                            <div className="flex items-center gap-1 ml-2 shrink-0">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400/80" />
                              <span className="text-xs text-emerald-400/80 font-medium">
                                {t("referral.friends.completed")}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-foreground/30 tabular-nums ml-2 shrink-0">
                              {wordsUsed.toLocaleString()} / {REFERRAL_WORD_GOAL.toLocaleString()}
                            </span>
                          )}
                        </div>
                        <div className="h-1 rounded-full bg-foreground/6 overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-500",
                              isComplete ? "bg-emerald-400/60" : "bg-foreground/20"
                            )}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sent Invites section */}
            {invites.length > 0 ? (
              <div className="mt-5">
                <h4 className="text-xs font-medium text-foreground/25 uppercase tracking-wider mb-2">
                  {t("referral.friends.sentInvites")}
                </h4>
                <div className="space-y-1">
                  {invites.map((invite) => {
                    const variant = statusVariants[invite.status] ?? statusVariants.sent;
                    const label = t(`referral.status.${invite.status}`);
                    return (
                      <div
                        key={invite.id}
                        className="flex items-center justify-between py-1.5 px-2.5 rounded-md bg-foreground/3 border border-foreground/5 hover:border-foreground/8 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Mail className="w-3 h-3 text-foreground/20 shrink-0" />
                          <span className="text-xs text-foreground/60 truncate">
                            {invite.recipientEmail}
                          </span>
                          <span className="text-xs text-foreground/15 shrink-0">
                            {formatDate(invite.sentAt)}
                          </span>
                        </div>
                        <Badge variant={variant} className="ml-2 text-xs shrink-0">
                          {label}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : !stats.referrals?.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Mail className="w-5 h-5 text-foreground/10 mb-2" />
                <p className="text-xs text-foreground/25">{t("referral.empty.title")}</p>
                <p className="text-xs text-foreground/15 mt-0.5">
                  {t("referral.empty.description")}
                </p>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
