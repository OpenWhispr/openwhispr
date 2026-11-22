import React, {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Copy, CreditCard, ExternalLink, Shield, User, UserPlus, Zap } from "../icons";
import { AddSeatsDialog } from "./billing/AddSeatsDialog";
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
import {
  formatBillingDate,
  formatBillingInvoice,
  translationParams,
} from "./billing/billingFormat";
import { PlansGrid, type BusinessCardAction, type EnterpriseCardAction } from "./billing/PlansGrid";
import { useBillingSummary } from "../../hooks/useBillingSummary";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { useToast } from "../ui/useToast";
import { WorkspacesService } from "../../services/WorkspacesService";
import { CloudApiError } from "../../services/cloudApi";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../../lib/billingRequestIdentity";
import { workspaceCan } from "../../lib/capabilities";
import {
  getValidatedAuthGeneration,
  subscribeAuthRequestContext,
} from "../../lib/authRequestContext";
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
import { openExternalUrl } from "../../utils/externalLinks";
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

type Busy = "checkout" | WorkspaceAction["kind"];

/** The avatar letter: the first character, whole even when it is outside the BMP. */
function initialOf(name: string): string {
  return (Array.from(name.trim())[0] ?? "").toLocaleUpperCase();
}

interface Props {
  workspace: Workspace;
  yearly: boolean;
  onYearlyChange: (yearly: boolean) => void;
  onRefreshEntitlement?: () => Promise<void>;
  /** Shows the "View Personal plan" link beside a solo workspace's Pro hint. */
  onViewPersonal?: () => void;
}

