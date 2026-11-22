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
  EnterpriseTileAction,
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

/** The personal tile's actions, plus a workspace view's own Business checkout. */
export type BusinessCardAction =
  BusinessTileAction | { kind: "checkout"; busy: boolean; disabled: boolean };

/** The personal tile's actions, plus a workspace view's own Enterprise purchase dialog. */
export type EnterpriseCardAction = EnterpriseTileAction | { kind: "checkout"; disabled: boolean };

export type PlanCardId = "pro" | "business" | "enterprise";

// Signed out, both sign-up buttons (Pro's and Business's) lead to onSignIn, so it is required then.
type PlansGridAuth =
  { isSignedIn: true; onSignIn?: () => void } | { isSignedIn: false; onSignIn: () => void };

type PlansGridCards =
  | {
      cards?: PlanCardId[];
      pro: ProCardAction;
    }
  | {
      cards: Array<Exclude<PlanCardId, "pro">>;
      pro?: undefined;
    };

type PlansGridProps = PlansGridAuth &
  PlansGridCards & {
    yearly: boolean;
    onYearlyChange: (yearly: boolean) => void;
    business: BusinessCardAction;
    businessDowngrade: WorkspacePlanAction | null;
    onBusinessAction: (action: BusinessCardAction) => void;
    enterprise: {
      action: EnterpriseCardAction;
      manage: WorkspacePlanAction | null;
      entitled: boolean;
    };
    onEnterprise: (action: EnterpriseCardAction) => void;
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

const ALL_CARDS: PlanCardId[] = ["pro", "business", "enterprise"];
const CONTACT_SALES: EnterpriseCardAction = { kind: "contactSales", ownerName: null };
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
  cards = ALL_CARDS,
  yearly = false,
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
  const shown = new Set<PlanCardId>(cards);
  const showsPro = shown.has("pro") && pro !== undefined;

  const proPrice = yearly
    ? t(`${PLANS}.pricePerMonthYearly`, { price: t(`${PRICING}.pro.annualEquivalent`) })
    : t(`${PLANS}.pricePerMonth`, { price: t(`${PRICING}.pro.monthlyPrice`) });
  const businessPrice = yearly
    ? t(`${PLANS}.pricePerSeatYearly`, { price: t(`${PRICING}.business.annualEquivalent`) })
    : t(`${PLANS}.pricePerSeat`, { price: t(`${PRICING}.business.monthlyPrice`) });

  const proActions = !pro ? null : pro.kind === "subscribe" ? (
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
      {business.kind === "checkout" ? (
        // Secondary in a workspace view: the card's own Upgrade to Business is the primary.
        <PillButton
          variant="secondary"
          busy={business.busy}
          disabled={business.disabled}
          onClick={() => onBusinessAction(business)}
          className={CARD_BUTTON}
        >
          {t("settingsPage.billing.free.upgradeToBusiness")}
        </PillButton>
      ) : business.kind === "workspacePlan" ? (
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

  const contactSalesButton = (action: EnterpriseCardAction): ReactElement => (
    <PillButton
      variant="secondary"
      icon={Mail}
      onClick={() => onEnterprise(action)}
      className={CARD_BUTTON}
    >
      {t(`${PRICING}.enterprise.cta`)}
    </PillButton>
  );

  // Purchases are sales-assisted too, so a quieter contact link sits under the button.
  const purchaseButton = (action: EnterpriseCardAction, label: string): ReactElement => (
    <>
      <PillButton
        variant="secondary"
        disabled={action.kind === "checkout" && action.disabled}
        onClick={() => onEnterprise(action)}
        className={CARD_BUTTON}
      >
        {label}
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
  );

  const enterpriseAction = enterprise.action;
  const showsWorkspacePlan = enterprise.entitled || enterpriseAction.kind === "workspacePlan";
  const enterpriseActions = !isSignedIn ? (
    contactSalesButton(CONTACT_SALES)
  ) : (
    <>
      {showsWorkspacePlan && (
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
      {enterpriseAction.kind === "viewWorkspace" ? (
        purchaseButton(enterpriseAction, t("settingsPage.billing.tiles.upgradeWorkspace"))
      ) : enterpriseAction.kind === "checkout" ? (
        purchaseButton(enterpriseAction, t(`${PRICING}.enterprise.upgradeCta`))
      ) : enterpriseAction.kind === "contactSales" && !showsWorkspacePlan ? (
        <>
          {contactSalesButton(enterpriseAction)}
          {enterpriseAction.ownerName && (
            <p dir="auto" className="text-center text-xs text-muted-foreground">
              {t(`${PRICING}.enterprise.askOwner`, { name: enterpriseAction.ownerName })}
            </p>
          )}
        </>
      ) : null}
    </>
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium text-foreground">{t(`${PRICING}.title`)}</h3>
        {onYearlyChange && (
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
        )}
      </div>
      <div className={cn("grid gap-3", columns === 2 ? "grid-cols-2" : "grid-cols-3")}>
        {showsPro && (
          <PlanCard
            plan="pro"
            icon={Zap}
            name={t(`${PRICING}.pro.name`)}
            price={proPrice}
            actions={proActions}
            includes={t(`${PLANS}.pro.includes`)}
            features={PRO_FEATURES}
          />
        )}
        {shown.has("business") && (
          <PlanCard
            plan="business"
            icon={Building2}
            name={t(`${PRICING}.business.name`)}
            price={businessPrice}
            actions={businessActions}
            includes={t(`${PLANS}.business.includes`)}
            features={BUSINESS_FEATURES}
          />
        )}
        {shown.has("enterprise") && (
          <PlanCard
            plan="enterprise"
            icon={Shield}
            name={t(`${PRICING}.enterprise.name`)}
            price={t(`${PRICING}.enterprise.price`)}
            actions={enterpriseActions}
            includes={t(`${PLANS}.enterprise.includes`)}
            features={ENTERPRISE_FEATURES}
          />
        )}
      </div>
    </section>
  );
}
