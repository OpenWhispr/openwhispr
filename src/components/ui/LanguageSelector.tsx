import React, { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X, Check } from "../icons";
import registry from "../../config/languageRegistry.json";
import { LIST_SEARCH_THRESHOLD } from "../../config/constants";

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
  placeholder?: string;
}

export default function LanguageSelector({
  value,
  onChange,
  options,
  className = "",
  placeholder,
}: LanguageSelectorProps) {
  const { t } = useTranslation();
  const items = options ?? REGISTRY_OPTIONS;
  const showSearch = items.length > LIST_SEARCH_THRESHOLD;
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(
    typeof document === "undefined" ? null : document.body
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
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

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setHighlightedIndex(0);
  }, []);

  // Determine the portal container: use the closest dialog if inside one (to stay
  // within Radix's focus trap), otherwise fall back to document.body.
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!node) return;
    const dialog = node.closest('[role="dialog"]');
    setPortalTarget((dialog as HTMLElement) ?? document.body);
  }, []);

  useEffect(() => {
    if (isOpen && triggerRef.current && portalTarget) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const target = portalTarget;
      // When portaled into a transformed ancestor (e.g. Radix Dialog),
      // fixed positioning is relative to that ancestor, not the viewport.
      const offsetX = target === document.body ? 0 : target.getBoundingClientRect().left;
      const offsetY = target === document.body ? 0 : target.getBoundingClientRect().top;
      const menuWidth = Math.max(triggerRect.width, 240);
      const containerRight =
        (target === document.body ? window.innerWidth : target.getBoundingClientRect().right) -
        offsetX;
      let left = triggerRect.left - offsetX;
      if (left + menuWidth > containerRight - 8) {
        left = Math.max(8, triggerRect.right - offsetX - menuWidth);
      }
      setDropdownPosition({
        top: triggerRect.bottom + 4 - offsetY,
        left,
        width: menuWidth,
      });
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen, portalTarget]);
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
        handleSearchQueryChange("");
        break;
    }
  };

  const handleSelect = (languageValue: string) => {
    onChange(languageValue);
    setIsOpen(false);
    handleSearchQueryChange("");
  };

  const clearSearch = () => {
    handleSearchQueryChange("");
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  const selected = items.find((l) => l.value === value);

  return (
    <div className={`relative ${className}`} ref={setContainerNode}>
      {/* Trigger button - premium, tight, tactile macOS-style */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`
          group relative w-full flex items-center justify-between gap-2
          h-7 px-2.5 text-start
          rounded text-xs font-medium
          border shadow-sm
          transition-[background-color,border-color,transform] duration-200 ease-out
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 focus-visible:ring-offset-1
          ${
            isOpen
              ? "border-focus bg-surface-primary/90 shadow ring-1 ring-brand-solid/20"
              : "border-default/70 bg-surface-secondary/80 hover:border-hover hover:bg-surface-primary/70 hover:shadow active:scale-[0.985]"
          }
        `}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`truncate ${selected ? "text-primary" : "text-secondary"}`}>
          <span className="me-1.5">{selected?.flag ?? "\uD83C\uDF10"}</span>
          {selected?.label ?? (value || placeholder || "")}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-secondary transition-[color,transform] duration-200 ${
            isOpen ? "rotate-180 text-brand-solid" : "group-hover:text-primary"
          }`}
        />
      </button>

      {/* Dropdown - ultra-premium glassmorphic panel (rendered via portal) */}
      {isOpen &&
        portalTarget &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: `${dropdownPosition.width}px`,
            }}
            className="z-9999 bg-surface-primary/95 backdrop-blur-xl border border-default/70 rounded shadow-xl overflow-hidden"
          >
            {showSearch && (
              <div className="px-2 pt-2 pb-1.5 border-b border-default/70">
                <div className="relative">
                  <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3 h-3 text-secondary pointer-events-none" />
                  <input
                    dir="auto"
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearchQueryChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("languageSelector.searchPlaceholder")}
                    className="w-full h-7 ps-7 pe-6 text-xs bg-transparent text-primary border-0 focus:outline-none placeholder:text-secondary/70"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute end-1.5 top-1/2 -translate-y-1/2 text-secondary hover:text-primary transition-colors rounded p-0.5 hover:bg-surface-secondary/50"
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
                <div className="px-2.5 py-2 text-xs text-secondary">
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
                          h-7 px-2.5 text-start text-xs font-medium
                          rounded transition-[background-color,color,transform] duration-150 ease-out
                          ${
                            isSelected
                              ? "bg-brand-solid/15 text-brand-solid shadow-sm"
                              : isHighlighted
                                ? "bg-surface-secondary/70 text-primary"
                                : "text-primary hover:bg-surface-secondary/50 active:scale-[0.98]"
                          }
                        `}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className="truncate">
                          <span className="me-1.5">{language.flag}</span>
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
          portalTarget
        )}
    </div>
  );
}
