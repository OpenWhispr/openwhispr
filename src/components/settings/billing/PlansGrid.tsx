import type { ComponentType, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  AudioLines,
  Brain,
  Building2,
  Code2,
  Key,
  Link2,
  Mail,
  MessageCircle,
  MessageSquare,
  MonitorSmartphone,
  Shield,
  ShieldCheck,
  Sliders,
  Users,
  Zap,
} from "../../icons";
import { Toggle } from "../../ui/toggle";
import { WorkspacePlanActionButton } from "../WorkspacePlanActionButton";
import type {
  BusinessTileAction,
  EnterpriseTileCta,
  WorkspacePlanAction,
} from "../../../lib/workspaceBilling";
import { PillButton, PlanName } from "./BillingUi";

type IconComponent = ComponentType<{ className?: string }>;

export type ProCardAction =
  | { kind: "subscribe"; busy: boolean; onClick: () => void }
  | { kind: "downgrade"; busy: boolean; onClick: () => void }
  | { kind: "current" }
  | { kind: "covered" }
  | { kind: "signIn" }
  | { kind: "none" };

// Signed out, both sign-up buttons (Pro's and Business's) lead to onSignIn, so it is required then.
type PlansGridAuth =
  { isSignedIn: true; onSignIn?: () => void } | { isSignedIn: false; onSignIn: () => void };

type PlansGridProps = PlansGridAuth & {
  yearly: boolean;
  onYearlyChange: (yearly: boolean) => void;
  pro: ProCardAction;
  business: BusinessTileAction;
  businessDowngrade: WorkspacePlanAction | null;
  onBusinessAction: (action: BusinessTileAction) => void;
  enterprise: { cta: EnterpriseTileCta; manage: WorkspacePlanAction | null; entitled: boolean };
  onEnterprise: (cta: EnterpriseTileCta) => void;
  onRefreshEntitlement?: () => Promise<void>;
  columns?: 2 | 3;
};

interface Feature {
  icon: IconComponent;
  key: string;
}

const PLANS = "settingsPage.billing.plans";
const PRICING = "settingsPage.account.pricing";

// Only limits the product enforces: no meeting-hour figures, since nothing meters them.
const PRO_FEATURES: Feature[] = [
  { icon: AudioLines, key: `${PLANS}.pro.features.unlimitedCloud` },
  { icon: MonitorSmartphone, key: `${PLANS}.pro.features.syncDevices` },
  { icon: Link2, key: `${PLANS}.pro.features.publicLinks` },
  { icon: Code2, key: `${PLANS}.pro.features.apiMcp` },
  { icon: MonitorSmartphone, key: `${PLANS}.pro.features.mobileApp` },
];

const BUSINESS_FEATURES: Feature[] = [
  { icon: Users, key: `${PLANS}.business.features.workspaceRoles` },
  { icon: Brain, key: `${PLANS}.business.features.assistantMode` },
  { icon: MessageSquare, key: `${PLANS}.business.features.chatOverData` },
  { icon: MessageCircle, key: `${PLANS}.business.features.prioritySupport` },
];

const ENTERPRISE_FEATURES: Feature[] = [
  { icon: Key, key: `${PLANS}.enterprise.features.managedCredits` },
  { icon: ShieldCheck, key: `${PLANS}.enterprise.features.ssoCompliance` },
  { icon: Sliders, key: `${PLANS}.enterprise.features.adminControls` },
  { icon: MessageCircle, key: `${PLANS}.enterprise.features.dedicatedSupport` },
];

const CONTACT_SALES: EnterpriseTileCta = { action: "contactSales", ownerName: null };
const CARD_BUTTON = "h-8 w-full py-0";
// WorkspacePlanActionButton is a ui Button; these turn it into the secondary pill.
const WORKSPACE_ACTION_PILL =
  "h-8 w-full bg-surface-3 px-4 text-xs font-medium text-muted-foreground hover:bg-surface-3 hover:text-foreground dark:text-muted-foreground dark:hover:bg-surface-3";

