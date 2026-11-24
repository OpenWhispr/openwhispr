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

If something can't be deleted (a file another program holds open, a note the app can't read), or the app can't record the wipe in its data folder, OpenWhispr doesn't open. It says it couldn't remove all of its data, lists what stayed, records the attempt with `reason: "incomplete"`, and tries the whole wipe again at every launch until nothing is left. Once the attempt is on record, that holds even if you remove the token or the policy can't be read meanwhile, and each try takes the models and keeps the `AuditLogPath` the first one did, unless you deploy a new token. The token counts as acted on, and a removal's notice shows, only then.

### What is removed

- The local database: notes, transcripts, history, dictionary, chats.
- Recordings and temporary audio files.
- Saved API keys and credentials, the sign-in token, and, in the production app, the keychain key that encrypted them (staging and dev builds share that key, so they leave it).
- Settings, browser storage (localStorage, cookies, caches), connector logins and skills.
- The Markdown copies of notes. In a folder the user chose, only the files the app's database records OpenWhispr writing there, and that still hold what it wrote, are deleted, along with folders that leaves empty; the folder itself, a file edited since, and everything else in it stay. A file the app can't reach or read, a folder that now leads elsewhere through a link, or a database it can't read, leaves the wipe incomplete, and the app keeps its database until it finishes, so the next try can still tell which files are its own. A damaged database keeps the wipe from ever finishing; then delete the user's OpenWhispr data folder by hand, along with the note files OpenWhispr wrote in their notes folder.
- The local search index, logs, and runtime downloads (GPU packs, llama.cpp, yt-dlp).
- Downloaded models, only with `WipeLocalDataIncludesModels`.

### What stays

- The audit log: the `audit` folder, or the audit files (`meeting-audit-<user>-<date>.jsonl`) in your `AuditLogPath`, and its crash marker. An `AuditLogPath` inside a folder the wipe empties keeps only those files; everything else in that folder still goes. The wipe is recorded there as `local-data.wiped`, with `trigger: "device-policy"`, `"workspace-removal"` or, for the scripts below, `"script"`; `reason: "incomplete"` means some file could not be deleted. A line that can't be written, or that a network `AuditLogPath` doesn't take within 5 seconds, is written at a later launch, with the time of the wipe.
- `local-data-wipe.json`, the last token acted on.
- On macOS, the Globe key's crash marker, which the next launch needs to put the user's Globe key setting back.

The app can't revoke tokens at Google, Microsoft or connector providers during the wipe; it deletes its local copies. Revoke the account at your identity provider as part of offboarding.

## Removal from the workspace

When an admin removes someone from a workspace with a policy (one at a time or in bulk), or your identity provider deprovisions them through directory sync, every device that workspace managed for them wipes the same data at its next policy check, even if another workspace still manages them. A device needs one policy check on this version before the removal to know which workspaces manage it. It then opens as a fresh install and shows "Your organization removed this device's OpenWhispr data." The audit log records it with `trigger: "workspace-removal"`.

Nothing is wiped when a member leaves the workspace on their own, signs out, or their session expires, when the directory moves an account to a new email address, or on a device that workspace never managed. A member who rejoins before a device checks in keeps that device's data. A device keeps downloaded models unless it also has `WipeLocalDataIncludesModels`, which works here without a token.

## Scripts (app closed)

Both scripts remove the in-app wipe's files for every user on the device, or only for the homes or profiles you name. The macOS script first quits OpenWhispr for the user whose home it cleans, never another user's; the Windows script skips a signed-in user's profile (see below), so OpenWhispr can't be running in one it cleans. They keep the `audit` folder, `local-data-wipe.json` and the Globe key marker too, and, as the app does, the audit files of an `AuditLogPath` inside the app's data folder. Each records its wipe in the user's audit log with `trigger: "script"`, in your `AuditLogPath` or else the kept `audit` folder: the macOS script writes it as the home's owner, so a home whose account no longer exists gets no line, and the Windows script uses `AuditLogPath` only while no one is signed in, and only when that folder already exists with no junction or link on its way (it never creates it). A Windows profile whose account no longer exists still gets a line, with `deviceUser: "unknown"`. Since they run as root or SYSTEM, they never follow a symbolic link or junction out of a user's home.