export default function WorkspaceBillingCard({
  workspace,
  yearly,
  onYearlyChange,
  onRefreshEntitlement,
  onViewPersonal,
}: Props) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const canManageBilling = workspaceCan(workspace, "manage_billing");
  const authGeneration = useSyncExternalStore(
    subscribeAuthRequestContext,
    getValidatedAuthGeneration
  );
  const billingTerms = JSON.stringify([
    workspace.plan,
    workspace.status,
    workspace.stripe_subscription_id,
    workspace.current_period_end,
    workspace.cancel_at_period_end,
  ]);
  const { summary, refresh: refreshBillingSummary } = useBillingSummary(
    { kind: "workspace", workspaceId: workspace.id, canManageBilling },
    JSON.stringify([billingTerms, workspace.seats])
  );
  const [seatSplit, setSeatSplit] = useState<{
    workspace: Workspace;
    authGeneration: number;
    pending: number;
  } | null>(null);
  useEffect(() => {
    const used = workspace.seats_used;
    if (
      authGeneration == null ||
      workspace.plan === "free" ||
      workspace.role === "member" ||
      used == null ||
      used < 1 ||
      workspace.member_count == null ||
      workspace.invitation_count == null
    )
      return;
    let current = true;
    void WorkspacesService.getPeopleCounts(workspace.id).then(
      (stats) => {
        const billable = stats.billable_members;
        // Only compare occupied seats and billable members from matching workspace counts.
        // Invitations can be nonbillable, and directory reservations can occupy seats too.
        if (
          current &&
          getValidatedAuthGeneration() === authGeneration &&
          stats.seats === workspace.seats &&
          stats.member_count === workspace.member_count &&
          stats.pending_invitations === workspace.invitation_count &&
          billable != null &&
          Number.isSafeInteger(billable) &&
          billable >= 0 &&
          billable <= used &&
          billable <= stats.member_count
        ) {
          setSeatSplit({ workspace, authGeneration, pending: used - billable });
        }
      },
      () => {}
    );
    return () => {
      current = false;
    };
  }, [workspace, authGeneration]);
  const pendingSeats =
    seatSplit?.workspace === workspace && seatSplit.authGeneration === authGeneration
      ? seatSplit.pending
      : 0;
  const [busy, setBusy] = useState<Busy | null>(null);
  const billingDisabled = busy !== null || authGeneration === null;
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);
  const [enterpriseWorkspaceId, setEnterpriseWorkspaceId] = useState<string | null>(null);
  const billingRequest = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    setInviteWorkspaceId(null);
    setEnterpriseWorkspaceId(null);
    setBusy(null);
    return () => {
      billingRequest.current = null;
    };
  }, [workspace.id, canManageBilling, authGeneration]);
  const [seatOpening, setSeatOpening] = useState<BillingIdentity | null>(null);
  const seatTrigger = useRef<HTMLElement | null>(null);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    refreshBillingSummary();
    void refresh({ fresh: true });
    window.dispatchEvent(new Event("usage-changed"));
    void onRefreshEntitlement?.();
  });
  const needsMembers = showsMembersCount(workspace);
  const needsInvitations = needsMembers && freeWorkspaceCta(workspace, null) === "pending";
  const { people, retry: retryPeople } = useWorkspacePeopleCount(
    workspace,
    needsMembers,
    needsInvitations
  );
  const freeCta = freeWorkspaceCta(workspace, people);

  function formatDate(iso: string): string {
    return formatBillingDate(iso, i18n.language);
  }

  function formatNumber(value: number): string {
    return value.toLocaleString(i18n.language);
  }

  async function openBilling(kind: Busy, getUrl: () => Promise<string>): Promise<void> {
    if (billingRequest.current) return;
    const generation = getValidatedAuthGeneration();
    if (generation === null) return;
    const request = Symbol();
    const isCurrent = (): boolean =>
      billingRequest.current === request && getValidatedAuthGeneration() === generation;
    billingRequest.current = request;
    setBusy(kind);
    try {
      const url = await getUrl();
      if (!isCurrent()) return;
      await openExternalUrl(url, t("settingsPage.account.checkout.couldNotOpenDescription"));
      if (isCurrent()) refreshOnReturn();
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: t("common.error"),
        description: billingErrorText(error),
        variant: "destructive",
      });
    } finally {
      if (billingRequest.current === request) {
        billingRequest.current = null;
        setBusy(null);
      }
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
      WorkspacesService.billingCheckout(workspace.id, yearly ? "annual" : "monthly", {
        tier: "business",
      })
    );
  }

  function renderInviteButton(variant: "primary" | "secondary"): React.ReactNode {
    return (
      <PillButton
        variant={variant}
        icon={UserPlus}
        disabled={billingDisabled}
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
        disabled={billingDisabled}
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

  const plan = workspacePlanState(workspace, people, Date.now(), summary);
  const canAddSeats = plan.usage.some((row) => row.kind === "seats" && row.addSeats);
  const showAddSeats =
    canAddSeats && isSameBillingIdentity(seatOpening, currentBillingIdentity(workspace.id));
  useLayoutEffect(() => {
    if (seatOpening && !showAddSeats) setSeatOpening(null);
  }, [seatOpening, showAddSeats]);
  const planName =
    plan.tier === "free"
      ? t("settingsPage.workspace.billing.planLabel.free")
      : WORKSPACE_PLAN_NAMES[plan.tier];

  function runAction(action: WorkspaceAction): void {
    switch (action.kind) {
      case "manageBilling":
      case "updatePayment":
      case "finishCheckout":
      case "keepPlan": {
        const identity = currentBillingIdentity(workspace.id);
        if (!canManageBilling || !identity) return;
        void openBilling(action.kind, () =>
          WorkspacesService.billingPortal(workspace.id, identity.authGeneration)
        );
        return;
      }
      case "resubscribe":
        if (workspace.stripe_subscription_id) {
          runAction({ kind: "manageBilling" });
          return;
        }
        void openBilling("resubscribe", () =>
          WorkspacesService.billingCheckout(workspace.id, yearly ? "annual" : "monthly", {
            tier: "business",
          })
        );
        return;
      case "openConsole":
        void openConsole();
        return;
      case "upgradeEnterprise":
        setEnterpriseWorkspaceId(workspace.id);
        return;
      case "addSeats": {
        const identity = currentBillingIdentity(workspace.id);
        if (identity && canAddSeats) setSeatOpening(identity);
        else
          toast({
            title: t("settingsPage.unifiedBilling.seatUpdateFailed"),
            variant: "destructive",
          });
        return;
      }
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
    return t(
      `${KEY_PREFIX}${key}`,
      translationParams(params?.plan ? { ...params, plan: planName } : params, formatDate)
    );
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
        disabled={action.kind === "viewPersonal" ? busy !== null : billingDisabled}
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
      case "invoice":
        return formatBillingInvoice(value, i18n.language);
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
        const pending =
          pendingSeats > 0 && row.total > 0
            ? {
                percent: (pendingSeats / row.total) * 100,
                label: `${t("settingsPage.billing.addSeats.pending")} · ${formatNumber(pendingSeats)}`,
                usedLabel: `${t("settingsPage.billing.addSeats.inUse")} · ${formatNumber(row.used - pendingSeats)}`,
              }
            : undefined;
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
            pending={pending}
            caption={row.captionKey ? translate(row.captionKey, row.params) : undefined}
            action={
              row.addSeats ? (
                <PillButton
                  variant="primary"
                  disabled={billingDisabled}
                  onClick={(event) => {
                    seatTrigger.current = event.currentTarget;
                    runAction({ kind: "addSeats" });
                  }}
                >
                  {t("settingsPage.billing.addSeats.title")}
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
      : { kind: "checkout", busy: busy === "checkout", disabled: billingDisabled };
  const gridEnterprise: EnterpriseCardAction = canSelfServeEnterprise(workspace)
    ? { kind: "checkout", disabled: billingDisabled }
    : { kind: "contactSales", ownerName: null };

  function runGridEnterprise(action: EnterpriseCardAction): void {
    if (action.kind === "checkout") setEnterpriseWorkspaceId(workspace.id);
    else if (action.kind === "contactSales") {
      openExternalUrl(
        CONTACT_SALES_URL,
        t("settingsPage.account.checkout.couldNotOpenDescription")
      ).catch((error: unknown) => {
        toast({
          title: t("common.error"),
          description: billingErrorText(error),
          variant: "destructive",
        });
      });
    }
  }

  const banner = plan.banner;
  const intervalLabel = plan.billingInterval ? translate(`interval.${plan.billingInterval}`) : null;
  const badge = plan.badge
    ? { label: translate(plan.badge.key, plan.badge.params), tone: plan.badge.tone }
    : intervalLabel
      ? { label: intervalLabel, tone: "info" as const }
      : undefined;
  const planLine = plan.seatPrice
    ? translate("planLine.seatPrice", {
        price: formatAmount(plan.seatPrice.amount, plan.seatPrice.currency),
      })
    : plan.planLine
      ? translate(plan.planLine.key, plan.planLine.params)
      : plan.badge && intervalLabel;
  // The View Personal plan button needs somewhere to go.
  const planActions = plan.planActions.filter(
    (action) => action.kind !== "viewPersonal" || onViewPersonal
  );

  return (
    <div className="flex flex-col gap-5">
      {authGeneration === null && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("settingsPage.account.offlineAccount.description")}
        </p>
      )}
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
              <PlanName icon={TIER_ICONS[plan.tier]} name={planName} badge={badge} />
              {planLine && (
                <p dir="auto" className="truncate text-xs text-muted-foreground">
                  {planLine}
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
            yearly={yearly}
            onYearlyChange={onYearlyChange}
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
            initialBillingInterval={yearly ? "annual" : "monthly"}
            onRefreshEntitlement={async () => {
              refreshBillingSummary();
              await onRefreshEntitlement?.();
            }}
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

      {showAddSeats && seatOpening && (
        <AddSeatsDialog
          key={billingTerms}
          workspace={workspace}
          planName={planName}
          identity={seatOpening}
          summary={summary}
          onClose={() => setSeatOpening(null)}
          restoreFocus={() => seatTrigger.current?.focus()}
          refreshWorkspace={() => refresh({ fresh: true })}
          refreshSummary={refreshBillingSummary}
        />
      )}
    </div>
  );
}
