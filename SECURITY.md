# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.6.x   | :white_check_mark: |
| < 1.6   | :x:                |

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/OpenWhispr/openwhispr/security/advisories/new)
to submit a report. You can also email security@openwhispr.com.

We will acknowledge your report within **48 hours** and aim to release a fix
within **7 days** for critical issues.

## Scope

The following are in scope:

- Remote code execution via crafted audio files or transcription output
- Privilege escalation through native binaries (key listeners, paste helpers)
- Credential exposure (API keys, OAuth tokens, database credentials)
- Cross-site scripting (XSS) in the Electron renderer
- Insecure IPC between main and renderer processes
- Supply chain attacks via dependencies or native compilation

Out of scope:

- Issues requiring physical access to an already-unlocked machine
- Denial of service against the local application
- Social engineering

## Security Model

- **Local-first audio processing** — Audio is transcribed on-device using
  whisper.cpp or nvidia parakeet. Recordings are not sent to external servers unless explicitly
  configured by the user.
- **Credential storage** — API keys provided by users (BYOK) are stored in
  plaintext in the app's `userData` directory (`.env` file and Electron
  `localStorage`). They are readable by any process running as the current OS
  user. Migrating to Electron's `safeStorage` API for platform-native
  encryption is tracked in [#532](https://github.com/OpenWhispr/openwhispr/issues/532).
- **Native binaries** — Platform-specific helpers (key listeners, paste
  utilities) are compiled from source during the build process.
- **Context isolation** — The Electron renderer runs with context isolation
  enabled and a restricted preload bridge.

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit
reporters in the changelog (unless they prefer to remain anonymous).
