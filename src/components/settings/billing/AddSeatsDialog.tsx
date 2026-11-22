import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudApiError } from "../../../services/cloudApi";
import { addSeatsState, LEGACY_WORKSPACE_SEAT_LIMIT } from "../../../lib/addSeatsState";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../../../lib/billingRequestIdentity";
import type { WorkspaceBillingSummary } from "../../../services/BillingSummaryService";
import { WorkspacesService, type SeatPreview } from "../../../services/WorkspacesService";
import type { Workspace } from "../../../types/electron";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { useToast } from "../../ui/useToast";
import { PillButton } from "./BillingUi";
import { formatBillingDate } from "./billingFormat";

const PREFIX = "settingsPage.billing.addSeats.";
const SURFACE = "overflow-hidden rounded-xl bg-surface-3";
const STEP_BUTTON =
  "h-7 w-8 rounded-full bg-surface-raised text-sm text-muted-foreground disabled:opacity-40";
const SEAT_PREVIEW_DEBOUNCE_MS = 300;

interface Props {
  workspace: Workspace;
  planName: string;
  identity: BillingIdentity;
  summary?: WorkspaceBillingSummary;
  onClose: () => void;
  restoreFocus: () => void;
  refreshWorkspace: () => Promise<void>;
  refreshSummary: () => void;
}

