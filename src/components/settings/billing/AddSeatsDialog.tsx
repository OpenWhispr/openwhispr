import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { addSeatsState } from "../../../lib/addSeatsState";
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
const SURFACE = "rounded-xl bg-surface-3 p-3";
const STEP_BUTTON = "size-8 rounded-lg border border-border bg-card text-lg disabled:opacity-40";

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
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(1);
  // A repeated 10 → 15 → 10 list snapshot is a new observation. Only the preview
  // requested against this observation can override its counts or authorize a purchase.
  const { seats, seats_used, seat_limit } = workspace;
  const seatSnapshot = useMemo(
    () => ({ seats, seats_used, seat_limit }),
    [seats, seats_used, seat_limit]
  );
  const [quote, setQuote] = useState<{
    version: number;
    delta: number;
    preview: SeatPreview;
    snapshot: typeof seatSnapshot;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [adding, setAdding] = useState(false);
  const latestRefresh = useRef(refreshWorkspace);
  latestRefresh.current = refreshWorkspace;
  const baseline = quote?.snapshot === seatSnapshot ? quote : null;
  const model = addSeatsState({
    workspace: seatSnapshot,
    selectedDelta: selected,
    preview: baseline?.preview,
    summary,
  });
  const { delta, maxDelta } = model;
  const fresh =
    baseline?.version === version.current &&
    baseline.delta === delta &&
    model.nextQuantity !== null;
  const priced = delta === 0 || fresh;
  const pending = delta > 0 && !fresh && !previewError;
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
    const request = ++version.current;
    const valid = (): boolean =>
      active.current &&
      request === version.current &&
      isSameBillingIdentity(identity, currentBillingIdentity(workspaceId));
    setPreviewError(false);
    setSelected(delta);
    if (delta > 0 && !locked.current) {
      void WorkspacesService.previewSeats(workspaceId, delta, identity.authGeneration).then(
        (preview) => {
          if (!valid()) return;
          setQuote({ version: request, delta, preview, snapshot: seatSnapshot });
          if (preview.next_quantity !== preview.current_quantity + delta) setPreviewError(true);
        },
        () => {
          if (!valid()) return;
          setPreviewError(true);
          // A fresh list can lower the seat ceiling after a rejected preview.
          setQuote(null);
          void latestRefresh.current().catch(() => {});
        }
      );
    }
  }, [delta, revision, workspaceId, identity, seatSnapshot]);

  function select(value: number): void {
    if (locked.current || delta === value) return;
    ++version.current;
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
    } catch {
      if (!current()) return;
      toast({ title: t(PREFIX + "failure"), variant: "destructive" });
      locked.current = false;
      setAdding(false);
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
          <DialogTitle>{t(PREFIX + "title")}</DialogTitle>
          <DialogDescription>
            <bdi>{workspace.name}</bdi> · {planName}
          </DialogDescription>
        </DialogHeader>
        <section className={SURFACE}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <label htmlFor="billing-seats-delta" className="text-sm font-medium">
              {t(PREFIX + "quantity")}
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={STEP_BUTTON}
                aria-label={t(PREFIX + "decrease")}
                disabled={adding || delta === 0}
                onClick={() => select(delta - 1)}
              >
                −
              </button>
              <output className="min-w-6 text-center font-medium tabular-nums">{delta}</output>
              <button
                type="button"
                className={STEP_BUTTON}
                aria-label={t(PREFIX + "increase")}
                disabled={adding || delta === maxDelta}
                onClick={() => select(delta + 1)}
              >
                +
              </button>
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
            disabled={adding || maxDelta === 0}
            onChange={(event) => select(event.currentTarget.valueAsNumber)}
            className="w-full accent-primary"
          />
          <div aria-hidden="true" className="relative h-4 text-xs text-muted-foreground">
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute"
                style={{
                  insetInlineStart: `clamp(0px, ${maxDelta ? (tick / maxDelta) * 100 : 0}%, calc(100% - 2ch))`,
                }}
              >
                {tick}
              </span>
            ))}
          </div>
        </section>
        <div className={SURFACE}>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                <td />
                <th scope="col" className="text-end">
                  {t(PREFIX + "now")}
                </th>
                <th scope="col" className="text-end">
                  {t(PREFIX + "after")}
                </th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.kind}>
                  <th scope="row" className="py-1 text-start font-normal">
                    {t(PREFIX + row.kind)}
                  </th>
                  <td className="text-end">{row.now}</td>
                  <td className="text-end">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {priceRows.length > 0 && (
          <dl
            aria-busy={pending || undefined}
            className={SURFACE + " grid grid-cols-[1fr_auto] gap-2 text-sm"}
          >
            {priceRows.map(({ label, value }) => (
              <React.Fragment key={label}>
                <dt>{label}</dt>
                <dd className="text-end">
                  <bdi>{value ?? "—"}</bdi>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        <div role="status" aria-live="polite" className={previewError ? "text-sm" : "sr-only"}>
          {adding
            ? t(PREFIX + "adding")
            : previewError
              ? t(PREFIX + "previewFailed")
              : pending
                ? t("common.loading")
                : ""}
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
