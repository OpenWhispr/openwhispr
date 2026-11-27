import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ORUKEET_MODEL } from "../helpers/dictationStreamingRouting";
import { selfHostedSttHeaderProblem } from "../helpers/selfHostedSttHeaders.js";
import { useConnectionAutoCheck } from "../hooks/useConnectionAutoCheck";
import { useCredentialDraft } from "../hooks/useCredentialDraft";
import { useFocusHold } from "../hooks/useFocusHold";
import { useTypingPause } from "../hooks/useTypingPause";
import type { SelfHostedSttHeader } from "../stores/settingsStore";
import { Button } from "./ui/button";
import { ConnectionCheckAnnouncer } from "./ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "./ui/ProviderCheckField";
import { usePanelVisible } from "./ui/usePanelVisible";

interface SelfHostedPanelProps {
  service: "transcription" | "reasoning";
  url: string;
  onUrlChange: (url: string) => void;
  model?: string;
  onModelChange?: (model: string) => void;
  /** This server's custom HTTP headers, editable when `onHeadersChange` is given. */
  headers?: SelfHostedSttHeader[];
  onHeadersChange?: (headers: SelfHostedSttHeader[]) => void;
}

export default function SelfHostedPanel({
  service,
  url,
  onUrlChange,
  model,
  onModelChange,
  headers,
  onHeadersChange,
}: SelfHostedPanelProps) {
  const { t } = useTranslation();
  const urlHold = useFocusHold();
  const editing = useFocusHold();
  const visible = usePanelVisible();
  const trimmedModel = (model ?? "").trim();
  // Headers can carry secrets, so like a key they save when their fields are left or a check
  // passes; until then the check carries what is typed.
  const headerDraft = useCredentialDraft();
  const typedHeaders = headerDraft.value("headers", JSON.stringify(headers ?? []));
  const rows: SelfHostedSttHeader[] = JSON.parse(typedHeaders);
  const problems = rows.map(selfHostedSttHeaderProblem);
  const editHeaders = (next: SelfHostedSttHeader[]) =>
    headerDraft.change("headers", JSON.stringify(next), (value) =>
      onHeadersChange?.(JSON.parse(value))
    );
  const editRow = (index: number, field: keyof SelfHostedSttHeader, value: string) =>
    editHeaders(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  // The address and model save as they are typed.
  const delayMs = useTypingPause({
    typed: `${url}\n${model ?? ""}\n${typedHeaders}`,
    context: JSON.stringify([service, visible]),
    held: editing.held,
  });
  const check = useConnectionAutoCheck({
    config: {
      scope: service,
      provider: "custom",
      baseUrl: url,
      model,
      ...(rows.length ? { headers: rows } : {}),
    },
    ready:
      Boolean(onModelChange && url.trim() && trimmedModel) &&
      // The app sends this model's server a key this panel has no field for, so a check
      // could only ask without it.
      trimmedModel !== ORUKEET_MODEL &&
      // A header no server takes is shown on its row instead.
      problems.every((problem) => !problem) &&
      // A hidden panel is not ready to ask; a shown one asks again, and the main process
      // answers a check it remembers at once.
      visible,
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: urlHold.held,
    delayMs,
  });
  const followHeaderDraft = headerDraft.follow;
  useEffect(() => {
    followHeaderDraft({
      phase: check.phase,
      checked: { headers: typedHeaders },
      // Someone's own server may refuse for other reasons, so its refusal holds nothing back.
      refused: false,
    });
  }, [check.phase, typedHeaders, followHeaderDraft]);

  const placeholderUrl =
    service === "transcription" ? "http://192.168.1.126:8178" : "http://192.168.1.126:8080";

  return (
    <div
      className="border border-border rounded-lg p-3 space-y-2.5"
      onFocus={editing.onFocus}
      onBlur={editing.onBlur}
    >
      <ConnectionCheckAnnouncer announcement={check.announcement} />
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground">
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <ProviderCheckField
          aria-label={t("settingsPage.selfHosted.serverUrl")}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onFocus={urlHold.onFocus}
          onBlur={urlHold.onBlur}
          placeholder={placeholderUrl}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {onModelChange && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">{t("common.model")}</label>
          <ProviderCheckField
            aria-label={t("common.model")}
            check={check}
            invalidOn="modelNotFound"
            // No key goes to this server: only custom headers can carry one.
            failureReason={
              check.failure?.errorCode === "credentialsRejected"
                ? t(
                    onHeadersChange
                      ? "settingsPage.selfHosted.unauthorized"
                      : "reasoning.custom.endpointUnauthorized"
                  )
                : undefined
            }
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="Whisper-Large-v3-Turbo"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      {onHeadersChange && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.selfHosted.headers")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.selfHosted.headersHelp")}
          </p>
          {rows.map((header, index) => {
            const problem = problems[index];
            return (
              <div key={index} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <ProviderCheckField
                    aria-label={t("settingsPage.selfHosted.headerName")}
                    placeholder={t("settingsPage.selfHosted.headerName")}
                    value={header.name}
                    error={
                      problem && problem !== "invalidValue"
                        ? t(`settingsPage.selfHosted.headerErrors.${problem}`)
                        : undefined
                    }
                    onChange={(event) => editRow(index, "name", event.target.value)}
                    onBlur={headerDraft.save}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <ProviderCheckField
                    type="password"
                    aria-label={t("settingsPage.selfHosted.headerValue")}
                    placeholder={t("settingsPage.selfHosted.headerValue")}
                    value={header.value}
                    error={
                      problem === "invalidValue"
                        ? t("settingsPage.selfHosted.headerErrors.invalidValue")
                        : undefined
                    }
                    onChange={(event) => editRow(index, "value", event.target.value)}
                    onBlur={headerDraft.save}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    editHeaders(rows.filter((_, i) => i !== index));
                    headerDraft.save();
                  }}
                >
                  {t("settingsPage.selfHosted.removeHeader")}
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => editHeaders([...rows, { name: "", value: "" }])}
          >
            {t("settingsPage.selfHosted.addHeader")}
          </Button>
        </div>
      )}
    </div>
  );
}
