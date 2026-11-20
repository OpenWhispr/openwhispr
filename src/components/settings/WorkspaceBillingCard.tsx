import React, { Suspense, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Copy,
  CreditCard,
  ExternalLink,
  Loader2,
  Plus,
  Shield,
  User,
  UserPlus,
  Zap,
} from "../icons";
import { Button } from "../ui/button";
import {
  BillingBanner,
  BillingBlock,
  BillingBox,
  BillingRow,
  DetailRows,
  PillButton,
  PlanName,
  UsageMeterRow,
  UsageValueRow,
} from "./billing/BillingUi";
import { formatBillingDate, translationParams } from "./billing/billingFormat";
import { PlansGrid, type BusinessCardAction, type EnterpriseCardAction } from "./billing/PlansGrid";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { WorkspacesService, type SeatPreview } from "../../services/WorkspacesService";
import { CloudApiError } from "../../services/cloudApi";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../../lib/billingRequestIdentity";
import { openAdminConsole } from "../../lib/auth";
import { CONTACT_SALES_URL } from "../../lib/contactSales";
import { canSelfServeEnterprise } from "../../lib/workspaceBilling";
import { freeWorkspaceCta } from "../../lib/workspacePeople";
import {
  WORKSPACE_PLAN_NAMES,
  showsMembersCount,
  workspacePlanState,
  type WorkspaceAction,
  type WorkspaceDetailValue,
  type WorkspaceTier,
  type WorkspaceUsageRow,
} from "../../lib/workspacePlanState";
import { useWorkspacePeopleCount } from "../../hooks/useWorkspacePeopleCount";
import { formatAmount } from "../../utils/formatAmount";
import type { Workspace } from "../../types/electron";

const InviteTeammateDialog = React.lazy(() => import("../InviteTeammateDialog"));
const EnterpriseCheckoutDialog = React.lazy(() => import("./EnterpriseCheckoutDialog"));

const KEY_PREFIX = "settingsPage.billing.workspace.";

type IconComponent = ComponentType<{ className?: string }>;

const TIER_ICONS: Record<WorkspaceTier, IconComponent> = {
  free: User,
  pro: Zap,
  business: Building2,
  enterprise: Shield,
};

const ACTION_ICONS: Partial<Record<WorkspaceAction["kind"], IconComponent>> = {
  manageBilling: CreditCard,
  openConsole: ExternalLink,
};

type Busy = "checkout" | "preview" | "seats" | WorkspaceAction["kind"];

async function openExternalUrl(url: string): Promise<void> {
  if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url);
  else window.open(url, "_blank");
}

/** The avatar letter: the first character, whole even when it is outside the BMP. */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "").toLocaleUpperCase();
}

interface SeatQuote {
  preview: SeatPreview;
  identity: BillingIdentity;
}

interface Props {
  workspace: Workspace;
  onRefreshEntitlement?: () => Promise<void>;
  /** Shows the "View Personal plan" link beside a solo workspace's Pro hint. */
  onViewPersonal?: () => void;
}