export function AddSeatsDialog({
  workspace,
  planName,
  identity,
  summary,
  onClose,
  restoreFocus,
  refreshWorkspace,
  refreshSummary,
}: Props): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const slider = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const version = useRef(0);
  const locked = useRef(false);
  const quantityChanged = useRef(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(1);
  // A lost response can follow a successful write. Every retry is bounded by the original total.
  const [retryTarget, setRetryTarget] = useState<number | null>(null);
  // A repeated 10 → 15 → 10 list snapshot is a new observation. Only the preview
  // requested against this observation can override its counts or authorize a purchase.
  const { seats, seats_used, seat_limit } = workspace;
  const interval = summary?.interval;
  const unitAmount = summary?.unit_amount;
  const currency = summary?.next_invoice?.currency;
  const cachedAtLimit = seats >= (seat_limit ?? LEGACY_WORKSPACE_SEAT_LIMIT);
  const seatSnapshot = useMemo(
    () => ({ seats, seats_used, seat_limit, interval, unitAmount, currency }),
    [seats, seats_used, seat_limit, interval, unitAmount, currency]
  );
  const [quote, setQuote] = useState<{
    version: number;
    delta: number;
    preview: SeatPreview;
    retryTarget: number | null;
    snapshot: typeof seatSnapshot;
  } | null>(null);
  const [fullSnapshot, setFullSnapshot] = useState<typeof seatSnapshot | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [adding, setAdding] = useState(false);
  const latestRefresh = useRef(refreshWorkspace);
  latestRefresh.current = refreshWorkspace;
  const baseline = quote?.snapshot === seatSnapshot ? quote : null;
  const purchased = baseline?.preview.current_quantity ?? seats;
  const model = addSeatsState({
    workspace: seatSnapshot,
    selectedDelta: retryTarget === null ? selected : Math.max(0, retryTarget - purchased),
    preview: baseline?.preview,
    summary,
  });
  const { delta, maxDelta } = model;
  // Read the smallest quote first so an already-applied increase near the ceiling can be observed.
  const probeCapacity =
    (retryTarget !== null && baseline?.retryTarget !== retryTarget) || (!baseline && cachedAtLimit);
  const previewDelta = probeCapacity ? 1 : delta;
  const currentPreview = baseline?.version === version.current && baseline.delta === delta;
  const fresh =
    currentPreview &&
    model.nextQuantity !== null &&
    (retryTarget === null || model.nextQuantity <= retryTarget);
  const priced = delta === 0 || fresh;
  const pending = delta > 0 && !currentPreview && !previewError;
  const quantityLocked = adding || (retryTarget !== null && !currentPreview);
  const workspaceId = workspace.id;

  function current(): boolean {
    return active.current && isSameBillingIdentity(identity, currentBillingIdentity(workspaceId));
  }

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (cachedAtLimit) void latestRefresh.current().catch(() => {});
  }, [cachedAtLimit]);

  useLayoutEffect(() => {
    if (retryTarget === null && maxDelta > 0) setSelected(delta);
  }, [retryTarget, maxDelta, delta]);

  useLayoutEffect(() => {
    const request = ++version.current;
    const valid = (): boolean =>
      active.current &&
      request === version.current &&
      isSameBillingIdentity(identity, currentBillingIdentity(workspaceId));
    setPreviewError(false);
    // A quantity the user is still choosing waits to settle. Every other quote goes out at once.
    const debounce = quantityChanged.current;
    quantityChanged.current = false;
    if (previewDelta <= 0 || locked.current) return;
    const send = (): void => {
      void WorkspacesService.previewSeats(workspaceId, previewDelta, identity.authGeneration).then(
        (preview) => {
          if (!valid()) return;
          if (preview.next_quantity !== preview.current_quantity + previewDelta) {
            setPreviewError(true);
            return;
          }
          setQuote({
            version: request,
            delta: previewDelta,
            preview,
            retryTarget,
            snapshot: seatSnapshot,
          });
        },
        (error: unknown) => {
          if (!valid()) return;
          // Both API versions return this exact refusal before pricing an over-limit change.
          // A one-seat probe proves the limit was reached, even if the DB mirror is still behind Stripe.
          if (
            previewDelta === 1 &&
            error instanceof CloudApiError &&
            error.status === 400 &&
            error.message === "Workspace seat limit exceeded"
          ) {
            setFullSnapshot(seatSnapshot);
            return;
          }
          setPreviewError(true);
          // Keep the recovery baseline so a failed remaining-seat quote waits for Retry.
          // A newer workspace snapshot will independently invalidate it.
          if (retryTarget === null) setQuote(null);
          void latestRefresh.current().catch(() => {});
        }
      );
    };
    if (debounce) {
      const timer = setTimeout(send, SEAT_PREVIEW_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }
    send();
  }, [previewDelta, retryTarget, revision, workspaceId, identity, seatSnapshot]);

  useLayoutEffect(() => {
    const atLimit = fullSnapshot === seatSnapshot;
    const reachedTarget =
      retryTarget !== null && purchased >= retryTarget && (!cachedAtLimit || baseline !== null);
    if (
      (!atLimit && !reachedTarget) ||
      locked.current ||
      !isSameBillingIdentity(identity, currentBillingIdentity(workspaceId))
    )
      return;
    locked.current = true;
    toast({
      title: atLimit
        ? t(PREFIX + "limitReached")
        : t(PREFIX + "success", { workspace: workspace.name, count: purchased }),
      variant: atLimit ? "default" : "success",
    });
    onClose();
    refreshSummary();
    void refreshWorkspace().catch(() => {});
  }, [
    fullSnapshot,
    seatSnapshot,
    cachedAtLimit,
    baseline,
    retryTarget,
    purchased,
    identity,
    workspaceId,
    workspace.name,
    toast,
    t,
    onClose,
    refreshSummary,
    refreshWorkspace,
  ]);

  function select(value: number): void {
    if (locked.current || quantityLocked || delta === value) return;
    setRetryTarget(null);
    ++version.current;
    quantityChanged.current = true;
    setSelected(value);
  }

  function retryPreview(): void {
    ++version.current;
    setRevision((previous) => previous + 1);
  }

  async function confirm(): Promise<void> {
    if (!current()) {
      onClose();
      return;
    }
    if (
      locked.current ||
      !fresh ||
      baseline.version !== version.current ||
      model.nextQuantity === null
    )
      return;
    locked.current = true;
    setAdding(true);
    let total: number;
    try {
      const result = await WorkspacesService.updateSeats(
        workspaceId,
        model.nextQuantity,
        identity.authGeneration
      );
      total = result.quantity;
    } catch (error) {
      if (!current()) return;
      const occupancyChanged =
        error instanceof CloudApiError && error.code === "seat_quantity_stale";
      if (!occupancyChanged) toast({ title: t(PREFIX + "failure"), variant: "destructive" });
      locked.current = false;
      setAdding(false);
      // Each interrupted write needs its own one-seat probe, including a second try
      // for the same total. Keep its observed capacity until that probe returns.
      setQuote((previous) => (previous ? { ...previous, retryTarget: null } : previous));
      setRetryTarget(occupancyChanged ? null : model.nextQuantity);
      retryPreview();
      return;
    }
    if (!current()) return;
    toast({
      title: t(PREFIX + "success", { workspace: workspace.name, count: total }),
      variant: "success",
    });
    onClose();
    refreshSummary();
    void refreshWorkspace().catch(() => {});
  }

  const ticks = [0, 5, 10, 15, 20].filter((tick) => tick < maxDelta).concat(maxDelta);
  const invoice = priced ? model.invoice : null;
  const priceRows = [
    {
      label: t(PREFIX + "price"),
      value:
        priced && model.unitPrice != null
          ? t(PREFIX + "perMonth", { price: model.unitPrice })
          : null,
    },
    { label: t(PREFIX + "proration"), value: priced ? model.proration : null },
    {
      label: invoice?.date
        ? t(PREFIX + "invoiceDate", { date: formatBillingDate(invoice.date, i18n.language) })
        : t("settingsPage.billing.personal.details.nextInvoice"),
      value: invoice?.amount,
    },
  ].filter((row) => row.value != null || pending);
  const confirmingLabel = adding
    ? t(PREFIX + "adding")
    : delta === 0
      ? t(PREFIX + "title")
      : t(PREFIX + "confirm", { count: delta });
  const notice = previewError
    ? t(PREFIX + "previewFailed")
    : model.occupancyMinimum !== null
      ? t(PREFIX + "occupancyMinimum", { minimum: model.occupancyMinimum })
      : maxDelta === 0 && baseline
        ? t(PREFIX + "limitReached")
        : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked.current) onClose();
      }}
    >
      <DialogContent
        hideCloseButton={adding}
        className="w-[calc(100%-2rem)] max-w-[440px] max-h-[90vh] overflow-y-auto gap-4 bg-surface-1 p-5 dark:bg-surface-1"
        onOpenAutoFocus={(event) => {
          if (slider.current && !slider.current.disabled) {
            event.preventDefault();
            slider.current.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-medium">{t(PREFIX + "title")}</DialogTitle>
          <DialogDescription className="text-xs">
            <bdi>{workspace.name}</bdi> · {planName}
          </DialogDescription>
        </DialogHeader>
        <section className={SURFACE + " p-3"}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <label htmlFor="billing-seats-delta" className="text-xs text-muted-foreground">
              {t(PREFIX + "quantity")}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={STEP_BUTTON}
                aria-label={t(PREFIX + "decrease")}
                disabled={quantityLocked || delta === 0}
                onClick={() => select(delta - 1)}
              >
                −
              </button>
              <output className="min-w-6 text-center font-medium tabular-nums">{delta}</output>
              <button
                type="button"
                className={STEP_BUTTON}
                aria-label={t(PREFIX + "increase")}
                disabled={quantityLocked || delta === maxDelta}
                onClick={() => select(delta + 1)}
              >
                +
              </button>
            </div>
          </div>
          <div className="relative flex h-6 items-center">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-surface-1 forced-colors:hidden"
            >
              <span
                className="absolute inset-y-0 start-0 rounded-full bg-primary"
                style={{ width: `${maxDelta ? (delta / maxDelta) * 100 : 0}%` }}
              />
              <div className="absolute inset-x-2 inset-y-0">
                {ticks
                  .filter((tick) => tick > 0 && tick < maxDelta)
                  .map((tick) => (
                    <span
                      key={tick}
                      className="absolute top-1/2 size-0.5 -translate-y-1/2 rounded-full bg-muted-foreground"
                      style={{ insetInlineStart: `${(tick / maxDelta) * 100}%` }}
                    />
                  ))}
              </div>
            </div>
            <input
              id="billing-seats-delta"
              ref={slider}
              type="range"
              min={0}
              max={maxDelta}
              step={1}
              value={delta}
              disabled={quantityLocked || maxDelta === 0}
              onChange={(event) => select(event.currentTarget.valueAsNumber)}
              className="input-inline billing-seat-range relative h-full w-full rounded-full accent-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
          </div>
          <div aria-hidden="true" className="relative mx-2 h-4 text-xs text-muted-foreground">
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute -translate-x-1/2 rtl:translate-x-1/2"
                style={{ insetInlineStart: `${maxDelta ? (tick / maxDelta) * 100 : 0}%` }}
              >
                {tick}
              </span>
            ))}
          </div>
        </section>
        <div className={SURFACE}>
          <table className="w-full border-collapse text-sm text-muted-foreground tabular-nums">
            <thead>
              <tr className="h-9 border-b border-border-subtle text-xs [&>th]:font-medium">
                <td />
                <th scope="col" className="text-end">
                  {t(PREFIX + "now")}
                </th>
                <th scope="col" className="pe-3.5 text-end">
                  {t(PREFIX + "after")}
                </th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.kind} className="h-11 border-b border-border-subtle last:border-0">
                  <th scope="row" className="ps-3.5 text-start text-xs font-normal">
                    {t(PREFIX + row.kind)}
                  </th>
                  <td className="text-end">{row.now}</td>
                  <td
                    className={
                      row.after !== row.now
                        ? "pe-3.5 text-end font-semibold text-foreground"
                        : "pe-3.5 text-end"
                    }
                  >
                    {row.after}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {priceRows.length > 0 && (
          <dl
            aria-busy={pending || undefined}
            className={SURFACE + " divide-y divide-border-subtle text-sm"}
          >
            {priceRows.map(({ label, value }) => (
              <div
                key={label}
                className="flex min-h-11 items-center justify-between gap-2 px-3.5 py-2"
              >
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-end">
                  <bdi>{value ?? "—"}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div role="status" aria-live="polite" className={notice ? "text-sm" : "sr-only"}>
          {adding ? t(PREFIX + "adding") : notice || (pending ? t("common.loading") : "")}
        </div>
        <DialogFooter>
          {previewError && (
            <PillButton variant="secondary" onClick={retryPreview}>
              {t("common.retry")}
            </PillButton>
          )}
          <PillButton variant="secondary" disabled={adding} onClick={onClose}>
            {t("common.cancel")}
          </PillButton>
          <PillButton
            variant="primary"
            busy={adding}
            disabled={!fresh}
            onClick={() => void confirm()}
          >
            {confirmingLabel}
          </PillButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
