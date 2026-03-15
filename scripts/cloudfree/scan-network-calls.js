#!/usr/bin/env node
/**
 * CloudFree Network Call Scanner
 *
 * Scans the codebase (or a git diff) for outbound network calls and URLs.
 * Used in CI to detect when upstream changes introduce new network endpoints.
 *
 * Usage:
 *   node scripts/cloudfree/scan-network-calls.js              # scan full codebase
 *   node scripts/cloudfree/scan-network-calls.js --diff main   # scan diff against branch
 *   node scripts/cloudfree/scan-network-calls.js --ci          # CI mode (exit 1 if new URLs found)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const ALLOWLIST_PATH = path.join(ROOT, "cloudfree-allowlist.json");

// Patterns that indicate outbound network activity
const NETWORK_PATTERNS = [
  // URL literals
  /https?:\/\/[^\s"'`),\]}>]+/g,
  // WebSocket URLs
  /wss?:\/\/[^\s"'`),\]}>]+/g,
];

// Patterns for network call sites
const CALL_PATTERNS = [
  /\bfetch\s*\(/g,
  /\baxios\b/g,
  /\bnet\.request\s*\(/g,
  /\bhttps?\.request\s*\(/g,
  /\bhttps?\.get\s*\(/g,
  /\bnew\s+WebSocket\s*\(/g,
  /\bXMLHttpRequest\b/g,
];

// Files/dirs to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /dist\//,
  /build\//,
  /\.next\//,
  /package-lock\.json/,
  /\.map$/,
  /\.min\.js$/,
  /scripts\/cloudfree\//,  // don't scan ourselves
  /src\/cloudfree\//,      // don't scan the allowlist
];

// File extensions to scan
const SCAN_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".html",
]);

function loadAllowlist() {
  const raw = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
  const allowlist = JSON.parse(raw);
  const domains = [];
  for (const group of Object.values(allowlist.rules || {})) {
    for (const entry of group.entries || []) {
      if (entry.domain) domains.push(entry.domain);
    }
  }
  return { domains };
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isDomainAllowed(hostname, allowedDomains) {
  return allowedDomains.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`)
  );
}

function shouldSkip(filePath) {
  return SKIP_PATTERNS.some((p) => p.test(filePath));
}

function scanContent(content, filePath, findings) {
  const lines = content.split("\n");

  lines.forEach((line, lineIndex) => {
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return;
    }

    // Check URL patterns
    for (const pattern of NETWORK_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        findings.urls.push({
          url: match[0],
          file: filePath,
          line: lineIndex + 1,
        });
      }
    }

    // Check call patterns
    for (const pattern of CALL_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.calls.push({
          match: trimmed.substring(0, 120),
          file: filePath,
          line: lineIndex + 1,
        });
      }
    }
  });
}

function scanFile(filePath, findings) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SCAN_EXTENSIONS.has(ext)) return;
  if (shouldSkip(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const relPath = path.relative(ROOT, filePath);
    scanContent(content, relPath, findings);
  } catch {
    // skip unreadable files
  }
}

function scanDirectory(dir, findings) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldSkip(fullPath)) continue;
    if (entry.isDirectory()) {
      scanDirectory(fullPath, findings);
    } else if (entry.isFile()) {
      scanFile(fullPath, findings);
    }
  }
}

function scanDiff(baseBranch, findings) {
  const diffOutput = execSync(
    `git diff ${baseBranch}...HEAD -- '*.js' '*.ts' '*.tsx' '*.jsx' '*.json'`,
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );

  // Only scan added lines
  let currentFile = null;
  let lineNum = 0;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.substring(6);
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) lineNum = parseInt(match[1], 10) - 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNum++;
      if (currentFile && !shouldSkip(currentFile)) {
        scanContent(line.substring(1), currentFile, findings);
      }
    } else if (!line.startsWith("-")) {
      lineNum++;
    }
  }
}

function analyzeFindings(findings) {
  const { domains } = loadAllowlist();
  const report = {
    unknown_domains: [],
    allowed_domains: [],
    network_calls: findings.calls,
  };

  const seenDomains = new Map();

  for (const entry of findings.urls) {
    const domain = extractDomain(entry.url);
    if (!domain) continue;

    if (!seenDomains.has(domain)) {
      seenDomains.set(domain, []);
    }
    seenDomains.get(domain).push(entry);
  }

  for (const [domain, entries] of seenDomains) {
    if (isDomainAllowed(domain, domains)) {
      report.allowed_domains.push({ domain, count: entries.length });
    } else {
      report.unknown_domains.push({ domain, locations: entries });
    }
  }

  return report;
}

function printReport(report, ciMode) {
  console.log("\n=== CloudFree Network Scan Report ===\n");

  if (report.unknown_domains.length > 0) {
    console.log("⚠️  UNKNOWN DOMAINS (not in allowlist — review required):");
    for (const { domain, locations } of report.unknown_domains) {
      console.log(`  ${domain}`);
      for (const loc of locations.slice(0, 3)) {
        console.log(`    ${loc.file}:${loc.line} → ${loc.url.substring(0, 80)}`);
      }
      if (locations.length > 3) {
        console.log(`    ... and ${locations.length - 3} more`);
      }
    }
    console.log();
  }

  if (report.allowed_domains.length > 0) {
    console.log("✅ Allowed domains:");
    for (const { domain, count } of report.allowed_domains) {
      console.log(`  ${domain} (${count} references)`);
    }
    console.log();
  }

  console.log(`Network call sites found: ${report.network_calls.length}`);

  const hasIssues = report.unknown_domains.length > 0;

  if (hasIssues && ciMode) {
    console.log("\n❌ FAIL: Unreviewed network endpoints detected. Add to allowlist or remove.");
    process.exit(1);
  } else if (hasIssues) {
    console.log("\n⚠️  Review the above domains before merging.");
  } else {
    console.log("\n✅ All network endpoints are accounted for.");
  }
}

// Main
const args = process.argv.slice(2);
const ciMode = args.includes("--ci");
const diffIndex = args.indexOf("--diff");
const diffBranch = diffIndex >= 0 ? args[diffIndex + 1] || "main" : null;

const findings = { urls: [], calls: [] };

if (diffBranch) {
  console.log(`Scanning diff against ${diffBranch}...`);
  scanDiff(diffBranch, findings);
} else {
  console.log("Scanning full codebase...");
  scanDirectory(path.join(ROOT, "src"), findings);
  scanFile(path.join(ROOT, "main.js"), findings);
  scanFile(path.join(ROOT, "preload.js"), findings);
}

const report = analyzeFindings(findings);
printReport(report, ciMode);
