import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "./icons";
import { Input } from "./ui/input";
import { useAffiliateStore } from "../stores/affiliateStore";

export default function CreatorLinkField() {
  const { t } = useTranslation();
  const state = useAffiliateStore();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!state.enabled) return null;
  if (state.saved)
    return (
      <p className="py-2 text-start text-xs text-muted-foreground" role="status">
        {t(state.error === "review" ? "affiliate.review" : "affiliate.saved")}
      </p>
    );
  const open = expanded || !!state.link || !!state.error;
  return (
    <div className="w-full text-start">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="flex min-h-10 w-full items-center justify-between gap-3 text-sm text-muted-foreground hover:text-foreground"
      >
        {t("affiliate.haveLink")}
        <ChevronDown
          aria-hidden="true"
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id={id} className="space-y-2 pb-2">
          <label htmlFor={`${id}-input`} className="sr-only">
            {t("affiliate.label")}
          </label>
          <Input
            id={`${id}-input`}
            dir="ltr"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            maxLength={2048}
            value={state.link}
            placeholder={t("affiliate.placeholder")}
            onChange={(e) => state.setLink(e.target.value)}
            disabled={state.checking}
            aria-describedby={state.error ? `${id}-error` : undefined}
          />
          {state.error && (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {t(`affiliate.${state.error}`)}
            </p>
          )}
          {state.checking && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("affiliate.checking")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
