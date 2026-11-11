# Wiping OpenWhispr's local data when a device is offboarded

When someone leaves, IT can remove everything OpenWhispr stored on their laptop: from inside the app with a device policy key, or with a script while the app is closed.

## Device policy keys

Both keys sit next to the other OpenWhispr device keys (macOS managed preferences for `com.gizmolabs.openwhispr`, `HKLM\SOFTWARE\Policies\OpenWhispr` on Windows, `/etc/openwhispr/device.json` on Linux).

| Key                           | Type                     | Effect                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WipeLocalDataOnLaunch`       | string                   | A token of your choice. The first time the app launches and sees a token it hasn't acted on, it wipes the local data, records the token, and restarts as a fresh install. It wipes again only when you deploy a different token. |
| `WipeLocalDataIncludesModels` | boolean, default `false` | Also deletes downloaded speech and language models. Without it they stay, so a reassigned device doesn't download them again.                                                                                                    |

On Windows, `WipeLocalDataOnLaunch` is a `REG_SZ` and `WipeLocalDataIncludesModels` a `REG_DWORD` (0 or 1).

Deploy `WipeLocalDataOnLaunch` only to the devices you are offboarding: any device that hasn't acted on the token wipes at its next launch.

The wipe runs only when the app reads a valid device policy. A policy that can't be read, or that this version rejects, never triggers it. A plain sign-out never wipes.

### What is removed

- The local database: notes, transcripts, history, dictionary, chats.
- Recordings and temporary audio files.
- Saved API keys and credentials, the sign-in token, and the keychain key that encrypted them.
- Settings, browser storage (localStorage, cookies, caches), connector logins and skills.
- The Markdown copies of notes. In a folder the user chose, only the files OpenWhispr wrote are deleted, along with folders that leaves empty; the folder itself and everything else in it stay. The app learns that folder once it has opened its window with Markdown files on.
- The local search index, logs, and runtime downloads (GPU packs, llama.cpp, yt-dlp).
- Downloaded models, only with `WipeLocalDataIncludesModels`.

### What stays

- The audit log: the `audit` folder (or your `AuditLogPath`) and its crash marker. The wipe is recorded there as `local-data.wiped`; `reason: "incomplete"` means some file could not be deleted.
- `local-data-wipe.json`, the last token acted on.

The app can't revoke tokens at Google, Microsoft or connector providers during the wipe; it deletes its local copies. Revoke the account at your identity provider as part of offboarding.

## Scripts (app closed)

Both scripts quit OpenWhispr first, then remove the same data as the in-app wipe for every user on the device, or only for the homes or profiles you name. They keep the audit log and `local-data-wipe.json` too. Since they run as root or SYSTEM, they never follow a symbolic link or junction out of a user's home, and they clean a Markdown notes folder only when it is inside that home.

**macOS** (Jamf, Kandji or Intune, as root), [`scripts/mdm/wipe-local-data-macos.sh`](../scripts/mdm/wipe-local-data-macos.sh):

```bash
sudo ./wipe-local-data-macos.sh                       # every user, models kept
sudo ./wipe-local-data-macos.sh --include-models /Users/jdoe
```

**Windows** (Intune, as SYSTEM), [`scripts/mdm/wipe-local-data-windows.ps1`](../scripts/mdm/wipe-local-data-windows.ps1):

```powershell
powershell -ExecutionPolicy Bypass -File .\wipe-local-data-windows.ps1
powershell -ExecutionPolicy Bypass -File .\wipe-local-data-windows.ps1 -IncludeModels -UserProfile C:\Users\jdoe
```

The keychain item (macOS) is removed only for the user signed in at the console. The Windows Credential Manager entry stays when the script runs as SYSTEM. With the encrypted files gone, those keys protect nothing.
