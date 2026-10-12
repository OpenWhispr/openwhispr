#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const APP_URLS_SOURCE = 'https://raw.githubusercontent.com/bhagyas/app-urls/master/README.adoc';

const DEFAULT_COUNTRY = 'us';
const DEFAULT_DELAY_MS = 3200;
const DEFAULT_MAX = Number.POSITIVE_INFINITY;

function parseArgs(argv) {
  const options = {
    country: DEFAULT_COUNTRY,
    delayMs: DEFAULT_DELAY_MS,
    max: DEFAULT_MAX,
    out: 'data/ios-return-map.generated.json',
    allowTopHit: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--country' && argv[i + 1]) {
      options.country = argv[i + 1].toLowerCase();
      i += 1;
      continue;
    }
    if (arg === '--delay-ms' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        options.delayMs = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === '--max' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.max = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === '--out' && argv[i + 1]) {
      options.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--allow-top-hit') {
      options.allowTopHit = true;
    }
  }

  return options;
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function choosePreferredScheme(rawCell) {
  const inlineCodeMatches = Array.from(rawCell.matchAll(/`([^`]+)`/g)).map((match) =>
    match[1].trim(),
  );
  const tokens = inlineCodeMatches.length > 0 ? inlineCodeMatches : [rawCell.trim()];
  const candidates = tokens
    .flatMap((token) => token.split(/\s+or\s+|,\s*/i))
    .map((candidate) => candidate.trim())
    .map((candidate) => candidate.replace(/[.,;]+$/, ''))
    .filter(Boolean);

  const preferred = candidates.find((candidate) => {
    if (!candidate.includes('://')) {
      return false;
    }
    return !candidate.startsWith('http://') && !candidate.startsWith('https://');
  });

  if (!preferred) {
    return null;
  }

  const baseSchemeMatch = preferred.match(/^([a-z][a-z0-9+.-]*:\/\/)/i);
  if (!baseSchemeMatch) {
    return null;
  }

  const normalizedBaseScheme = baseSchemeMatch[1].toLowerCase();
  if (normalizedBaseScheme === 'whatsapp://' || normalizedBaseScheme === 'whatsapp-consumer://') {
    return 'whatsapp://send';
  }
  if (
    normalizedBaseScheme === 'whatsapp-smb://' ||
    normalizedBaseScheme === 'whatsapp-business://'
  ) {
    return 'whatsapp-business://';
  }

  return normalizedBaseScheme;
}

function extractThirdPartyRows(adocText) {
  const sectionStart = adocText.indexOf('== Third-Party Apps & Services');
  if (sectionStart === -1) {
    throw new Error('Could not find "Third-Party Apps & Services" section in app-urls source');
  }

  const afterStart = adocText.slice(sectionStart);
  const sectionEndRelative = afterStart.indexOf('\n== ', 1);
  const section = sectionEndRelative === -1 ? afterStart : afterStart.slice(0, sectionEndRelative);

  const cells = section
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line !== '|===')
    .map((line) => line.slice(1).trim())
    .filter(Boolean);

  const rows = [];
  for (let index = 0; index + 2 < cells.length; index += 3) {
    const appName = cells[index];
    const urlCell = cells[index + 1];
    if (!appName || appName === 'Application/Service') {
      continue;
    }

    const scheme = choosePreferredScheme(urlCell);
    if (!scheme) {
      continue;
    }

    rows.push({
      appName,
      scheme,
    });
  }

  return rows;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'openwhispr-ios-return-map-builder',
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'openwhispr-ios-return-map-builder',
      Accept: 'text/plain',
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

function selectSearchResult(appName, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const normalizedTarget = normalizeName(appName);
  const withTrackName = results.filter((item) => typeof item?.trackName === 'string');
  const exactMatch = withTrackName.find(
    (item) => normalizeName(item.trackName) === normalizedTarget,
  );
  if (exactMatch) {
    return {
      result: exactMatch,
      confidence: 'exact',
    };
  }

  const containsMatch = withTrackName.find((item) =>
    normalizeName(item.trackName).includes(normalizedTarget),
  );
  if (containsMatch) {
    return {
      result: containsMatch,
      confidence: 'contains',
    };
  }

  return {
    result: withTrackName[0],
    confidence: 'top-hit',
  };
}

async function resolveBundleInfo(appName, country) {
  const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
    appName,
  )}&entity=software&country=${encodeURIComponent(country)}&limit=5`;
  const searchPayload = await fetchJson(searchUrl);

  const selected = selectSearchResult(appName, searchPayload?.results ?? []);
  if (!selected) {
    return null;
  }

  const trackId = selected.result.trackId;
  if (!trackId) {
    return null;
  }

  const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(String(trackId))}`;
  const lookupPayload = await fetchJson(lookupUrl);
  const lookupResult = Array.isArray(lookupPayload?.results) ? lookupPayload.results[0] : null;

  return {
    appName,
    confidence: selected.confidence,
    trackId: lookupResult?.trackId ?? selected.result.trackId ?? null,
    trackName: lookupResult?.trackName ?? selected.result.trackName ?? null,
    bundleId: lookupResult?.bundleId ?? selected.result.bundleId ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(
    `[ios-return-map] fetching source from app-urls (delay=${options.delayMs}ms, country=${options.country}, max=${options.max})`,
  );

  const sourceText = await fetchText(APP_URLS_SOURCE);
  const sourceRows = extractThirdPartyRows(sourceText).slice(0, options.max);
  console.log(`[ios-return-map] extracted ${sourceRows.length} candidate apps with URL schemes`);

  const resolved = [];
  const unresolved = [];

  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index];
    const progressPrefix = `[ios-return-map] [${index + 1}/${sourceRows.length}]`;
    try {
      const info = await resolveBundleInfo(row.appName, options.country);
      if (!info?.bundleId || !info.trackId) {
        unresolved.push({
          appName: row.appName,
          scheme: row.scheme,
          reason: 'itunes lookup returned no bundle id',
        });
        console.log(`${progressPrefix} unresolved: ${row.appName}`);
      } else {
        if (info.confidence === 'top-hit' && !options.allowTopHit) {
          unresolved.push({
            appName: row.appName,
            scheme: row.scheme,
            reason: 'low-confidence search result (top-hit)',
          });
          console.log(`${progressPrefix} unresolved (low confidence): ${row.appName}`);
        } else {
          resolved.push({
            appName: row.appName,
            scheme: row.scheme,
            bundleId: info.bundleId,
            trackId: info.trackId,
            trackName: info.trackName,
            confidence: info.confidence,
          });
          console.log(
            `${progressPrefix} ${row.appName} -> ${info.bundleId} (${row.scheme}) [${info.confidence}]`,
          );
        }
      }
    } catch (error) {
      unresolved.push({
        appName: row.appName,
        scheme: row.scheme,
        reason: error instanceof Error ? error.message : String(error),
      });
      console.log(`${progressPrefix} failed: ${row.appName}`);
    }

    if (index < sourceRows.length - 1) {
      await sleep(options.delayMs);
    }
  }

  const bundleToScheme = {};
  const conflicts = [];
  for (const item of resolved) {
    const existing = bundleToScheme[item.bundleId];
    if (!existing) {
      bundleToScheme[item.bundleId] = item.scheme;
      continue;
    }

    if (existing !== item.scheme) {
      conflicts.push({
        bundleId: item.bundleId,
        existingScheme: existing,
        incomingScheme: item.scheme,
        appName: item.appName,
      });
    }
  }

  const outputPath = resolve(process.cwd(), options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: APP_URLS_SOURCE,
        sourceCount: sourceRows.length,
        resolvedCount: resolved.length,
        unresolvedCount: unresolved.length,
        conflictCount: conflicts.length,
        bundleToScheme,
        resolved,
        unresolved,
        conflicts,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`[ios-return-map] wrote output: ${outputPath}`);
  console.log(
    `[ios-return-map] done. resolved=${resolved.length} unresolved=${unresolved.length} conflicts=${conflicts.length}`,
  );
}

main().catch((error) => {
  console.error('[ios-return-map] failed:', error);
  process.exit(1);
});
