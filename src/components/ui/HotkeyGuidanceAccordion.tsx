import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "./accordion";
import { getReservedShortcuts, getValidExamples, type Platform } from "../../utils/hotkeyValidator";
import { formatHotkeyLabelForPlatform } from "../../utils/hotkeys";

type AccordionPlatform = "macos" | "windows" | "linux";

const PLATFORM_MAP: Record<AccordionPlatform, Platform> = {
  macos: "darwin",
  windows: "win32",
  linux: "linux",
};

interface HotkeyGuidanceAccordionProps {
  defaultValue?: AccordionPlatform;
  className?: string;
}

export function HotkeyGuidanceAccordion({
  defaultValue,
  className = "",
}: HotkeyGuidanceAccordionProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState<Record<AccordionPlatform, boolean>>({
    macos: false,
    windows: false,
    linux: false,
  });

  const recommendedByPlatform: Record<AccordionPlatform, string[]> = {
    macos: [
      t("hotkeyGuidance.recommended.macos.0"),
      t("hotkeyGuidance.recommended.macos.1"),
      t("hotkeyGuidance.recommended.macos.2"),
      t("hotkeyGuidance.recommended.macos.3"),
      t("hotkeyGuidance.recommended.macos.4"),
    ],
    windows: [
      t("hotkeyGuidance.recommended.windows.0"),
      t("hotkeyGuidance.recommended.windows.1"),
      t("hotkeyGuidance.recommended.windows.2"),
      t("hotkeyGuidance.recommended.windows.3"),
    ],
    linux: [
      t("hotkeyGuidance.recommended.linux.0"),
      t("hotkeyGuidance.recommended.linux.1"),
      t("hotkeyGuidance.recommended.linux.2"),
      t("hotkeyGuidance.recommended.linux.3"),
      t("hotkeyGuidance.recommended.linux.4"),
    ],
  };

  const validationRules = [
    t("hotkeyGuidance.validationRules.0"),
    t("hotkeyGuidance.validationRules.1"),
    t("hotkeyGuidance.validationRules.2"),
    t("hotkeyGuidance.validationRules.3"),
  ];

  const platformLabels: Record<AccordionPlatform, string> = {
    macos: t("hotkeyGuidance.platforms.macos"),
    windows: t("hotkeyGuidance.platforms.windows"),
    linux: t("hotkeyGuidance.platforms.linux"),
  };

  const renderReserved = (platformKey: AccordionPlatform) => {
    const platform = PLATFORM_MAP[platformKey];
    const reserved = getReservedShortcuts(platform);
    const formatted = reserved.map((shortcut) => formatHotkeyLabelForPlatform(shortcut, platform));
    const unique = Array.from(new Set(formatted));
    const displayCount = 8;
    const visible = showAll[platformKey] ? unique : unique.slice(0, displayCount);
    const hasMore = unique.length > displayCount;

    return (
      <div className="space-y-2">
        <p className="text-xs text-secondary">{t("hotkeyGuidance.blockedDescription")}</p>
        <ul className="flex flex-wrap gap-2">
          {visible.map((shortcut) => (
            <li key={`${platformKey}-${shortcut}`}>
              <kbd className="px-2 py-1 text-xs font-mono bg-surface-secondary border border-default rounded">
                {shortcut}
              </kbd>
            </li>
          ))}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={() =>
              setShowAll((prev) => ({
                ...prev,
                [platformKey]: !prev[platformKey],
              }))
            }
            className="text-xs text-brand hover:opacity-80"
          >
            {showAll[platformKey] ? t("hotkeyGuidance.showFewer") : t("hotkeyGuidance.showAll")}
          </button>
        )}
      </div>
    );
  };

  const renderSection = (platformKey: AccordionPlatform) => {
    const platform = PLATFORM_MAP[platformKey];
    const recommended = recommendedByPlatform[platformKey];
    const examples = getValidExamples(platform);
    const formattedExamples = examples.map((example) =>
      formatHotkeyLabelForPlatform(example, platform)
    );

    return (
      <AccordionItem value={platformKey}>
        <AccordionTrigger>{platformLabels[platformKey]}</AccordionTrigger>
        <AccordionContent>
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-primary mb-2">
                {t("hotkeyGuidance.recommendedTitle")}
              </h4>
              <ul className="space-y-1 text-sm text-secondary">
                {recommended.map((pattern) => (
                  <li key={`${platformKey}-${pattern}`}>{pattern}</li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-primary mb-2">
                {t("hotkeyGuidance.rulesTitle")}
              </h4>
              <ul className="space-y-1 text-sm text-secondary">
                {validationRules.map((rule) => (
                  <li key={`${platformKey}-${rule}`}>{rule}</li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-primary mb-2">
                {t("hotkeyGuidance.blockedTitle")}
              </h4>
              {renderReserved(platformKey)}
            </div>

            <div>
              <h4 className="text-sm font-semibold text-primary mb-2">
                {t("hotkeyGuidance.examplesTitle")}
              </h4>
              <ul className="flex flex-wrap gap-2">
                {formattedExamples.map((example) => (
                  <li key={`${platformKey}-${example}`}>
                    <kbd className="px-2 py-1 text-xs font-mono bg-surface-secondary border border-default rounded">
                      {example}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
    );
  };

  return (
    <div className={`border border-default rounded-xl bg-surface-secondary p-4 ${className}`}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-primary">{t("hotkeyGuidance.title")}</h3>
        <p className="text-xs text-secondary">{t("hotkeyGuidance.description")}</p>
      </div>
      <Accordion type="single" collapsible defaultValue={defaultValue}>
        {renderSection("macos")}
        {renderSection("windows")}
        {renderSection("linux")}
      </Accordion>
    </div>
  );
}

export default HotkeyGuidanceAccordion;
