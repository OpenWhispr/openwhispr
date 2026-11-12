const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = require("typescript");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

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
    // Exercise the private production component's lifecycle with lightweight presentation.
    const source = readFileSync(join(__dirname, "../../src/components/InsightsView.tsx"), "utf8");
    const usage = source.slice(
      source.indexOf("function YourUsage("),
      source.indexOf("\nexport default function InsightsView")
    );
    const vite = await createRendererServer(t, {
      mockModules: {
        "/services/SyncService":
          "export const syncService = { syncAnalyticsNow: async () => true };",
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
