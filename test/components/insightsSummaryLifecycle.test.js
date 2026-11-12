const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { transpileModule, JsxEmit, ModuleKind, ScriptTarget } = require("typescript");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

for (const { unmount, rejectionTicks } of [
  { unmount: false },
  { unmount: true },
  { unmount: false, rejectionTicks: 3 },
  { unmount: false, rejectionTicks: 4 },
]) {
  test(`a late summary cannot restore cleared history ${unmount ? "after unmount" : rejectionTicks ? `during rejection at tick ${rejectionTicks}` : "while mounted"}`, async (t) => {
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
    let localReads = 0;
    const replacementLocal = Promise.withResolvers();
    installBrowserGlobals(t, {
      window: {
        clearInterval() {},
        electronAPI: {
          getAnalyticsSummary: async () => {
            localReads += 1;
            if (!rejectionTicks) return empty;
            return localReads === 1 ? summary : replacementLocal.promise;
          },
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
    if (rejectionTicks) {
      await act(async () => {
        pending.reject(new Error("Network failed as history was cleared"));
        for (let tick = 0; tick < rejectionTicks; tick += 1) await Promise.resolve();
        cache.clearInsightsCache();
      });
      assert.equal(localReads, 2, "invalidation starts a replacement local read");
      assert.ok(!container.textContent.includes("999"), "the old local fallback stays retired");
      await act(async () => replacementLocal.resolve(empty));
      assert.equal(container.textContent, "empty");
      return;
    }
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
