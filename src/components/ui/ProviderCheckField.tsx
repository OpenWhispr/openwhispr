import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectionAutoCheck,
  ProviderConnectionResult,
} from "../../hooks/useConnectionAutoCheck";
import { isWindowSwitchBlur } from "../../hooks/useFocusHold";
import { maskKey } from "../../utils/maskKey";
import { cn } from "../lib/utils";
import { ConnectionStatusIcon } from "./ConnectionStatusIcon";
import { Input } from "./input";

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-xs text-[var(--onboarding-text-tertiary)]">{children}</span>
  );
}

// Onboarding's provider field, wherever it is used. Outside onboarding its colour names
// fall back to the app theme (.onboarding-provider-input in index.css).
const FIELD_CLASS =
  "onboarding-provider-input h-9 rounded-xl! border px-3 text-xs shadow-none! focus:ring-2 focus:ring-[color-mix(in_srgb,var(--onboarding-accent,var(--color-primary))_15%,transparent)]";

type ProviderCheckFieldProps = Omit<
  ComponentProps<typeof Input>,
  "dir" | "aria-invalid" | "aria-describedby" | "aria-label" | "ref"
> &
  // Onboarding captions the field itself; Settings names it after the heading above it.
  ({ label: string; "aria-label"?: never } | { label?: never; "aria-label": string }) & {
    /** The automatic check whose status this field carries; most fields carry none. */
    check?: Pick<ConnectionAutoCheck, "phase" | "failure" | "retry">;
    /**
     * Replaces the default reason for a refusal the value is not to blame for, such as a
     * server that refused a check sent without a key. The field is then not marked invalid.
     */
    failureReason?: string;
    /**
     * The failure that says this field's value is wrong: a refused key for a key or secret, a
     * missing model for a Model ID. Any other failure leaves the value valid. Omitted for a
     * field no failure can prove wrong, such as a server address.
     */
    invalidOn?: "credentialsRejected" | "modelNotFound";
  };

/**
 * The app's field for a credential. A saved secret shows its first and last characters
 * until it is focused, and focusing it selects all of it, so a paste replaces it. With a
 * check, the status sits at the field's end, and the reason for a failure or for no verdict,
 * with Retry, under it.
 */
export function ProviderCheckField({
  label,
  check,
  failureReason,
  invalidOn,
  className,
  onFocus,
  onBlur,
  ...inputProps
}: ProviderCheckFieldProps) {
  const { t } = useTranslation();
  const reasonId = useId();
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const phase = check?.phase ?? "idle";
  const failure = check?.failure ?? null;
  const secret = inputProps.type === "password";
  const value = String(inputProps.value ?? "");
  const masked = secret && value !== "" && !focused;
  const describe = (result: ProviderConnectionResult) =>
    result.errorCode
      ? t(`onboarding.rehaul.provider.errors.${result.errorCode}`, {
          status: result.status,
          defaultValue: result.error ?? t("onboarding.rehaul.provider.connectionFailed"),
        })
      : (result.error ?? t("onboarding.rehaul.provider.connectionFailed"));

  // The value reads left to right in every language, so its status sits at the field's end.
  const field = (
    <span dir="ltr" className="relative block">
      <Input
        dir="ltr"
        {...inputProps}
        ref={inputRef}
        onFocus={(event) => {
          // Regaining focus after a window switch keeps the caret where it was.
          if (secret && !focused) event.currentTarget.select();
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          if (!isWindowSwitchBlur(event)) setFocused(false);
          onBlur?.(event);
        }}
        aria-invalid={
          !failureReason && invalidOn && failure?.errorCode === invalidOn ? true : undefined
        }
        aria-describedby={check ? reasonId : undefined}
        className={cn(
          FIELD_CLASS,
          className,
          phase !== "idle" && "pe-9",
          masked && "text-transparent!"
        )}
      />
      {masked && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 font-mono text-xs tracking-wide text-[var(--onboarding-text-primary,var(--color-foreground))] opacity-70"
        >
          {maskKey(value)}
        </span>
      )}
      {phase !== "idle" && (
        <ConnectionStatusIcon
          state={phase === "waiting" ? "checking" : phase}
          className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2"
        />
      )}
    </span>
  );

  return (
    <div>
      {label ? (
        <label className="block">
          <FieldLabel>{label}</FieldLabel>
          {field}
        </label>
      ) : (
        field
      )}
      {check && (
        <p
          className={
            failure
              ? cn(
                  "mt-1 px-1 text-xs leading-[1.4]",
                  // Amber text needs the darker shade to stay readable on white.
                  phase === "unverified" ? "text-amber-700 dark:text-amber-300" : "text-destructive"
                )
              : undefined
          }
        >
          <span id={reasonId} role="alert">
            {failure &&
              (phase === "unverified"
                ? t("onboarding.rehaul.provider.unverified", {
                    reason: failureReason ?? describe(failure),
                  })
                : (failureReason ?? describe(failure)))}
          </span>
          {failure && (
            <>
              {" "}
              <button
                type="button"
                // Retry goes away while the check runs, so focus moves to the field first.
                onClick={() => {
                  inputRef.current?.focus();
                  check.retry();
                }}
                className="font-medium underline underline-offset-2 hover:opacity-70"
              >
                {t("common.retry")}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
