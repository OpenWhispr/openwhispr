import type { ComponentType, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2, CreditCard, User, Zap } from "../../icons";
import { Skeleton } from "../../ui/skeleton";
import type {
  PersonalAction,
  PersonalBanner,
  PersonalDetail,
  PersonalPlanState,
  PersonalTier,
  PersonalUsageRow,
} from "../../../lib/personalPlanState";
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
} from "./BillingUi";
import { formatBillingInvoice, translationParams } from "./billingFormat";
import { isPortalAction } from "./personalGridHandlers";

interface PersonalPlanViewProps {
  state: PersonalPlanState;
  onAction: (action: PersonalAction) => void;
  busyAction: PersonalAction["kind"] | null;
  creatorLink: ReactNode;
  grid: ReactNode;
  formatDate: (iso: string) => string;
}

const P = "settingsPage.billing.personal";

const TIER_ICONS: Record<PersonalTier, ComponentType<{ className?: string }>> = {
  free: User,
  pro: Zap,
  business: Building2,
};

type Translate = ReturnType<typeof useTranslation>["t"];

function actionLabel(t: Translate, action: PersonalAction): string {
  switch (action.kind) {
    case "manageInStore":
      return action.store === "play_store"
        ? t("settingsPage.account.billing.manageInGooglePlay")
        : t("settingsPage.account.billing.manageInAppStore");
    case "keepPlan":
      return t(`${P}.actions.keepPlan`, { plan: action.plan });
    case "signIn":
      return t("common.signIn");
    case "retry":
      return t("common.retry");
    case "business":
      return action.action.kind === "viewWorkspace"
        ? t("settingsPage.billing.tiles.upgradeWorkspace")
        : t("settingsPage.billing.tiles.createWorkspace");
    default:
      return t(`${P}.actions.${action.kind}`);
  }
}

function CurrentPlanMessage({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: ReactNode;
}): ReactElement {
  return (
    <BillingBox>
      <BillingRow>
        <div className="flex min-w-0 flex-col gap-1">
          <p dir="auto" className="text-base font-medium text-foreground">
            {title}
          </p>
          <p dir="auto" className="text-xs text-muted-foreground">
            {body}
          </p>
        </div>
        {action}
      </BillingRow>
    </BillingBox>
  );
}

function SkeletonBox({ rows }: { rows: number }): ReactElement {
  return (
    <BillingBox>
      {Array.from({ length: rows }, (_, index) => (
        <BillingRow key={index}>
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
        </BillingRow>
      ))}
    </BillingBox>
  );
}

