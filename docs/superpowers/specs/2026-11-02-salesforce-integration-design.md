# Salesforce conversation export and customer briefing

Date: 2026-11-02
Status: implemented and reviewed; automated verification recorded in the plan; live Salesforce validation pending

## Purpose and agreed scope

Use Otter's Salesforce workflows as a baseline for two focused OpenWhispr experiences:

1. Save a reviewed meeting or dictated note to an existing Salesforce record, with optional reviewed Opportunity text-field updates.
2. Prepare a briefing for one selected customer or Opportunity using current Salesforce details and explicitly associated OpenWhispr conversations.

The user confirmed these two flows and deferred team administration, automatic record matching, advanced template and mapping configuration, pipeline-wide analysis, and direct Salesforce voice commands.

At design time, repository inspection found existing connector infrastructure and tests, but no Salesforce connector. Implementation now adds both flows to that infrastructure.

## Proposed defaults

These implementation defaults follow the confirmed scope:

- Desktop first, using the existing Electron connector architecture. Mobile support is a later increment.
- One Salesforce login and organization per signed-in OpenWhispr account on each device. Reuse existing connector entitlement and policy checks.
- Existing Accounts, Contacts, Leads, and Opportunities are selectable. Do not create CRM records other than the meeting activity.
- Start from a saved OpenWhispr note. A dictated conversation must first be saved as a note using the existing note workflow.
- Manual export only. No automatic exports after recording, background CRM synchronization, or bulk operations.
- One fixed extraction structure: summary, customer needs, objections, and next steps. Include only supported facts; leave missing information empty.
- Offer up to three optional Opportunity custom text-field updates per export. The user selects each destination from Salesforce metadata and reviews its proposed value. No saved mapping settings or custom prompt editor.
- Use the existing note chat and approval-card experience. Record search and selection happen within the conversation, followed by an editable export card.

## Flow 1 Save a conversation

1. The user opens a saved meeting or dictated note and asks to save it to Salesforce.
2. If needed, the user connects Salesforce from Settings → Integrations → Connectors.
3. Search existing CRM records by name or email. Results identify the object type, record name, organization, and useful distinguishing context. The user selects a specific result or supplies an exact record reference. Never infer a destination from attendees or choose the newest deal.
4. Read the selected record and validate its supported activity relationship. Prepare a summary from the note and relevant transcript evidence using existing note tools.
5. Show an activity review card with the selected record, Salesforce identity, and editable activity title and body. Users can edit the content or cancel. Optional Opportunity updates follow in a separate review card after the activity saves; display the current and proposed value for every field change, with controls to edit or omit each change.
6. Save only after the user presses Save. Record the successful Salesforce Task identifier and its relationship to the source note, then show the Salesforce activity link.
7. Exporting the same note to the same destination again offers Update existing activity. It must not silently create another Task.

### Record and content rules

- A Contact or Lead is a person destination; an Account or Opportunity is a related-record destination. Validate the actual Salesforce Task relationship rules during implementation. In this release select one destination rather than composing multiple person/deal associations.
- The Task logs a completed conversation; next steps are text within the activity, not separately assigned follow-up Tasks. Resolve a valid closed Task status from the organization's metadata instead of assuming the English label Completed.
- Store the selected destination in main-process pending state. Model output and editable card text cannot change it at commit time. Changing the destination requires a fresh preview and approval.
- Do not upload raw audio or the entire transcript. Export only the reviewed content and meeting metadata. Include a source link only when an existing authorized, usable link is available; otherwise include the source title/date. Never create a public share link to enable export.
- Only expose custom Opportunity fields that the authenticated user can read and update, are plain text or plain long-text, and are not calculated. Exclude rich text, picklists, numbers, dates, relationship fields, and standard deal stage/value/date fields. Observe each field's length limit.
- Field changes use explicit reviewed replacement only. Append, unattended overwrite, and reusable mapping policies are deferred. Re-read the destination before applying a field change; stale values require renewed review and Salesforce-side concurrency protection where supported.
- A Salesforce validation rule or missing required Task field returns an actionable failure. Do not invent values or extend this release into a general Salesforce form builder.

### Writes and correction

Activity logging and optional Opportunity updates have separate durable outcomes. Save the activity first. Only offer the field update approval after activity success is confirmed; show one card for all selected fields on that Opportunity. A field failure does not erase or recreate the saved activity. This avoids introducing a generic multi-step transaction engine into the connector framework.

Re-sync updates only the previously recorded Task, and field updates remain independently reviewed. If Salesforce changed the Task since it was last read, refresh the preview before overwriting it. Moving an existing export to a different destination, deleting exported activities, and automatic undo of earlier field changes are deferred.