function PlanCard({
  plan,
  icon,
  name,
  price,
  actions,
  includes,
  features,
}: {
  plan: "pro" | "business" | "enterprise";
  icon: IconComponent;
  name: string;
  price: string;
  actions: ReactNode;
  includes: string;
  features: Feature[];
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div data-plan={plan} className="flex min-w-0 flex-col gap-3 rounded-[10px] bg-surface-1 p-4">
      <div className="flex flex-col gap-1">
        <PlanName icon={icon} name={name} />
        <p dir="auto" className="text-xs text-foreground">
          {price}
        </p>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-border pb-3">{actions}</div>
      <div className="flex flex-col gap-2">
        <p dir="auto" className="text-xs text-muted-foreground/70">
          {includes}
        </p>
        <ul className="flex flex-col gap-2">
          {features.map(({ icon: FeatureIcon, key }) => (
            <li key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
              <FeatureIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span dir="auto">{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PlanLabel({ children }: { children: string }): ReactElement {
  return (
    <p dir="auto" className="flex h-8 items-center justify-center text-xs font-medium text-primary">
      {children}
    </p>
  );
}

export function PlansGrid({
  isSignedIn,
  onSignIn,
  yearly,
  onYearlyChange,
  pro,
  business,
  businessDowngrade,
  onBusinessAction,
  enterprise,
  onEnterprise,
  onRefreshEntitlement,
  columns = 3,
}: PlansGridProps): ReactElement {
  const { t } = useTranslation();

  const proPrice = yearly
    ? t(`${PLANS}.pricePerMonthYearly`, { price: t(`${PRICING}.pro.annualEquivalent`) })
    : t(`${PLANS}.pricePerMonth`, { price: t(`${PRICING}.pro.monthlyPrice`) });
  const businessPrice = yearly
    ? t(`${PLANS}.pricePerSeatYearly`, { price: t(`${PRICING}.business.annualEquivalent`) })
    : t(`${PLANS}.pricePerSeat`, { price: t(`${PRICING}.business.monthlyPrice`) });

  const proActions =
    pro.kind === "subscribe" ? (
      <PillButton variant="primary" busy={pro.busy} onClick={pro.onClick} className={CARD_BUTTON}>
        {t("settingsPage.account.checkout.upgradeToPro")}
      </PillButton>
    ) : pro.kind === "downgrade" ? (
      <PillButton variant="secondary" busy={pro.busy} onClick={pro.onClick} className={CARD_BUTTON}>
        {t(`${PRICING}.downgrade`)}
      </PillButton>
    ) : pro.kind === "signIn" ? (
      onSignIn && (
        <PillButton variant="primary" onClick={onSignIn} className={CARD_BUTTON}>
          {t("common.signIn")}
        </PillButton>
      )
    ) : pro.kind === "current" ? (
      <PlanLabel>{t(`${PLANS}.yourPlan`)}</PlanLabel>
    ) : pro.kind === "covered" ? (
      <PlanLabel>{t(`${PRICING}.coveredByWorkspace`)}</PlanLabel>
    ) : null;

  const businessActions = !isSignedIn ? (
    onSignIn && (
      <PillButton variant="secondary" onClick={onSignIn} className={CARD_BUTTON}>
        {t(`${PRICING}.business.cta`)}
      </PillButton>
    )
  ) : (
    <>
      {business.kind === "workspacePlan" ? (
        <PlanLabel>{t(`${PRICING}.yourWorkspacePlan`)}</PlanLabel>
      ) : business.kind === "viewWorkspace" ? (
        <PillButton
          variant="secondary"
          onClick={() => onBusinessAction(business)}
          className={CARD_BUTTON}
        >
          {t("settingsPage.billing.tiles.upgradeWorkspace")}
        </PillButton>
      ) : business.kind === "createWorkspace" ? (
        <PillButton
          variant="secondary"
          onClick={() => onBusinessAction(business)}
          className={CARD_BUTTON}
        >
          {t("settingsPage.billing.tiles.createWorkspace")}
        </PillButton>
      ) : null}
      {businessDowngrade && (
        <WorkspacePlanActionButton
          action={businessDowngrade}
          onRefreshEntitlement={onRefreshEntitlement}
          variant="ghost"
          className={WORKSPACE_ACTION_PILL}
          spinnerClassName="size-3.5"
          label={
            businessDowngrade.kind === "contactSales"
              ? t(`${PRICING}.enterprise.cta`)
              : t(`${PRICING}.downgrade`)
          }
        />
      )}
    </>
  );

  const contactSalesButton = (cta: EnterpriseTileCta): ReactElement => (
    <PillButton
      variant="secondary"
      icon={Mail}
      onClick={() => onEnterprise(cta)}
      className={CARD_BUTTON}
    >
      {t(`${PRICING}.enterprise.cta`)}
    </PillButton>
  );

  const enterpriseCta = enterprise.cta;
  const enterpriseActions = !isSignedIn ? (
    contactSalesButton(CONTACT_SALES)
  ) : (
    <>
      {enterprise.entitled && (
        <>
          <PlanLabel>{t(`${PRICING}.yourWorkspacePlan`)}</PlanLabel>
          {enterprise.manage && (
            <WorkspacePlanActionButton
              action={enterprise.manage}
              onRefreshEntitlement={onRefreshEntitlement}
              variant="ghost"
              className={WORKSPACE_ACTION_PILL}
              spinnerClassName="size-3.5"
              label={t(`${PRICING}.manage`)}
            />
          )}
        </>
      )}
      {/* Another workspace can still be upgraded alongside the current plan. */}
      {enterpriseCta.action !== "contactSales" ? (
        <>
          <PillButton
            variant="secondary"
            onClick={() => onEnterprise(enterpriseCta)}
            className={CARD_BUTTON}
          >
            {t(`${PRICING}.enterprise.upgradeCta`)}
          </PillButton>
          <button
            type="button"
            onClick={() => onEnterprise(CONTACT_SALES)}
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Mail aria-hidden="true" className="size-3.5" />
            {t(`${PRICING}.enterprise.cta`)}
          </button>
        </>
      ) : enterprise.entitled ? null : (
        <>
          {contactSalesButton(enterpriseCta)}
          {enterpriseCta.ownerName && (
            <p dir="auto" className="text-center text-xs text-muted-foreground">
              {t(`${PRICING}.enterprise.askOwner`, { name: enterpriseCta.ownerName })}
            </p>
          )}
        </>
      )}
    </>
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">{t(`${PRICING}.title`)}</h3>
        <label className="flex cursor-pointer items-center gap-2">
          <span dir="auto" className="text-xs text-muted-foreground">
            {t(`${PRICING}.billedYearly`)}
          </span>
          <Toggle
            checked={yearly}
            onChange={onYearlyChange}
            ariaLabel={t(`${PRICING}.billedYearly`)}
          />
        </label>
      </div>
      <div className={cn("grid gap-3", columns === 2 ? "grid-cols-2" : "grid-cols-3")}>
        <PlanCard
          plan="pro"
          icon={Zap}
          name={t(`${PRICING}.pro.name`)}
          price={proPrice}
          actions={proActions}
          includes={t(`${PLANS}.pro.includes`)}
          features={PRO_FEATURES}
        />
        <PlanCard
          plan="business"
          icon={Building2}
          name={t(`${PRICING}.business.name`)}
          price={businessPrice}
          actions={businessActions}
          includes={t(`${PLANS}.business.includes`)}
          features={BUSINESS_FEATURES}
        />
        <PlanCard
          plan="enterprise"
          icon={Shield}
          name={t(`${PRICING}.enterprise.name`)}
          price={t(`${PRICING}.enterprise.price`)}
          actions={enterpriseActions}
          includes={t(`${PLANS}.enterprise.includes`)}
          features={ENTERPRISE_FEATURES}
        />
      </div>
    </section>
  );
}
