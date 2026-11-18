# Salesforce desktop integration

OpenWhispr connects an individual Salesforce user to two workflows: reviewed conversation export and a briefing for one selected CRM record. Connectors use the existing OpenWhispr account, subscription, and organization-policy requirements.

## OAuth app setup

Create a Salesforce External Client App appropriate for your test organization and distribution requirements. Configure authorization-code OAuth with these values:

| Setting                                      | Value                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| Callback URL                                 | `http://localhost:1718/salesforce/callback`            |
| PKCE                                         | Required, S256                                         |
| OAuth scopes                                 | `api`, `refresh_token` (offline access), `openid`      |
| Require client secret for Web Server Flow    | Disabled for this public desktop client                |
| Require client secret for Refresh Token Flow | Disabled for this public desktop client                |
| Login                                        | Individual Salesforce user, through the system browser |

Keep other organization policies appropriate to your environment. Salesforce may require app installation, user assignment, or administrator approval even though OpenWhispr does not implement workspace-wide Salesforce administration. Validate the app's distribution settings before trying a different customer organization.

Salesforce documents a comparable [desktop PKCE configuration for Data Loader](https://developer.salesforce.com/docs/platform/data-loader-impl/guide/loader-eca-oauth-pkce.html). See also the [refresh-token flow requirements](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_refresh_token_flow.htm&language=en_US&type=5).

The **Consumer Key is the client ID**. Do not put a Consumer Secret in the application or share passwords, tokens, or client secrets in chat.

For a development launch, provide these process environment variables through your terminal or launch configuration. There is no need to edit an `.env` file:

```sh
SALESFORCE_CLIENT_ID='your-consumer-key' \
SALESFORCE_LOGIN_URL='https://your-test-domain.my.salesforce.com' \
npm run dev
```

Use the actual My Domain URL shown by your test organization, including its sandbox domain if applicable. The default login host is `https://login.salesforce.com`; `https://test.salesforce.com` is available for sandbox sign-in. The callback must match exactly; local port 1718 must be free. A busy port is an actionable connection error, not a reason to change the registered URL silently.

Release builds must be supplied the public client ID through the existing build/runtime configuration. Without it, Salesforce is unavailable. OAuth refresh tokens stay in the existing per-account credential store; the renderer and chat model never receive them.

## What is needed for live testing

- The app's **Consumer Key/client ID** and confirmation that the callback and OAuth settings above are configured.
- The test organization's **My Domain URL**, and whether it is a sandbox/developer or production organization. Use a non-production organization for validation.
- An API-enabled test user who can read the sample records, create/update Tasks, and update the test Opportunity fields. Sign in interactively; do not send credentials in chat.
- Sample Account, Contact, Lead, and Opportunity records, including two with similar names to check explicit selection.
- One to three writable custom Opportunity text or plain long-text fields, with their API names (for example `Meeting_Summary__c`). Existing fields are sufficient; OpenWhispr does not create Salesforce schema.
- A valid closed Task status and a sample configuration representative of your organization's required fields/validation rules.

An additional restricted test user is useful for checking denied object/field access. App registration, API entitlement, consent, callback handling, and organization-specific validation rules require live testing; fixture tests do not verify these.

## Save a conversation

1. Connect Salesforce under Settings → Integrations → Connectors.
2. Open a saved meeting or dictated note. Ask the assistant to save it to Salesforce.
3. Search and explicitly choose the existing Account, Contact, Lead, or Opportunity. No automatic participant matching is performed.
4. Review and edit the activity title and summary, then save. The assistant reports a confirmed Salesforce activity link when available.
5. For an Opportunity, optionally select up to three writable custom text fields. Review each current/proposed value in a separate card after the activity is saved. Omit any field you do not want to change.

The exported activity contains the reviewed summary and meeting metadata, not a raw audio upload or a full transcript. Exporting again to the same destination updates the known activity. Field updates are separately approved; an activity can succeed even when an optional field update fails.

If a network interruption leaves the outcome uncertain, check Salesforce before sending again. OpenWhispr never repeats an uncertain write on its own, including after restart or reconnect. The next review card for that note and destination warns that the earlier attempt may have saved, and you can still send it. Salesforce takes no idempotency key, so sending again after an uncertain first save can create a second Task. OpenWhispr does not promise exactly-once delivery.

## Prepare a briefing

Ask for a briefing on a particular customer or deal and select its record. The briefing tool reads current Salesforce details and automatically retrieves accessible notes associated with that exact record on this device. Retrieval uses the existing workspace-scoped note reader and note protection. Other notes, search snippets and previous briefing answers are not evidence for this briefing.

The assistant selects and classifies source passages; the application renders the CRM facts and quoted passages with citations. The assistant cannot supply rewritten evidence, replacement CRM values or invented source links. Status labels remain assistant classifications: "confirmed" means reported in the note, not independently verified. Explicit proposal and conditional wording in English stays proposed, unless the passage reports what became of the proposal (approved, signed or rejected, for example). This check reads English only: in other languages the status is the assistant's classification alone, so compare it with the quoted passage. Potential conflicts show the selected contradictory passages without choosing a winner.

The briefing links the selected CRM record and shows when it was retrieved. Meeting claims use footnotes identifying the note, its date and supporting section or transcript passage. A "Saved Salesforce activity" link opens the exported summary; it is not a link to the current local note, which may have changed since export. Note creation dates are not assumed to be meeting dates.

Blank CRM fields are reported as not recorded; fields absent from the response are reported as not returned. Neither establishes whether a budget or decision was approved. Linked exports establish the selected destination, not a verified customer identity. Commitments retain their stated owners, deadlines and conditions; proposals remain proposals. Account and owner names are not resolved from IDs, so missing names are stated plainly.

Retrieval is limited to five linked notes, 14,000 source characters overall, 7,000 characters per note and 60 passages per note. The existing note reader also limits transcript retrieval. Limited or unavailable context is stated in the answer; a cut paragraph is omitted rather than quoted without its remaining conditions. Missing content does not establish that a meeting had no commitments or conflicts.

If no accessible meeting content is retrieved, the result explicitly says it is a CRM-only briefing. If the assistant skips presentation or supplies invalid evidence selections, the answer retains CRM facts and available source references and states that meeting findings were not prepared. Raw retrieved sources remain transient; selected excerpts in the visible answer are saved with the chat.

A response containing a Salesforce briefing is reserved for those briefings. Ask unrelated questions in a separate message. The workflow does not automatically search all your notes, traverse every related customer/deal, or predict pipeline-wide outcomes.

## Limits

- Desktop, one individual Salesforce login/organization per OpenWhispr account on each device.
- Manual selection and approved export only; no background CRM sync or team-level installation controls in OpenWhispr.
- Opportunity custom plain-text fields only; no stage, amount, date, picklist, relationship, or rich-text changes.
- Next steps are meeting text, not individually assigned Salesforce follow-up Tasks.
- Export associations are local. A second device does not automatically discover them or prevent a separate export there.
- CRM snapshots include available account/owner identifiers, without resolving their relationship names.
- Disconnecting or deleting an OpenWhispr note does not delete Salesforce activities.
- No CRM record creation beyond meeting activities, lead conversion, arbitrary Salesforce commands, or Salesforce Flow execution.

## Live validation checklist

- Connect, refresh an expired token, reconnect, and disconnect; confirm the displayed user and organization.
- Select among similarly named records and verify the correct Salesforce activity relationship.
- Cancel a preview and confirm nothing is written.
- Export, edit the source, and export again; confirm the same Task is updated.
- Review and omit field changes; test field length, restricted fields, validation-rule failures, and a value changed in Salesforce after preview.
- Generate a briefing with linked notes, no linked notes, and inaccessible/deleted notes; verify evidence links and missing-context wording.
- Interrupt a write and restart the app; confirm it does not automatically retry an uncertain operation.
- Switch OpenWhispr accounts or Salesforce organizations; confirm pending approvals and note associations cannot cross those boundaries.

### Briefing quality regression

Use a test Opportunity named `Test 2` with no Amount, Next Step or Account. Export a synthetic note titled `Acme — Pilot discovery` containing:

> Meeting date: 17 Nov 2026. Daniel coordinates the pilot and will send sample Opportunities and participants by 20 Nov. OpenWhispr will send security documentation by 19 Nov. Priya will review the material before the proposed kickoff; approval is still pending. Sarah will confirm success criteria and the budget approval process; no deadline was stated. Proposed kickoff: 24 Nov, subject to security approval. Proposed pilot: 8 reps for 2 weeks. Daniel proposed 50% less admin time and 90% note completeness; Sarah has not approved these targets. The $24,000 annual budget is only a planning estimate. The final budget approver is unknown.

Ask: "Brief me on this Opportunity using its linked meeting notes." Check the generated answer against the note and the actual CRM response:

- The record name links to Salesforce, with a retrieval timestamp. Meeting claims have note footnotes and the saved-activity link; the dates and evidence locations are real.
- Empty CRM fields remain missing data, not confirmation of the note's budget status or a blanket claim of agreement.
- The note names Acme, but the briefing states that the customer identity cannot be verified against `Test 2` with no Account link.
- Sarah's deadline is not invented. Priya committed to review, not to approve. Kickoff, pilot size/duration, success targets and budget remain conditional or proposed.
- Names are used where supported. An unresolved owner ID is described as a name unavailable, without guessing an owner from the meeting participants.
- Repeat with the note inaccessible or deleted, and with a CRM field not returned. State the resulting limits; do not claim to have reviewed missing evidence.

Automated tests cover scoped source retrieval, note protection, missing-field distinctions, source limits, stale/cancelled requests, evidence selection, proposal qualifiers, citations and read-only behavior. Chat-engine tests exercise the Cloud and BYOK execution paths and ensure model prose cannot replace the rendered briefing. Classification and selection still require live review; tests do not certify every model's interpretation.

Live dev-build checks, 17 Nov 2026, using OpenWhispr Cloud (underlying model not independently identified):

- Earlier prompt-only attempts failed: the assistant skipped reading the note, confused the 40-person sales team with the proposed 8-person pilot, omitted citations and missed commitments. Those failures led to mandatory source retrieval and application-rendered evidence.
- The revised normal-case briefing passed at `2026-11-17T12:35:49.743Z`. It showed exact CRM retrieval time, correct missing-field labels, cited source excerpts and source timestamps. The pilot, kickoff and budget retained their proposed/conditional wording; no deadline was invented for Sarah.
- The empty-context case passed at `2026-11-17T12:57:08.770Z` using a newly created synthetic QA Opportunity before any note export. It explicitly returned a CRM-only briefing without meeting conclusions.
- The conflicting-evidence case passed at `2026-11-17T13:15:17.174Z`. Its synthetic note contains an 8-representative/two-week decision and a 12-representative/four-week decision with no stated supersession. The answer cited both passages, marked the conflict unresolved and preserved the open question without choosing a winner. Chrome verification also confirmed the completed activity was linked to the intended QA Opportunity.
- An earlier conflicting-evidence attempt returned the safe facts/source-reference fallback because the provider supplied one conflict as an object instead of an array. The tool now accepts that equivalent single-conflict form while retaining strict schema, source-ID and duplicate-ID validation; a regression test covers both accepted and rejected inputs.