Use the existing connector outcomes: confirmed success, definite failure, cancelled/not sent, and unknown. If a write times out after dispatch, do not automatically retry it. Persist its uncertain state and direct the user to check Salesforce. A later confirmed activity reference may be reconciled after validating the organization, destination, and source association. Do not claim exactly-once delivery based on a local receipt alone.

## Flow 2 Prepare a customer briefing

1. The user asks for a briefing and explicitly selects an existing Account, Contact, Lead, or Opportunity using the same search flow.
2. Retrieve a bounded current snapshot of that record. For an Opportunity, include available account name, stage, amount/currency, close date, owner, and next-step information. Omit inaccessible fields.
3. Retrieve only accessible OpenWhispr notes previously associated with this exact Salesforce record by a successful export on this device. A user may explicitly add another note as context; that does not write it to Salesforce or persist a new association.
4. Generate a briefing with CRM facts, recent conversation takeaways, outstanding next steps, and questions to clarify. Link CRM claims to the selected Salesforce record and conversation claims to their source notes and available transcript evidence.
5. Show when the CRM snapshot was retrieved, which notes were used, and whether context was truncated or unavailable. A briefing never updates Salesforce.

No automatic traversal of every contact or Opportunity under an Account. No search across the full note library based merely on a matching company name. No pipeline ranking, forecast probabilities, coaching scores, or cross-customer aggregation. If no notes are linked, provide a CRM-only briefing and let the user select additional context.

Do not reconcile contradictions silently. Identify when a meeting statement differs from the current CRM value. Missing or inaccessible context is not evidence that a customer has no activity.

## Existing architecture to reuse

| Concern                          | Existing implementation                                                                              | Salesforce addition                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector lifecycle and policy   | `src/helpers/connectors/connectorManager.js`, `connectorIpc.js`, `createConnectors.js`               | Register a Salesforce factory and its query/approval actions.                                                                                  |
| Credential ownership and refresh | `connectorCredentials.js`, `credentialStore.js`, `boundLogin.js`                                     | Bind credentials and pending operations to OpenWhispr account, Salesforce user, organization, environment, and connection generation.          |
| Browser authorization            | `src/helpers/oauthLoopbackFlow.js`                                                                   | Reuse the PKCE loopback helper after confirming registration and callback requirements.                                                        |
| Agent queries and writes         | `src/services/tools/connectors/runQueryAction.ts`, `runApprovalAction.ts`, `connectorToolModules.ts` | Add bounded record lookup/read tools, conversation export, and reviewed field-update tools. No arbitrary SOQL or generic record mutation tool. |
| Settings                         | `src/components/connectors/connectorRows.tsx`                                                        | Individual Salesforce connection row with organization identity and reconnect state.                                                           |
| Approval UI                      | `src/components/chat/ApprovalCard.tsx`, `src/types/connectors.ts`                                    | Salesforce activity preview plus a focused before/after field layout. Preserve existing connector contracts.                                   |
| Source retrieval                 | Existing note search/read and transcript tools                                                       | Resolve accessible notes by stored association and retrieve relevant transcript passages.                                                      |
| Receipts and persistence         | `src/helpers/connectors/actionLog.js`, `src/helpers/database.js`                                     | Add a narrow export association store; receipts alone do not currently hold the note-to-record relationship.                                   |
| Availability and tool history    | `src/config/agentCapabilities.ts`, existing chat tool registration/history                           | Register Salesforce capability, source handling, held delivery, and honest saved/failed/unknown outcomes.                                      |

The current query normalizer permits 20 items, 16 fields per item, and 1,000 characters per string. Keep Salesforce results bounded and report truncation. Do not increase shared limits just to inject entire CRM records or transcripts.

Connector queries are already treated as untrusted third-party data. Keep that boundary: Salesforce record text and note content cannot authorize writes or expand search scope.

## Local export associations

Persist the minimum needed to update an export and find its source later: OpenWhispr account, local source-note identifier, Salesforce organization/environment, destination object/id, Task id, durable operation reference/state, and last confirmed export time. Keep the existing receipt mechanism for individual approvals.

- Uniqueness is per account, organization/environment, source note, and selected destination.
- Reconnect to the same organization preserves confirmed associations; switching organization never exposes or reuses them for the new organization.
- Check note ownership/access on every read. A stored association never grants access to a deleted note or a note the user can no longer read/export.
- Deleting a note or disconnecting Salesforce does not delete remote CRM activities.
- Associations remain local in this release. A second device cannot automatically discover these associations or prevent a duplicate export made there. Clearly describe this limitation in product help; cloud synchronization is a later increment.
- Do not store OAuth secrets or full CRM responses in receipts, model history, or this association table. Clear account-owned associations on account deletion/reset using existing lifecycle patterns.

