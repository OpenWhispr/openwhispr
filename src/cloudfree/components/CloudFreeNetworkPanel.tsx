import React, { useState, useEffect, useCallback } from "react";
import { Badge } from "../../components/ui/badge";
import {
  SettingsSection,
  SettingsGroup,
  SettingsPanel,
  SettingsPanelRow,
  SectionHeader,
} from "../../components/ui/SettingsSection";

interface NetworkLogEntry {
  timestamp: number;
  url: string;
  status: "allowed" | "blocked" | "internal";
  reason: string;
  resourceType: string;
}

interface AllowlistRule {
  domain: string;
  paths: string[];
}

interface AllowlistRuleGroup {
  comment: string;
  entries: AllowlistRule[];
}

interface AllowlistSummary {
  rules: Record<string, AllowlistRuleGroup>;
}

interface NetworkData {
  log: NetworkLogEntry[];
  internalLog: NetworkLogEntry[];
  stats: { allowed: number; blocked: number; internal: number };
  allowlist: AllowlistSummary;
}

export const CloudFreeNetworkPanel: React.FC = () => {
  const [data, setData] = useState<NetworkData | null>(null);
  const [activeTab, setActiveTab] = useState<"live" | "allowlist">("live");
  const [filter, setFilter] = useState<"all" | "blocked" | "allowed" | "internal">("all");

  const refresh = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI.cloudfreeGetNetworkLog();
      setData(result);
    } catch {
      // IPC not available yet
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!data) {
    return (
      <div className="text-xs text-muted-foreground p-4">
        Loading network guard data...
      </div>
    );
  }

  const { log, internalLog, stats, allowlist } = data;
  const totalRequests = stats.allowed + stats.blocked + stats.internal;
  const blockRate = totalRequests > 0 ? ((stats.blocked / totalRequests) * 100).toFixed(1) : "0";

  const filteredLog =
    filter === "all" ? log :
    filter === "internal" ? internalLog :
    log.filter((e) => e.status === filter);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="CloudFree Network Guard"
        description="All outbound requests must match an allowed domain and path pattern. Everything else is implicitly blocked."
      />

      {/* Stats bar */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-success/10 border border-success/20">
          <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
          <span className="text-xs font-medium text-success">Guard Active</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <span className="font-mono font-medium text-foreground">{stats.allowed}</span> allowed
          </span>
          <span>
            <span className="font-mono font-medium text-destructive">{stats.blocked}</span> blocked
          </span>
          <span className="text-muted-foreground/40">|</span>
          <span>
            <span className="font-mono font-medium text-muted-foreground">{stats.internal}</span> internal
          </span>
          {totalRequests > 0 && (
            <span className="text-muted-foreground/60">({blockRate}% blocked)</span>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-0.5 rounded-md bg-muted/50 w-fit">
        <button
          onClick={() => setActiveTab("live")}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            activeTab === "live"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Live Log
        </button>
        <button
          onClick={() => setActiveTab("allowlist")}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            activeTab === "allowlist"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Allowlist
        </button>
      </div>

      {activeTab === "live" && (
        <div className="space-y-2">
          {/* Filter buttons */}
          <div className="flex gap-1">
            {(["all", "blocked", "allowed", "internal"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                  filter === f
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Log entries */}
          <SettingsPanel>
            <div className="max-h-80 overflow-y-auto divide-y divide-border/30 dark:divide-border-subtle/50">
              {filteredLog.length === 0 ? (
                <SettingsPanelRow>
                  <span className="text-xs text-muted-foreground">No requests logged yet</span>
                </SettingsPanelRow>
              ) : (
                filteredLog.map((entry, i) => (
                  <SettingsPanelRow key={`${entry.timestamp}-${i}`}>
                    <div className="flex items-start gap-2">
                      <Badge
                        variant={entry.status === "blocked" ? "destructive" : entry.status === "internal" ? "secondary" : "success"}
                        className="mt-0.5 shrink-0 text-[10px] px-1.5 py-0"
                      >
                        {entry.status === "blocked" ? "BLOCKED" : entry.status === "internal" ? "INT" : "OK"}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-mono text-foreground truncate">{entry.url}</p>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {entry.reason}
                          {entry.resourceType && entry.resourceType !== "other" && (
                            <span className="ml-2 opacity-60">{entry.resourceType}</span>
                          )}
                        </p>
                      </div>
                      <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </SettingsPanelRow>
                ))
              )}
            </div>
          </SettingsPanel>
        </div>
      )}

      {activeTab === "allowlist" && (
        <div className="space-y-3">
          {Object.entries(allowlist.rules).map(([groupKey, group]) => (
            <SettingsGroup key={groupKey} title={group.comment || groupKey}>
              <div className="space-y-2">
                {group.entries.map((rule) => (
                  <div key={rule.domain} className="flex items-start gap-2">
                    <Badge variant="success" className="text-[10px] font-mono shrink-0 mt-0.5">
                      {rule.domain}
                    </Badge>
                    <div className="flex flex-wrap gap-1">
                      {rule.paths.map((p) => (
                        <span
                          key={p}
                          className="text-[10px] font-mono text-muted-foreground/70 bg-muted/40 px-1.5 py-0.5 rounded"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </SettingsGroup>
          ))}
        </div>
      )}
    </div>
  );
};
