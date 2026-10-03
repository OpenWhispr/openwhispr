# Creator-link attribution (draft)

The integration is off unless `OPENWHISPR_AFFILIATE_ENABLED=true` and `OPENWHISPR_AFFILIATE_DOMAIN` names `try.openwhispr.com` or the isolated sandbox domain. Keep sandbox and production builds separate. These are public routing settings; the full Dub key stays on the API.

The existing application protocol accepts `openwhispr://affiliate?link=<encoded creator URL>` or a validated `dub_id`. macOS open-url, cold argv and the Windows/Linux second-instance path use the same strict parser. Existing OAuth, note and invitation handlers remain separate. The candidate is held in the app's user-data directory, binds to the first validated account, and is discarded on account replacement.

Sign-in and personal upgrade surfaces offer the approved collapsed creator-link field with normal paste. The existing checkout action checks an entered link and persists its claim before checkout. The main process resolves only the configured creator URL's immediate redirect, verifies its destination and click ID, and never follows an arbitrary destination. It does not read the clipboard. Tracking disabled in Settings prevents resolving or claiming a new referral.

Both browser social and native email authentication use the existing validated auth generation. The renderer claims through the unchanged `cloudPostForAuthGeneration` transport, checks generation again after each asynchronous step, and loads server state so a creator previously saved on mobile/web wins. A saved referral is not a confirmed price offer.

Validation covers strict protocol/domain parsing, cold candidate persistence, account replacement, stale requests, one redirect, consent suppression, cross-device saved state, parallel checkout and the existing compact auth flow. Typecheck, locale consistency and lint pass locally. Eleven desktop catalogs include the field's strings. Physical macOS/Windows/Linux cold/warm launch behavior and an integrated vendor purchase remain unverified; Node/renderer tests do not prove those platform behaviors.

Do not enable production until the API, matching offers and consent/disclosure configuration are ready. A new installation cannot guarantee recovery from another browser; reopening or pasting the original creator link remains the explicit recovery path.