## Salesforce setup and external dependencies

Before live integration testing, register an appropriate Salesforce OAuth client and provide its non-secret client identifier, authorized callback, and a test organization with representative records and writable text fields. Never embed a client secret in the desktop application or modify `.env` files as part of implementation.

Proposed authentication is authorization code with PKCE, a registered fixed localhost callback, and refresh-token support. Salesforce documents this desktop pattern for Data Loader; it is supporting evidence, not proof that an OpenWhispr registration is already configured. Validate current external-client-app distribution, target-org installation/consent requirements, token rotation, and callback behavior before release. Existing Linear relay behavior is not evidence that Salesforce needs the same relay.

Use individual-user API permissions and live object/field metadata. Preserve Salesforce access restrictions. A single registered client may still require Salesforce-admin installation/approval in a customer's organization; deferring OpenWhispr team administration does not remove that dependency.

Support a test/sandbox configuration for validation without introducing an end-user multi-org management interface. Confirm allowed Salesforce origins and tenant URLs before attaching tokens; do not accept arbitrary model-supplied URLs as API destinations.

## Acceptance checks

1. Connecting, refresh, reconnect, disconnect, and account/org switches follow existing connector binding rules; stale approval cards cannot write under a different login.
2. Ambiguous search results require selection. No write occurs during record search, briefing, extraction, preview, or cancellation.
3. A selected Contact, Lead, Account, or Opportunity receives one valid reviewed meeting activity. Unsupported permissions, relationships, or required fields produce useful failures.
4. Each optional Opportunity update displays the actual destination field and before/after values. Invalid types, inaccessible fields, stale values, and over-length text are rejected without truncating approved content.
5. A normal repeat export updates the known Task. Double-clicks and concurrent approvals cannot create duplicate writes. Uncertain writes remain uncertain across restart and are not retried blindly.
6. If the activity saves but a field update fails, the result distinguishes both outcomes and preserves the successful activity association.
7. A briefing uses only the chosen record and accessible linked or explicitly selected notes, cites its evidence, and handles missing notes, restricted fields, conflicting facts, and bounded results honestly.
8. Existing connector behavior and policy/entitlement gates remain intact across desktop platforms. New UI strings follow the repository's localization conventions.

Tests already exist under `test/helpers/connectors`, `test/services`, `test/components`, and `test/config`. Add meaningful tests alongside those patterns for the cases above, including the new association-store behavior. Run the relevant suites, `npm test`, type checking, and linting after implementation. Complete a separate live test in a non-production Salesforce organization; fixtures cannot verify OAuth registration or organization-specific Salesforce validation rules.

## Delivery order

1. Confirm Salesforce app registration and authentication assumptions; add the individual connector and bounded record lookup.
2. Complete reviewed activity export, durable associations, and correction of a known export.
3. Add reviewed Opportunity text-field changes with independent outcomes.
4. Add the selected-record briefing using those associations and existing note retrieval.
5. Verify the two complete user journeys in a test organization and document setup and limitations.

## Reference documentation

Implementation limits: the initial CRM snapshot returns available account/owner identifiers without resolving relationship names. Uncertain writes remain durably blocked; manual reconciliation is not implemented. See `docs/integrations/salesforce.md` for setup, current behavior, and live validation steps.

- [Otter Salesforce setup](https://help.otter.ai/hc/en-us/articles/15671309340183-Connect-Salesforce-with-Otter-ai): meeting activity logging and connection prerequisites.
- [Otter manual export](https://help.otter.ai/hc/en-us/articles/38654669804567-Manually-export-a-conversation-to-Salesforce): explicit record selection and updating exported notes.
- [Otter field mapping](https://help.otter.ai/hc/en-us/articles/29730579913751-CRM-Integration-Sync-Insights-to-Custom-Fields): Opportunity custom text fields. This release deliberately uses per-export selection instead of its configurable mapping system.
- [Otter Salesforce AI Chat](https://help.otter.ai/hc/en-us/articles/33243919891351-Otter-AI-Chat-with-Salesforce-connector): CRM and conversation context. This release limits the experience to one selected record.
- [Salesforce desktop OAuth example](https://developer.salesforce.com/docs/platform/data-loader-impl/guide/loader-eca-oauth-pkce.html): registered localhost callback, PKCE, and API/refresh scopes for Data Loader.
- [Salesforce sObject Describe](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-describe.html): live object and field metadata.