export function PersonalPlanView({
  state,
  onAction,
  busyAction,
  creatorLink,
  grid,
  formatDate,
}: PersonalPlanViewProps): ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const formatNumber = (value: number): string => value.toLocaleString(language);
  const currentPlanTitle = t(`${P}.blocks.currentPlan`);
  // The card and a banner can both show a portal button; they share one request.
  const portalOpening = isPortalAction(busyAction);

  const planOptions = (
    <div className="flex flex-col gap-3 empty:hidden">
      {creatorLink}
      {(state.kind !== "ready" || state.showPlansGrid) && grid}
    </div>
  );

  const actionButton = (action: PersonalAction, primary = false): ReactElement => (
    <PillButton
      key={action.kind === "business" ? `business-${action.action.kind}` : action.kind}
      variant={primary ? "primary" : "secondary"}
      icon={action.kind === "manageBilling" ? CreditCard : undefined}
      busy={busyAction === action.kind}
      disabled={portalOpening && isPortalAction(action.kind)}
      onClick={() => onAction(action)}
    >
      {actionLabel(t, action)}
    </PillButton>
  );

  if (state.kind === "signedOut") {
    return (
      <div className="flex flex-col gap-5">
        <BillingBlock title={currentPlanTitle}>
          <CurrentPlanMessage
            title={t(`${P}.signedOut.title`)}
            body={t(`${P}.signedOut.body`)}
            action={actionButton({ kind: "signIn" })}
          />
        </BillingBlock>
        {planOptions}
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="flex flex-col gap-5">
        <BillingBlock title={currentPlanTitle}>
          <CurrentPlanMessage
            title={t(`${P}.failed.title`)}
            body={t(`${P}.failed.body`)}
            action={actionButton({ kind: "retry" })}
          />
        </BillingBlock>
        {planOptions}
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-5">
        {/* Busy on the skeletons only: the grid below is already usable. */}
        <div aria-busy="true">
          <div aria-hidden="true" className="flex flex-col gap-5">
            <BillingBlock title={currentPlanTitle}>
              <SkeletonBox rows={1} />
            </BillingBlock>
            <BillingBlock title={t(`${P}.blocks.usage`)}>
              <SkeletonBox rows={1} />
            </BillingBlock>
            <BillingBlock title={t(`${P}.blocks.billingDetails`)}>
              <SkeletonBox rows={2} />
            </BillingBlock>
          </div>
        </div>
        {planOptions}
      </div>
    );
  }

  const usageRow = (row: PersonalUsageRow, index: number): ReactElement | null => {
    const label = t(`${P}.usage.cloudTranscription`);
    if (row.kind === "unlimited") {
      return <UsageValueRow key={index} label={label} value={t(`${P}.usage.unlimited`)} />;
    }
    // Older APIs report no limit; a meter against 0 would mean nothing.
    if (row.limit <= 0) return null;
    const caption =
      row.tone === "destructive"
        ? t(`${P}.usage.limitReached`)
        : row.tone === "warning"
          ? t(`${P}.usage.wordsLeft`, { remaining: formatNumber(row.remaining) })
          : t(`${P}.usage.rolling`);
    return (
      <UsageMeterRow
        key={index}
        label={label}
        value={t(`${P}.usage.wordsValue`, {
          used: formatNumber(row.used),
          limit: formatNumber(row.limit),
        })}
        percent={(row.used / row.limit) * 100}
        caption={caption}
        tone={row.tone}
      />
    );
  };

  const detailValue = (detail: PersonalDetail): string => {
    if (detail.value.kind === "date") return formatDate(detail.value.iso);
    if (detail.value.kind === "invoice") return formatBillingInvoice(detail.value, language);
    if (detail.value.kind === "text") return detail.value.text;
    if (detail.value.store === "app_store") return t(`${P}.stores.appStore`);
    if (detail.value.store === "play_store") return t(`${P}.stores.playStore`);
    return t(`${P}.stores.unknown`);
  };

  const usageRows = state.usage.map(usageRow).filter((row) => row !== null);
  const [firstAction, ...otherActions] = state.actions;

  return (
    <div className="flex flex-col gap-5">
      {state.banners.map((banner) => {
        const params = translationParams(banner.params, formatDate);
        return (
          <BillingBanner
            key={banner.id}
            tone={banner.tone}
            title={t(`${P}.${banner.titleKey}`, params)}
            body={banner.bodyKey ? t(`${P}.${banner.bodyKey}`, params) : undefined}
            action={banner.action && actionButton(banner.action)}
          />
        );
      })}

      <BillingBlock title={currentPlanTitle}>
        <BillingBox>
          <BillingRow>
            <div className="flex min-w-0 flex-col gap-1">
              <PlanName
                icon={state.tier ? TIER_ICONS[state.tier] : User}
                name={
                  state.tier
                    ? t(`settingsPage.account.planLabels.${state.tier}`)
                    : t("settingsPage.billing.picker.personal")
                }
                badge={
                  state.badge
                    ? {
                        label: t(
                          `${P}.${state.badge.key}`,
                          translationParams(state.badge.params, formatDate)
                        ),
                        tone: state.badge.tone,
                      }
                    : undefined
                }
              />
              {state.price && (
                <p dir="auto" className="text-xs text-muted-foreground">
                  {t(`${P}.${state.price.key}`, translationParams(state.price.params, formatDate))}
                </p>
              )}
            </div>
            {firstAction && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {actionButton(firstAction, firstAction.kind === "subscribePro")}
                {otherActions.map((action) => actionButton(action))}
              </div>
            )}
          </BillingRow>
        </BillingBox>
      </BillingBlock>

      {usageRows.length > 0 && (
        <BillingBlock title={t(`${P}.blocks.usage`)}>
          <BillingBox>{usageRows}</BillingBox>
        </BillingBlock>
      )}

      {state.details.length > 0 && (
        <BillingBlock title={t(`${P}.blocks.billingDetails`)}>
          <BillingBox padded="details">
            <DetailRows
              rows={state.details.map((detail) => ({
                label: t(`${P}.${detail.labelKey}`),
                value: detailValue(detail),
              }))}
            />
          </BillingBox>
        </BillingBlock>
      )}

      {planOptions}
    </div>
  );
}