They also clean a Markdown notes folder inside that home or profile as the app does, from the app's database (on Windows through the SQLite built into Windows 10 and 11). A note file they can't read or remove, a database they can't read, or a notes folder that now leads elsewhere, fails the run and keeps the database, so a second run can still tell which files are the app's; a damaged database fails every run, so delete that user's OpenWhispr data folder by hand, along with the note files OpenWhispr wrote. A notes folder outside the home or profile is left as it is, with its files, which only the in-app wipe removes.

Before removing anything in a home or profile that has OpenWhispr data, they mark it with `local-data-wipe.pending`: if the run is cut short or can't finish, and the user opens OpenWhispr before a second run, the app finishes the wipe before it opens and records it with `trigger: "script"`. That wipe removes models only when `WipeLocalDataIncludesModels` is set, so run the script again to remove them. A run that finishes removes the mark. A home or profile that can't be marked, such as one whose data folder is reached through a link, is skipped. (A macOS home whose account no longer exists isn't marked, since no one can open the app there.) A file they can't remove is reported and the rest is still removed. Either way the script exits with an error so your MDM tool shows the device as failed. The Windows script looks only in `<profile>\AppData\Roaming`, so it can't reach AppData that Folder Redirection moved to a share; use `WipeLocalDataOnLaunch` there.

**macOS** (Jamf, Kandji or Intune, as root), [`scripts/mdm/wipe-local-data-macos.sh`](../scripts/mdm/wipe-local-data-macos.sh):

```bash
sudo ./wipe-local-data-macos.sh                       # every user, models kept
sudo ./wipe-local-data-macos.sh --include-models /Users/jdoe
```

In a Jamf Pro policy, put `--include-models` and the homes in parameters 4 and up, one per parameter; the script skips the three values Jamf passes first, and parameters left blank.

**Windows** (Intune, as SYSTEM), [`scripts/mdm/wipe-local-data-windows.ps1`](../scripts/mdm/wipe-local-data-windows.ps1):

```powershell
powershell -ExecutionPolicy Bypass -File .\wipe-local-data-windows.ps1
powershell -ExecutionPolicy Bypass -File .\wipe-local-data-windows.ps1 -IncludeModels -UserProfile C:\Users\jdoe
```

It needs Windows PowerShell 5.1, which Intune uses, in full language mode. Under PowerShell 7, or in the constrained language mode an AppLocker or WDAC policy can impose, it stops before removing anything. A note file that is a link or a cloud placeholder (OneDrive Files On-Demand) fails the run like one it can't read.

Unlike the in-app wipe:

- The keychain item and temporary files (macOS) are removed only for the user signed in at the console. The Windows Credential Manager entry stays when the script runs as SYSTEM. With the encrypted files gone, those keys protect nothing.
- The Windows script also cleans the device-wide fallback folders (`%ProgramData%\OpenWhispr`, `C:\OpenWhispr`), even when you name profiles, and first. The app puts files there only when the user's temp or cache folder path has spaces or non-ASCII characters, which by default means the profile path has them, so while the script can't clean them, such a profile stays marked as unfinished.
- On macOS a user's files are removed as that user, so a link swapped in while the script runs can't reach anything they couldn't delete. SYSTEM can't do the same on Windows, so the Windows script skips a profile whose user is signed in, and the shared `%ProgramData%\OpenWhispr` and `C:\OpenWhispr` folders, when they exist, while any user is, says so, and exits with an error. If you deployed a `WipeLocalDataOnLaunch` token, the app wipes itself at its next launch; run the script again once the users have signed out. On macOS a root-owned folder in `/Users`, such as `/Users/Shared`, is skipped and reported, and the script exits with an error; a home whose account no longer exists is cleaned as root.
- Launch at login is left as it is; uninstall the app, or remove its login item with your MDM tool.

Neither the app nor the scripts remove the OpenWhispr CLI's own settings (`~/.openwhispr/cli-config.json`), which belong to the separately installed CLI. Revoke the account's API keys as part of offboarding.
