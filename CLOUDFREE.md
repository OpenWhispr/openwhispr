# CloudFree OpenWhispr — Fork Maintenance Guide

A privacy-hardened fork of OpenWhispr. All CloudFree-specific code lives in `src/cloudfree/` with minimal surgical edits to upstream files. This document describes every upstream modification so changes can be re-applied after pulling from upstream.

## Architecture

CloudFree has three layers:

1. **`src/cloudfree/hooks.js`** — Main/preload process hooks (network guard, IPC bindings)
2. **`src/cloudfree/ui-hooks.tsx`** — Renderer-side exports (settings map, network panel, shield icon)
3. **`allowlist.json`** — Domain+path allowlist enforced at the Electron session level

All upstream UI components remain intact. CloudFree injects behavior through imports and small patches at file boundaries (top-of-file imports, end-of-array callbacks, export swaps).

## New Files (CloudFree-owned, no upstream equivalent)

| File | Purpose |
|------|---------|
| `allowlist.json` | Network allowlist — domain+path rules with wildcard support |
| `src/cloudfree/hooks.js` | Main/preload process hooks (`onBeforeReady`, `preload`) |
| `src/cloudfree/networkGuard.js` | Electron `session.webRequest.onBeforeRequest` filter + IPC handlers |
| `src/cloudfree/ui-hooks.tsx` | Settings sidebar map, hidden sections set, CloudFree pane item, re-exports |
| `src/cloudfree/branding.ts` | Fork-specific names, URLs, support links, attribution text |
| `src/cloudfree/CloudFreeSupportDropdown.tsx` | Fork support dropdown (bug report link + upstream attribution) |
| `src/cloudfree/components/CloudFreeNetworkPanel.tsx` | Network guard visualization (live log, stats, allowlist viewer) |
| `src/assets/fonts/noto-sans.css` | Local @font-face declarations for bundled Noto Sans |
| `src/assets/fonts/NotoSans-*.woff2` | Bundled font files (4 files, ~430KB total) |
| `scripts/cloudfree/scan-network-calls.js` | Static analysis script to find network URLs in codebase |
| `.github/workflows/cloudfree-upstream-sync.yml` | Daily upstream sync workflow with network scan |

## Upstream File Modifications

Each modification is described so it can be re-applied mechanically after an upstream merge.

### `main.js` (+6 lines)

**At top, after the unhandled rejection handler (~line 167):**
```js
// CloudFree hooks — pluggable integration points for the fork
const cloudfree = require("./src/cloudfree/hooks");
```

**At the start of `startApp()` function, before `initializeCoreManagers()`:**
```js
// CloudFree: Run main process hooks before any other network activity
cloudfree.onBeforeReady({ session: session.defaultSession, debugLogger });
```

### `preload.js` (+4 lines)

**At top, after the electron require:**
```js
const cloudfree = require("./src/cloudfree/hooks");
```

**At the end of the `contextBridge.exposeInMainWorld("electronAPI", {` object, before the closing `});`:**
```js
// CloudFree hooks
...cloudfree.preload(ipcRenderer),
```

### `src/components/SettingsModal.tsx` (+3 lines changed)

**Add import after the SettingsPage import:**
```ts
import * as cloudfree from "../cloudfree/ui-hooks";
```

**Change the closing of the sidebar items array from `],` to:**
```ts
].flatMap(cloudfree.settingsMap),
```

**Change the default active section from `"account"` to:**
```ts
React.useState<SettingsSectionType>(cloudfree.defaultSettingsSection)
```

### `src/components/SettingsPage.tsx` (+7 lines)

**Add import near the top:**
```ts
import { CloudFreeNetworkPanel } from "../cloudfree/ui-hooks";
```

**Add `"cloudfree"` to the `SettingsSectionType` union:**
```ts
| "agentMode"
| "cloudfree";
```

**Add case in `renderSectionContent()` switch, before `default`:**
```ts
case "cloudfree":
  return <CloudFreeNetworkPanel />;
```

### `src/components/ui/SupportDropdown.tsx` (+4 lines changed)

**Add import:**
```ts
import CloudFreeSupportDropdown from "../../cloudfree/CloudFreeSupportDropdown";
```

**Remove `export default` from the upstream `SupportDropdown` function declaration:**
```ts
// was: export default function SupportDropdown(...)
function SupportDropdown(...)
```

**Add at end of file:**
```ts
// CloudFree: export fork-specific support dropdown
export default CloudFreeSupportDropdown;
```

### `src/components/ControlPanelSidebar.tsx` (-2 lines, +4 lines changed)

**Remove the `Blocks` import from lucide-react.**

**Remove the integrations nav item:**
```ts
// Remove: { id: "integrations", label: t("sidebar.integrations"), icon: Blocks },
```

**In the upgrade banner (the `showUpgradeBanner` block), replace 4 content lines:**
```tsx
// Title:     {t("sidebar.upgradeTitle")}       → Want full features?
// Desc:      {t("sidebar.upgradeDescription")} → This is a privacy-hardened fork. For cloud sync, integrations, and Pro features, try the official app.
// onClick:   onUpgrade                          → () => window.electronAPI?.openExternal("https://openwhispr.com")
// Button:    {t("sidebar.learnMore")}           → Visit OpenWhispr
```

### `src/index.html` (-3 lines, +1 line)

**Replace the 3 Google Fonts CDN lines with:**
```html
<link rel="stylesheet" href="./assets/fonts/noto-sans.css">
```

## Allowlist Format

`allowlist.json` uses v2 format with per-domain path wildcards:

```json
{
  "version": 2,
  "rules": {
    "category_name": {
      "_comment": "description",
      "entries": [
        { "domain": "api.example.com", "paths": ["/v1/endpoint", "/v1/wildcard/*"] }
      ]
    }
  }
}
```

Paths use `*` as wildcard (converted to `.*` regex). Everything not in the allowlist is implicitly blocked. Internal requests (localhost, devtools, file://) are always allowed and tracked separately.

## After an Upstream Merge

1. Re-apply the modifications listed above (most are additive — imports + small patches)
2. If `SettingsSectionType` changed, ensure `"cloudfree"` is still in the union
3. If new settings sections were added upstream, they'll pass through `cloudfree.settingsMap` automatically
4. Run `node scripts/cloudfree/scan-network-calls.js --diff main` to check for new network URLs
5. Update `allowlist.json` if legitimate new endpoints were added upstream
