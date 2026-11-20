# Wiping OpenWhispr's local data when a device is offboarded

When someone leaves, IT can remove what the OpenWhispr desktop app stored on their laptop: from inside the app with a device policy key, or with a script while the app is closed.

## Device policy keys

Both keys sit next to the other OpenWhispr device keys (macOS managed preferences for `com.gizmolabs.openwhispr`, `HKLM\SOFTWARE\Policies\OpenWhispr` on Windows, `/etc/openwhispr/device.json` on Linux).

| Key                           | Type                     | Effect                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WipeLocalDataOnLaunch`       | string                   | A token of your choice. The first time the app launches and sees a token it hasn't acted on, it wipes the local data, records the token, and restarts as a fresh install. It wipes again only when you deploy a different token. |
| `WipeLocalDataIncludesModels` | boolean, default `false` | Also deletes downloaded speech and language models. Without it they stay, so a reassigned device doesn't download them again. On its own, without a token, it applies to the wipe a workspace removal starts.                    |

On Windows, `WipeLocalDataOnLaunch` is a `REG_SZ` and `WipeLocalDataIncludesModels` a `REG_DWORD` (0 or 1).

Deploy `WipeLocalDataOnLaunch` only to the devices you are offboarding: any device that hasn't acted on the token wipes at its next launch.

The wipe runs only when the app reads a valid device policy. A policy that can't be read, or that this version rejects, never triggers it. A plain sign-out never wipes.

### What is removed

- The local database: notes, transcripts, history, dictionary, chats.
- Recordings and temporary audio files.
- Saved API keys and credentials, the sign-in token, and, in the production app, the keychain key that encrypted them (staging and dev builds share that key, so they leave it).
- Settings, browser storage (localStorage, cookies, caches), connector logins and skills.
- The Markdown copies of notes. In a folder the user chose, only the files the app's database records OpenWhispr writing there, and that still hold what it wrote, are deleted, along with folders that leaves empty; the folder itself, a file edited since, and everything else in it stay. A file the app can't read, or a folder that now leads elsewhere through a link, leaves the wipe incomplete.
- The local search index, logs, and runtime downloads (GPU packs, llama.cpp, yt-dlp).
- Downloaded models, only with `WipeLocalDataIncludesModels`.

### What stays

- The audit log: the `audit` folder (or your `AuditLogPath`, even inside the app's data folder) and its crash marker. The wipe is recorded there as `local-data.wiped`; `reason: "incomplete"` means some file could not be deleted.
- `local-data-wipe.json`, the last token acted on.
- On macOS, the Globe key's crash marker, which the next launch needs to put the user's Globe key setting back.

A wipe that leaves something behind tries once more at the next launch, which follows at once, and is then recorded as done, so a file that can never be deleted doesn't wipe the fresh install at every launch. Each try writes its own audit line.

The app can't revoke tokens at Google, Microsoft or connector providers during the wipe; it deletes its local copies. Revoke the account at your identity provider as part of offboarding.

## Removal from the workspace

When an admin removes someone from a workspace with a policy (one at a time or in bulk), or your identity provider deprovisions them through directory sync, every device that workspace managed for them wipes the same data at its next policy check, even if another workspace still manages them. A device needs one policy check on this version before the removal to know which workspaces manage it. It then opens as a fresh install and, once nothing was left behind, shows "Your organization removed this device's OpenWhispr data." The audit log records it with `trigger: "workspace-removal"`.

Nothing is wiped when a member leaves the workspace on their own, signs out, or their session expires, when the directory moves an account to a new email address, or on a device that workspace never managed. A member who rejoins before a device checks in keeps that device's data. A device keeps downloaded models unless it also has `WipeLocalDataIncludesModels`, which works here without a token.

## Scripts (app closed)

Both scripts remove the in-app wipe's files for every user on the device, or only for the homes or profiles you name. The macOS script first quits OpenWhispr for the user whose home it cleans, never another user's; the Windows script skips a signed-in user's profile (see below), so OpenWhispr can't be running in one it cleans. They keep the audit log, `local-data-wipe.json` and the Globe key marker too, and record each cleaned home or profile in its user's audit log as `local-data.wiped` with `trigger: "script"`: in `AuditLogPath` when you set one (on Windows only while no one is signed in, as other users may write there), otherwise in the user's `audit` folder. The macOS script records nothing for a home whose account was deleted, since only root could write there. Since they run as root or SYSTEM, they never follow a symbolic link or junction out of a user's home. The macOS script also cleans a Markdown notes folder inside that home as the app does, from the app's database; a note file it can't read fails the run and keeps the database, so running it again can finish. The Windows script leaves a notes folder the user chose alone, since Windows has no tool to read that database; to clear one, deploy `WipeLocalDataOnLaunch` instead of running the script, since once the script has deleted the database the app can no longer tell which files there are its own. A file they can't remove, or a data folder they skip because it's reached through a link, is reported, the rest is still removed, and the script exits with an error so your MDM tool shows the device as failed. The Windows script looks only in `<profile>\AppData\Roaming`, so it can't reach AppData that Folder Redirection moved to a share; use `WipeLocalDataOnLaunch` there.

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

Unlike the in-app wipe:

- The keychain item and temporary files (macOS) are removed only for the user signed in at the console. The Windows Credential Manager entry stays when the script runs as SYSTEM. With the encrypted files gone, those keys protect nothing.
- The Windows script also cleans the device-wide fallback folders (`%ProgramData%\OpenWhispr`, `C:\OpenWhispr`), even when you name profiles. The app creates them only when a profile path has spaces or non-ASCII characters.
- On macOS a user's files are removed as that user, so a link swapped in while the script runs can't reach anything they couldn't delete. SYSTEM can't do the same on Windows, so the Windows script skips a profile whose user is signed in, and the shared `%ProgramData%\OpenWhispr` and `C:\OpenWhispr` folders, when they exist, while any user is, says so, and exits with an error. If you deployed a `WipeLocalDataOnLaunch` token, the app wipes itself at its next launch; run the script again once the users have signed out. On macOS a root-owned folder in `/Users`, such as `/Users/Shared`, is skipped and reported, and the script exits with an error; a home whose account no longer exists is cleaned as root.
- Launch at login is left as it is; uninstall the app, or remove its login item with your MDM tool.

Neither the app nor the scripts remove the OpenWhispr CLI's own settings (`~/.openwhispr/cli-config.json`), which belong to the separately installed CLI. Revoke the account's API keys as part of offboarding.
