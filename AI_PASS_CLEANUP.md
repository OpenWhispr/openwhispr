# AI Pass for desktop dictation cleanup

In a configured desktop build, open **Settings → Language Model → Dictation Cleanup**. Enable
cleanup, select **Bring Your Own Key**, and choose **Connect AI Pass**. Approve wallet
access in the browser, return to OpenWhispr, and select an AI Pass model.

AI Pass receives the transcript and the cleanup prompt. Dictation audio goes through the
transcription provider already selected in OpenWhispr. Cleanup requests use the connected
AI Pass wallet. Select **Use other providers** to restore your prior cleanup selection
or **Disconnect AI Pass** to remove the wallet connection. If cleanup fails, OpenWhispr
keeps the original dictation.

## Maintainer setup

Register a public desktop OAuth client in your own AI Pass account. You can paste this into
your coding agent and approve the setup in your browser when prompted.

> Use https://aipass.one/skills/aipass-integration/SKILL.md to register an AI Pass public OAuth
> client named OpenWhispr. Use authorization code with PKCE S256, the runtime scope
> `api:access`, and the exact loopback redirect `http://127.0.0.1:43130/auth/aipass/callback`.
> Guide me through approval in my own AI Pass account. Put the resulting public client ID
> in `AIPASS_CLIENT_ID` for the OpenWhispr desktop process. Ask before making a paid request.

For local development, add `AIPASS_CLIENT_ID` to the desktop repo's gitignored `.env`
and restart Electron. For distribution, supply the public ID in the desktop process
environment or embed it as public configuration when building the desktop app. AI Pass is
available on personal installations with system credential encryption and a configured
client. It is hidden on managed installations.

Run the OAuth and provider contract tests locally with Node 24.

```sh
node --test test/helpers/aiPassCleanup.test.js
```

The tests use a synthetic transcript and simulated AI Pass responses.
