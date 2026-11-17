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

If a network interruption leaves the outcome uncertain, check Salesforce. OpenWhispr blocks further attempts for that note/destination and operation type, including after restart or reconnect. This release has no manual reconciliation control to clear that block. It does not blindly repeat an uncertain write or promise exactly-once delivery.

## Prepare a briefing

Ask for a briefing on a particular customer or deal and select its record. The assistant reads current Salesforce details and the accessible notes associated with that exact record on this device. It uses existing note tools to read supporting conversation evidence and cites its sources. You can explicitly provide another note as context.

If there are no linked notes, the assistant can give a CRM-only briefing. It does not automatically search all your notes, traverse every related customer/deal, or predict pipeline-wide outcomes.

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