export default function WorkspaceBillingCard({
  workspace,
  onRefreshEntitlement,
  onViewPersonal,
}: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [seatQuote, setSeatQuote] = useState<SeatQuote | null>(null);
  // A quote for a workspace the card no longer shows is gone, so the dialog never shows it.
  const seatPreview =
    seatQuote && seatQuote.identity.workspaceId === workspace.id ? seatQuote.preview : null;
  // Read after an await: the card can be shown another workspace (same instance) or be gone.
  const workspaceIdRef = useRef(workspace.id);
  workspaceIdRef.current = workspace.id;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Coming back to the workspace must not reopen the quote it left.
  useEffect(() => {
    setSeatQuote((quote) => (quote && quote.identity.workspaceId !== workspace.id ? null : quote));
  }, [workspace.id]);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    void refresh();
    void onRefreshEntitlement?.();
  });
  // Counted for the free buttons (also asked for a lapsed plan's owner, whose seats caption then
  // names pending invitations) and for the Members row; other cards send no extra reads.
  const countsPeople =
    freeWorkspaceCta(workspace, null) === "pending" || showsMembersCount(workspace);
  const { people, retry: retryPeople } = useWorkspacePeopleCount(
    countsPeople ? workspace.id : null
  );
  const freeCta = freeWorkspaceCta(workspace, people);
  // Bound to its workspace, so the dialog never invites into one the card no longer shows.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);
  const [enterpriseWorkspaceId, setEnterpriseWorkspaceId] = useState<string | null>(null);

  function formatDate(iso: string): string {
    return formatBillingDate(iso, i18n.language);
  }

  function formatNumber(value: number): string {
    return value.toLocaleString(i18n.language);
  }

  async function openBilling(kind: Busy, getUrl: () => Promise<string>) {
    setBusy(kind);
    try {
      await openExternalUrl(await getUrl());
      refreshOnReturn();
    } catch (error) {
      toast({
        title: t("common.error"),
        description: billingErrorText(error),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  function billingErrorText(error: unknown): string {
    if (error instanceof CloudApiError && error.code === "default_workspace_has_no_teammates") {
      return t("settingsPage.billing.errors.noTeammates");
    }
    return error instanceof Error ? error.message : t("common.unknownError");
  }

  function startBusinessCheckout(): void {
    void openBilling("checkout", () =>
      WorkspacesService.billingCheckout(workspace.id, "monthly", { tier: "business" })
    );
  }

  function renderInviteButton(variant: "primary" | "secondary"): React.ReactNode {
    return (
      <PillButton
        variant={variant}
        icon={UserPlus}
        disabled={busy !== null}
        onClick={() => setInviteWorkspaceId(workspace.id)}
      >
        {t("settingsPage.billing.free.inviteTeammates")}
      </PillButton>
    );
  }

  function renderUpgradeButton(variant: "primary" | "secondary"): React.ReactNode {
    return (
      <PillButton
        variant={variant}
        busy={busy === "checkout"}
        disabled={busy !== null}
        onClick={startBusinessCheckout}
      >
        {t("settingsPage.billing.free.upgradeToBusiness")}
      </PillButton>
    );
  }

  function renderFreeActions(): React.ReactNode {
    switch (freeCta) {
      case "none":
        return null;
      case "pending":
        // Holds the buttons' height so the card doesn't jump when the count lands.
        return (
          <div className="pt-1">
            <div
              aria-hidden="true"
              className="h-8 w-56 max-w-full rounded-full bg-foreground/5 dark:bg-white/5 animate-pulse"
            />
          </div>
        );
      case "invite":
        return (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {renderInviteButton("primary")}
              {renderUpgradeButton("secondary")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.billing.free.proHint", {
                price: t("settingsPage.account.pricing.pro.monthlyPrice"),
              })}
              {onViewPersonal && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={onViewPersonal}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("settingsPage.billing.free.viewPersonal")}
                  </button>
                </>
              )}
            </p>
          </div>
        );
      case "upgrade":
        return <div className="flex flex-wrap gap-2 pt-1">{renderUpgradeButton("primary")}</div>;
      case "unknown":
        return (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {renderInviteButton("secondary")}
              {renderUpgradeButton("secondary")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.billing.free.countFailed")}{" "}
              <button
                type="button"
                onClick={retryPeople}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("common.retry")}
              </button>
            </p>
          </div>
        );
    }
  }

  function isQuoteCurrent(identity: BillingIdentity): boolean {
    return (
      mountedRef.current &&
      isSameBillingIdentity(identity, currentBillingIdentity(workspaceIdRef.current))
    );
  }

  function showSeatUpdateFailed(): void {
    toast({ title: t("settingsPage.unifiedBilling.seatUpdateFailed"), variant: "destructive" });
  }

  async function previewSeatIncrease() {
    const identity = currentBillingIdentity(workspace.id);
    if (!identity) {
      showSeatUpdateFailed();
      return;
    }
    setBusy("preview");
    try {
      const preview = await WorkspacesService.previewSeats(
        workspace.id,
        1,
        identity.authGeneration
      );
      if (isQuoteCurrent(identity)) setSeatQuote({ preview, identity });
    } catch (error) {
      if (!mountedRef.current) return;
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdateFailed"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function confirmSeatIncrease() {
    if (!seatQuote) return;
    const { preview, identity } = seatQuote;
    if (identity.workspaceId === null || !isQuoteCurrent(identity)) {
      setSeatQuote(null);
      showSeatUpdateFailed();
      return;
    }
    setBusy("seats");
    try {
      await WorkspacesService.updateSeats(
        identity.workspaceId,
        preview.next_quantity,
        identity.authGeneration
      );
      setSeatQuote(null);
      await refresh({ fresh: true });
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdated", {
          count: preview.next_quantity,
        }),
      });
    } catch (error) {
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdateFailed"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  const plan = workspacePlanState(workspace, people, Date.now());
  const planName = WORKSPACE_PLAN_NAMES[plan.tier];

  function runAction(action: WorkspaceAction): void {
    switch (action.kind) {
      case "manageBilling":
      case "updatePayment":
      case "finishCheckout":
      case "keepPlan":
        void openBilling(action.kind, () => WorkspacesService.billingPortal(workspace.id));
        return;
      case "resubscribe":
        void openBilling("resubscribe", () =>
          WorkspacesService.billingCheckout(workspace.id, "monthly", { tier: "business" })
        );
        return;
      case "openConsole":
        void openConsole();
        return;
      case "upgradeEnterprise":
        setEnterpriseWorkspaceId(workspace.id);
        return;
      case "addSeats":
        void previewSeatIncrease();
        return;
      case "viewPersonal":
        onViewPersonal?.();
        return;
      case "copyEmail":
        void copyEmail(action.email);
        return;
    }
  }

  async function openConsole(): Promise<void> {
    setBusy("openConsole");
    try {
      await openAdminConsole();
    } finally {
      setBusy(null);
    }
  }

  async function copyEmail(email: string): Promise<void> {
    try {
      const result = await window.electronAPI?.writeClipboard?.(email);
      if (!result?.success) throw new Error("clipboard");
      toast({ title: t("common.copied") });
    } catch {
      toast({ title: t("common.error"), variant: "destructive" });
    }
  }

  function translate(key: string, params?: Record<string, string>): string {
    return t(`${KEY_PREFIX}${key}`, translationParams(params, formatDate));
  }

  function renderActionButton(action: WorkspaceAction): React.ReactNode {
    const label =
      action.kind === "keepPlan"
        ? t(`${KEY_PREFIX}actions.keepPlan`, { plan: planName })
        : t(`${KEY_PREFIX}actions.${action.kind}`);
    return (
      <PillButton
        key={action.kind}
        variant="secondary"
        icon={ACTION_ICONS[action.kind]}
        busy={busy === action.kind}
        disabled={busy !== null}
        onClick={() => runAction(action)}
      >
        {label}
      </PillButton>
    );
  }

  function renderDetailValue(value: WorkspaceDetailValue): React.ReactNode {
    switch (value.kind) {
      case "text":
        return value.text;
      case "key":
        return t(value.key);
      case "date":
        return formatDate(value.iso);
      case "manager": {
        const { email } = value;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-medium text-muted-foreground"
            >
              {initialOf(value.name)}
            </span>
            <span dir="auto" className="min-w-0 truncate">
              {value.name}
            </span>
            {email && (
              <PillButton
                variant="secondary"
                icon={Copy}
                className="ms-auto px-3 py-1"
                onClick={() => runAction({ kind: "copyEmail", email })}
              >
                {t(`${KEY_PREFIX}actions.copyEmail`)}
              </PillButton>
            )}
          </span>
        );
      }
    }
  }

  function renderUsageRow(row: WorkspaceUsageRow): React.ReactNode {
    switch (row.kind) {
      case "unlimited":
        return (
          <UsageValueRow
            key="unlimited"
            label={t("settingsPage.billing.personal.usage.cloudTranscription")}
            value={t("settingsPage.billing.personal.usage.unlimited")}
          />
        );
      case "members":
        return (
          <UsageValueRow
            key="members"
            label={translate("usage.members")}
            value={<bdi>{row.count === null ? "—" : formatNumber(row.count)}</bdi>}
          />
        );
      case "seats": {
        const seatsUsed = formatNumber(row.used);
        const seatsTotal = formatNumber(row.total);
        return (
          <UsageMeterRow
            key="seats"
            label={translate("usage.seats")}
            value={
              <span dir="ltr">
                {seatsUsed} / {seatsTotal}
              </span>
            }
            percent={row.total > 0 ? (row.used / row.total) * 100 : 0}
            caption={row.captionKey ? translate(row.captionKey, row.params) : undefined}
            action={
              row.addSeats ? (
                <PillButton
                  variant="primary"
                  icon={Plus}
                  busy={busy === "preview"}
                  disabled={busy !== null}
                  onClick={() => runAction({ kind: "addSeats" })}
                >
                  {t("settingsPage.unifiedBilling.addSeat")}
                </PillButton>
              ) : undefined
            }
          />
        );
      }
    }
  }

  // No checkout where the card offers none.
  const gridBusiness: BusinessCardAction =
    freeCta === "none"
      ? { kind: "none" }
      : { kind: "checkout", busy: busy === "checkout", disabled: busy !== null };
  const gridEnterprise: EnterpriseCardAction = canSelfServeEnterprise(workspace)
    ? { kind: "checkout" }
    : { kind: "contactSales", ownerName: null };

  function runGridEnterprise(action: EnterpriseCardAction): void {
    if (action.kind === "checkout") setEnterpriseWorkspaceId(workspace.id);
    else if (action.kind === "contactSales") {
      openExternalUrl(CONTACT_SALES_URL).catch((error: unknown) => {
        toast({
          title: t("common.error"),
          description: billingErrorText(error),
          variant: "destructive",
        });
      });
    }
  }

  const banner = plan.banner;
  // The View Personal plan button needs somewhere to go.
  const planActions = plan.planActions.filter(
    (action) => action.kind !== "viewPersonal" || onViewPersonal
  );

  return (
    <div className="flex flex-col gap-5">
      {banner && (
        <BillingBanner
          tone={banner.tone}
          title={translate(banner.titleKey, banner.params)}
          body={translate(banner.bodyKey, banner.params)}
          action={banner.action ? renderActionButton(banner.action) : undefined}
        />
      )}

      <BillingBlock title={t("settingsPage.billing.personal.blocks.currentPlan")}>
        <BillingBox>
          <BillingRow>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <PlanName
                icon={TIER_ICONS[plan.tier]}
                name={planName}
                badge={
                  plan.badge
                    ? { label: translate(plan.badge.key, plan.badge.params), tone: plan.badge.tone }
                    : undefined
                }
              />
              {plan.planLine && (
                <p dir="auto" className="truncate text-xs text-muted-foreground">
                  {translate(plan.planLine.key, plan.planLine.params)}
                </p>
              )}
              {plan.freeCta && renderFreeActions()}
            </div>
            {!plan.freeCta && (planActions.length > 0 || plan.managedBadge) && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {plan.managedBadge && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    <Shield aria-hidden="true" className="size-3" />
                    {translate("managedAccount")}
                  </span>
                )}
                {planActions.map(renderActionButton)}
              </div>
            )}
          </BillingRow>
        </BillingBox>
      </BillingBlock>

      {plan.usage.length > 0 && (
        <BillingBlock title={t("settingsPage.billing.personal.blocks.usage")}>
          <BillingBox>{plan.usage.map(renderUsageRow)}</BillingBox>
        </BillingBlock>
      )}

      {plan.details && (
        <BillingBlock title={translate(plan.details.titleKey)}>
          <BillingBox padded="details">
            <DetailRows
              rows={plan.details.rows.map((row) => ({
                label: translate(row.labelKey),
                value: renderDetailValue(row.value),
              }))}
            />
          </BillingBox>
        </BillingBlock>
      )}

      {plan.showPlansGrid && (
        <div data-plans-grid>
          <PlansGrid
            isSignedIn
            cards={["business", "enterprise"]}
            business={gridBusiness}
            businessDowngrade={null}
            onBusinessAction={(action) => {
              if (action.kind === "checkout") startBusinessCheckout();
            }}
            enterprise={{ action: gridEnterprise, manage: null, entitled: false }}
            onEnterprise={runGridEnterprise}
            columns={2}
          />
        </div>
      )}

      {enterpriseWorkspaceId === workspace.id && (
        <Suspense fallback={null}>
          <EnterpriseCheckoutDialog
            open
            onOpenChange={(open) => {
              if (!open) setEnterpriseWorkspaceId(null);
            }}
            workspaces={[workspace]}
            initialWorkspaceId={workspace.id}
            onRefreshEntitlement={onRefreshEntitlement}
          />
        </Suspense>
      )}

      {inviteWorkspaceId === workspace.id && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open
            onOpenChange={(open) => {
              if (!open) setInviteWorkspaceId(null);
            }}
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            onInvitationsChanged={retryPeople}
          />
        </Suspense>
      )}

      <Dialog open={seatPreview !== null} onOpenChange={(open) => !open && setSeatQuote(null)}>
        <DialogContent className="sm:max-w-90">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.unifiedBilling.confirmSeats.title")}</DialogTitle>
            <DialogDescription>
              {seatPreview &&
                t("settingsPage.unifiedBilling.confirmSeats.description", {
                  workspace: workspace.name,
                  count: seatPreview.next_quantity,
                })}
            </DialogDescription>
          </DialogHeader>
          {seatPreview && (
            <div className="rounded-lg border border-border/70 divide-y divide-border/60">
              <div className="flex justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {t("settingsPage.unifiedBilling.confirmSeats.newCapacity")}
                </span>
                <span className="font-medium">{seatPreview.next_quantity}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {t("settingsPage.unifiedBilling.confirmSeats.chargeToday")}
                </span>
                <span className="font-medium">
                  {formatAmount(seatPreview.amount_due, seatPreview.currency)}
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSeatQuote(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void confirmSeatIncrease()}
              disabled={busy === "seats"}
            >
              {busy === "seats" && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("settingsPage.unifiedBilling.confirmSeats.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
