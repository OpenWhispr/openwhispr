const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = require("typescript");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

async function loadUsage(
  t,
  syncModule = "export const syncService = { syncAnalyticsNow: async () => true };"
) {
  // Exercise the private production component's lifecycle with lightweight presentation.
  const source = readFileSync(join(__dirname, "../../src/components/InsightsView.tsx"), "utf8");
  const usage = source.slice(
    source.indexOf("function YourUsage("),
    source.indexOf("\nexport default function InsightsView")
  );
  const vite = await createRendererServer(t, {
    mockModules: {
      "/services/SyncService": syncModule,
      "/lib/authRequestContext": `
          export const getValidatedAuthGeneration = () => 7;
          export const invalidateValidatedAuthContext = () => {};
          export const readAuthTokenState = async () => ({ generation: 7 });
        `,
      "/YourUsage": transpileModule(
        `
          import React, { useCallback, useEffect, useRef, useState } from 'react';
          import * as cache from '/lib/insightsCache';
          import { getAccountAnalyticsSummary, subscribeToAnalyticsRefresh } from '/services/AnalyticsService';
          import { syncService } from '/services/SyncService';
          const { cacheInsightsSummary, isInsightFresh, readCachedInsightsSummary,
            getInsightsCacheVersion, isInsightsCacheCurrent, subscribeToInsightsCacheInvalidation } = cache;
          const useTranslation = () => ({ t: key => key });
          const UsageDashboard = ({ summary }) => React.createElement('div', null, summary?.totalWords);
          const UsagePreview = () => React.createElement('div', null, 'empty');
          export ${usage}
        `,
        {
          compilerOptions: {
            jsx: JsxEmit.React,
            module: ModuleKind.ESNext,
            target: ScriptTarget.ES2022,
          },
        }
      ).outputText,
    },
  });
  const { YourUsage } = await vite.ssrLoadModule("/YourUsage");
  return { vite, YourUsage };
}

for (const unmount of [false, true]) {
  test(`a late summary cannot restore cleared history ${unmount ? "after unmount" : "while mounted"}`, async (t) => {
    let root;
    t.after(() => act(() => root?.unmount()));
    const pending = Promise.withResolvers();
    const summary = {
      totalWords: 999,
      totalDictations: 5,
      totalSpokenDurationMs: 1000,
      averageWpm: null,
      currentStreakDays: 1,
      longestStreakDays: 1,
      wpmCoveragePercent: 0,
      daily: [],
    };
    const empty = { ...summary, totalWords: 0, totalDictations: 0 };
    let reads = 0;
    installBrowserGlobals(t, {
      window: {
        clearInterval() {},
        electronAPI: {
          getAnalyticsSummary: async () => empty,
          onAnalyticsChanged: () => () => {},
          cloudApiRequest: async () =>
            ++reads === 1 ? pending.promise : { success: true, data: empty },
        },
      },
    });
    const container = installInteractiveDom(t);
    globalThis.window.document.visibilityState = "visible";
    const { vite, YourUsage } = await loadUsage(t);
    const cache = await vite.ssrLoadModule("/lib/insightsCache.ts");
    root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(YourUsage, {
          accountId: "user-a",
          dataRetentionEnabled: true,
          isLoaded: true,
          syncActive: true,
          onSyncErrorChange() {},
        })
      )
    );
    assert.equal(reads, 1);
    if (unmount) {
      await act(() => root.unmount());
      root = null;
    }
    await act(async () => cache.clearInsightsCache());
    await act(async () => pending.resolve({ success: true, data: summary }));
    const kept = cache.readCachedInsightsSummary("user-a");
    if (unmount) {
      assert.equal(kept, null, "an unmounted request never writes the cache");
      assert.equal(reads, 1);
    } else {
      assert.equal(reads, 2, "clearing history reloads a mounted summary");
      assert.equal(kept.value.totalWords, 0);
      assert.equal(container.textContent, "empty");
    }
  });
}

test("focus recovery shows uploaded totals instead of the API's older copy", async (t) => {
  let root;
  t.after(() => act(() => root?.unmount()));
  t.mock.method(console, "error", () => {});
  let localChanged;
  let focus;
  let timer;
  let localWords = 100;
  let remoteWords = 100;
  let copy;
  let pending = false;
  let offline = false;
  let syncError;
  const modes = [];
  const summary = (totalWords) => ({
    totalWords,
    totalDictations: 5,
    totalSpokenDurationMs: 1000,
    averageWpm: null,
    currentStreakDays: 1,
    longestStreakDays: 1,
    wpmCoveragePercent: 0,
    daily: [],
  });
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name, callback) => {
        if (name === "focus") focus = callback;
      },
      setTimeout: (callback) => {
        timer = callback;
        return 1;
      },
      clearTimeout() {},
      clearInterval() {},
      electronAPI: {
        getAnalyticsSummary: async () => summary(localWords),
        onAnalyticsChanged: (callback) => {
          localChanged = callback;
          return () => {};
        },
        getPendingAnalyticsClear: async () => null,
        getPendingAnalyticsDeletes: async () => [],
        getPendingAnalyticsEvents: async () =>
          pending ? [{ event_id: "new", counter_version: 1 }] : [],
        markAnalyticsEventsSynced: async () => {
          pending = false;
          return { updated: 1 };
        },
        cloudApiRequest: async ({ method, path }) => {
          if (method === "POST") {
            if (offline) return { success: false, status: 503, error: "offline" };
            remoteWords = localWords;
            return { success: true, data: { accepted: ["new"] } };
          }
          const mode = new URL(path, "https://api.test").searchParams.get("cache");
          modes.push(mode);
          if (mode !== "allow" || !copy) copy = summary(remoteWords);
          return { success: true, data: copy };
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  window.document.visibilityState = "visible";
  const { YourUsage } = await loadUsage(
    t,
    `
    import { syncPendingAnalytics } from '/services/AnalyticsService';
    export const syncService = { syncAnalyticsNow: async () => {
      try {
        await syncPendingAnalytics({ context: { accountId: 'user-a', authGeneration: 7 } });
        return true;
      } catch { return false; }
    } };
  `
  );
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(YourUsage, {
        accountId: "user-a",
        dataRetentionEnabled: true,
        isLoaded: true,
        syncActive: true,
        onSyncErrorChange: (value) => {
          syncError = value;
        },
      })
    )
  );
  assert.equal(container.textContent, "100");
  localWords = 101;
  pending = true;
  offline = true;
  await act(async () => localChanged());
  assert.equal(container.textContent, "101");
  assert.equal(syncError, true);
  offline = false;
  await act(async () => {
    focus();
    timer();
  });
  assert.equal(pending, false);
  assert.equal(remoteWords, 101);
  assert.equal(container.textContent, "101");
  assert.equal(syncError, false);
  assert.deepEqual(modes, ["refresh", "refresh"]);
});
