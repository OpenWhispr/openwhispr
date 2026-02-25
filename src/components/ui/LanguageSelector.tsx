import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X, Check } from "lucide-react";
import registry from "../../config/languageRegistry.json";

export interface LanguageOption {
  value: string;
  label: string;
  flag: string;
}

const REGISTRY_OPTIONS: LanguageOption[] = registry.languages.map(({ code, label, flag }) => ({
  value: code,
  label,
  flag,
}));

interface LanguageSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options?: LanguageOption[];
  className?: string;
}

const SEARCH_THRESHOLD = 12;

export default function LanguageSelector({
  value,
  onChange,
  options,
  className = "",
}: LanguageSelectorProps) {
  const { t } = useTranslation();
  const items = options ?? REGISTRY_OPTIONS;
  const showSearch = items.length > SEARCH_THRESHOLD;
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredLanguages = showSearch
    ? items.filter(
        (lang) =>
          lang.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          lang.value.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery]);

  // Determine the portal container: use the closest dialog if inside one (to stay
  // within Radix's focus trap), otherwise fall back to document.body.
  const portalTarget = useRef<HTMLElement>(document.body);

  useEffect(() => {
    if (containerRef.current) {
      const dialog = containerRef.current.closest('[role="dialog"]');
      portalTarget.current = (dialog as HTMLElement) ?? document.body;
    }
  }, []);

  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const target = portalTarget.current;
      // When portaled into a transformed ancestor (e.g. Radix Dialog),
      // fixed positioning is relative to that ancestor, not the viewport.
      const offsetX = target === document.body ? 0 : target.getBoundingClientRect().left;
      const offsetY = target === document.body ? 0 : target.getBoundingClientRect().top;
      setDropdownPosition({
        top: triggerRect.bottom + 4 - offsetY,
        left: triggerRect.left - offsetX,
        width: triggerRect.width,
      });
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen]);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < filteredLanguages.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filteredLanguages.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (filteredLanguages[highlightedIndex]) {
          handleSelect(filteredLanguages[highlightedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearchQuery("");
        break;
    }
  };

  const handleSelect = (languageValue: string) => {
    onChange(languageValue);
    setIsOpen(false);
    setSearchQuery("");
  };

  const clearSearch = () => {
    setSearchQuery("");
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {/* Trigger button - premium, tight, tactile macOS-style */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`
          group relative w-full flex items-center justify-between gap-2
          h-7 px-2.5 text-left
          rounded text-xs font-medium
          border shadow-sm backdrop-blur-sm
          transition-[background-color,border-color,transform] duration-200 ease-out
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1
          ${
            isOpen
              ? "border-border-active bg-surface-2/90 shadow ring-1 ring-primary/20"
              : "border-border/70 bg-surface-1/80 hover:border-border-hover hover:bg-surface-2/70 hover:shadow active:scale-[0.985]"
          }
        `}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="truncate text-foreground">
          <span className="mr-1.5">
            {items.find((l) => l.value === value)?.flag ?? "\uD83C\uDF10"}
          </span>
          {items.find((l) => l.value === value)?.label ?? value}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-[color,transform] duration-200 ${
            isOpen ? "rotate-180 text-primary" : "group-hover:text-foreground"
          }`}
        />
      </button>

      {/* Dropdown - ultra-premium glassmorphic panel (rendered via portal) */}
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: `${dropdownPosition.width}px`,
            }}
            className="z-9999 bg-popover/95 backdrop-blur-xl border border-border/70 rounded shadow-xl overflow-hidden"
          >
            {showSearch && (
              <div className="px-2 pt-2 pb-1.5 border-b border-border/50">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("languageSelector.searchPlaceholder")}
                    className="w-full h-7 pl-7 pr-6 text-xs bg-transparent text-foreground border-0 focus:outline-none placeholder:text-muted-foreground/50"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors rounded p-0.5 hover:bg-muted/50"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Language list - tight, premium with smart scrollbar */}
            <div className="max-h-48 overflow-y-auto px-1 pb-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border">
              {filteredLanguages.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">
                  {t("languageSelector.noLanguagesFound")}
                </div>
              ) : (
                <div role="listbox" className="space-y-0.5 pt-1">
                  {filteredLanguages.map((language, index) => {
                    const isSelected = language.value === value;
                    const isHighlighted = index === highlightedIndex;

                    return (
                      <button
                        key={language.value}
                        type="button"
                        onClick={() => handleSelect(language.value)}
                        className={`
                          group w-full flex items-center justify-between gap-2
                          h-7 px-2.5 text-left text-xs font-medium
                          rounded transition-[background-color,color,transform] duration-150 ease-out
                          ${
                            isSelected
                              ? "bg-primary/15 text-primary shadow-sm"
                              : isHighlighted
                                ? "bg-muted/70 text-foreground"
                                : "text-foreground hover:bg-muted/50 active:scale-[0.98]"
                          }
                        `}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className="truncate">
                          <span className="mr-1.5">{language.flag}</span>
                          {language.label}
                        </span>
                        {isSelected && <Check className="w-3 h-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          portalTarget.current
        )}
    </div>
  );
}
