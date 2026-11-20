---
phase: 07-connectors-titanium
plan: 01
status: complete
requirements: [FEAT-04]
commits: 2
plan_head_before: 726a7931d
pr: https://github.com/finedesignz/edgeassistant/pull/21
---

# Phase 7 Plan 1: Connectors keyed on the Titanium account Summary

Titanium session carries the IDP-32 account id and checks `app_slug`; a pure fork connector policy and account scope replace the OpenWhispr cloud inputs in a fork build.

## Tasks
1. Tracer (d647c1577): `titaniumSession` sends `app_slug`, rejects missing/different `appSlug` (`app_mismatch`), stores/loads `accountId`, `getAccountScope()`, `accountBound` in state (raw id never to renderer). New `titaniumConnectorPolicy.js` (`titaniumConnectorPolicyState`, `titaniumAccountScope`, `titaniumAccountChanged`, `createTitaniumConnectorBindings`, `watchTitaniumAccount`). `policyRefusal` maps `plan_required` / `reauth_required`. `main.js` and `ipcHandlers.js` select Titanium scope/policy when `CLOUD_ENABLED` is false (upstream path unchanged).
2. Account change reset (same commit): `watchTitaniumAccount` calls `connectorManager.accountChanged()` + `notifyStatusChanged()` once per sign-out/sign-in/account switch, never for license-only or generation-only changes.
3. Product id (fb0fd4385): `keygenProductId` = `bbe843ac-4de5-486c-85e2-1a1b7e533e5f` (orchestrator-verified); config assertion added.

## Verification
- titanium-licensing origin/main (read-only) already returns `accountId` and validates `app_slug` (tauri.md): no licensing change needed.
- Tests: titaniumSession, titaniumConnectorPolicy, titaniumConnectorWiring (real manager + credential store: slot `fake-sha256(acc_1)[:24]`, other account sees no login, each refusal code), connectorPolicy/Ipc/Credentials/Manager: all pass.

## Deviations
- Existing titaniumSession test fixture now echoes `appSlug` by default (the old lenient check allowed none). Tasks 1-2 committed together.
- Wiring subscription lives in `ipcHandlers.js` next to `registerConnectorIpc` (session is created earlier in `main.js`).
