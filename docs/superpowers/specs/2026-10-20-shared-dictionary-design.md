# Shared Dictionary — Design

Date: 2026-10-20
Status: draft for review

## Why

A new member who joins a team today has to add the team's jargon, product names, acronyms and colleagues' names to their dictionary one word at a time. Most never do, so their first weeks of dictation and meeting notes misspell exactly the words their team uses most. A shared dictionary gives a new member the team's words on their first day, with no work on their part, and keeps those words correct for everyone afterwards.

The idea comes from Wispr Flow's shared dictionary (Dictionary page with All / Personal / Shared with team; any member can edit; shared to the whole organization or a department). We copy its permission model and add per-space lists from day one.

## Goals

- A member of a Business or Enterprise workspace automatically gets the shared words of their workspace and of every space they belong to, in dictation and meeting notes, without accepting or importing anything.
- Words can be shared to the **whole workspace** or to **one space**. One word can be shared to several lists.
- Any member of a list can add, edit and delete its words. No approval step.
- A member can hide a shared word **for themselves only**.
- A personal word can be moved into one or more shared lists, singly or in bulk.
- A new member is told once that team words arrived.
- The feature is visibly present but locked for everyone else (no workspace, or a workspace not on Business/Enterprise), using the Integrations upsell pattern.

## Non-goals (v1)

- Shared snippets (snippets stay personal).
- Admin approval, review queues, or read-only lists.
- An org policy switch to turn the feature off, or admin-portal views of shared words.
- Sharing to a team (teams are rosters; spaces are the content unit).
- Exposing shared words through the public `/api/v1/dictionary` API or the CLI.
- Managing shared words on mobile (see Mobile below: apply-only).

## Anti-goals

- A new member has to do anything (accept, import, opt in) before shared words apply.
- Shared words crowd a member's own personal words out of the transcription prompt.
- Removing a member, or deleting their account, deletes words the team relies on.
- A workspace downgrade silently destroys a curated list.
- A member who is removed keeps receiving, or keeps a copy of, the team's words.

## Decisions (made with the product owner)

### Who gets what

- Plan gate: the workspace's plan is `business` or `enterprise` with status `active` or `trialing`. Enforced on the server for every shared-dictionary read and write, and mirrored in the UI. Pro and Free workspaces get the locked state.
- Scopes: a shared list is either the **workspace list** ("Everyone at {workspace}") or a **space list** (one per space). Every member of a workspace belongs to its workspace list.
- The words that apply to a member's dictation are: their personal words, plus the words of every space list they belong to, plus their workspace list, minus any shared word they have hidden.
- Only the **active workspace** (`activeWorkspaceId`) contributes shared words. A member of two workspaces gets the active one's words. *(Builder's call recorded below.)*
- "Belongs to a space" means a **direct space member or a member of a team assigned to the space**. Workspace owners and admins do **not** get a space's words just because their role gives them access to every space. The same membership decides:
  - which space lists appear in the member's left column and share picker;
  - who can read and write a space list;
  - whose dictation a space list applies to.

  An admin who wants to edit another space's list joins that space. Demoting an admin changes nothing here, since their role was never the source.

### Permissions

- Any member of a list can add, edit and delete its words, including words others added. Same as Wispr.
- Deleting from a shared list deletes it for everyone in that list, with a confirmation and an Undo.

### Conflicts between personal and shared words

- Personal and shared words are merged into one hint list; duplicates that differ only in case are collapsed.
- When a member's personal spelling and a shared spelling differ only in case, the member's personal spelling is the one used for them.
- "Share" **moves** a personal word into the chosen list(s): it leaves the Personal list. If a chosen list already has the word (case-insensitive), that list is shown as "Already shared" and can't be picked.
  - Under the hood the personal entry is never deleted. It's marked as moved (`shared_at`) and kept as the sharer's own fallback. It stays out of the Personal list while its shared copy exists, and keeps applying for the sharer at personal priority. That way no device, old app version or edge case (no active workspace, a paused workspace, a teammate deleting the shared copy) can make the sharer lose a word they owned.
  - If the shared copy goes away, the word reappears in the sharer's Personal list.
  - If the sharer hides the word or deletes it for everyone, their fallback is removed too.
- A teammate adding a shared word that a member already has in Personal never touches the member's personal copy, so a later team delete doesn't remove it from them.

### Priority when the prompt is capped

Transcription engines read a limited dictionary prompt (Whisper-family about 550 characters effective, Groq 890; see `src/utils/dictionaryPromptCap.js`). The merged list is prioritised **personal → space words → workspace words**, and the highest-priority words must be the ones that survive. Note the existing mechanics when designing this: the client trim (`trimDictionaryPrompt`) keeps the **head** of the string, while Whisper decoders keep the **tail** of what they receive. The builder must arrange what is sent so the highest-priority words survive both. Snippet triggers and the agent name keep their current treatment.

### Hiding a shared word

- "Hide for me" is per user, synced across that user's devices, and tied to the specific shared entry: if a teammate edits the word, it stays hidden.
- If the shared entry is deleted, the hide is removed with it.
- Hidden words appear under a **Hidden** entry in the Dictionary's left column, with Unhide.
- Works for both workspace and space words.

### Member removal and account deletion

- Shared words stay in the list when the member who added them leaves. Their attribution reads "Former member".
- On account deletion, the word stays and its attribution is cleared (shown as "Former member").
- A removed member stops receiving the list's words on their next sync, and their local copy of those words is removed. Their personal words are untouched.
- Losing access to a space (removed from the space or its team) works the same way for that space's list.

### Downgrade

- When a workspace drops below Business, its shared words **stop applying** to dictation, are kept on the server, become read-only in the UI, and apply again on upgrade.

### New-member notice

- A one-time toast after the first sync that brings in shared words for a workspace: "{count} team words added — {workspace}'s shared words now apply to your dictation and meeting notes", with **View words** (opens Dictionary → All shared) and **Dismiss**.
- No in-page intro card.

## Mobile (apply-only)

Decided: mobile applies shared words but doesn't manage them.

- The mobile app pulls the active workspace's shared words and the member's hides, and merges them into its hint list (`openwhispr-mobile/src/lib/dictationHints.ts`) with the same priority and dedupe rules as desktop. That covers in-app dictation, keyboard dictation (the keyboard extension reads the dictionary through app-group storage, so the merged list has to reach it), and meeting notes.
- Hidden words, paused (downgraded) words and lost access behave as on desktop.
- Mobile has no list picker, sharing, editing or hiding of shared words. The mobile Dictionary screen gets one read-only line: "{n} team words from {workspace} also apply. Manage them on desktop." *(Builder's call on exact placement.)*
- Mobile's own personal-word sync must handle a personal word that was moved into a shared list without the member losing it. It arrives as a shared word in the same sync.

## Screens

Mockups (local, not committed): `.superpowers/brainstorm/25375-1792486893/content/` — `page-layout-v3b.html`, `share-and-join.html`, `multi-select.html`, `action-bar-position.html`, `new-member-moment-v2.html` (toast only is approved), `gated-states-v3.html`.

### Dictionary page layout

Inside the existing Dictionary tab of `DictionaryView.tsx` (the Dictionary / Snippets pill tabs stay):

- **Left column** (list picker), with a count on each entry:
  - All words: everything that applies to the member's dictation
  - Personal
  - "Shared" group label, then All shared, Everyone at {workspace}, and one entry per space the member belongs to
  - a divider, then Hidden
- **Toolbar, top right:** Search (filters the open list), Sort (A–Z, Z–A, newest first, oldest first; remembered per device), and Sync (pulls now; spins while syncing; tooltip "Synced {time} ago").
- **Add field** at the top of the list area always names its target list ("Add a word… to Engineering ▾"). The target defaults to the open list. On All words / All shared / Hidden it defaults to the last list used. Personal is always a valid target.
- **Rows** are 38px tall with generous card padding. In mixed views (All words, All shared), each shared row carries a small badge naming its list. In a single list, rows show who added the word ("You", a name, or "Former member").
- **Row hover icons, with tooltips:**
  - Personal row: Share (people icon), Edit, Delete.
  - Shared row: Edit, Hide for me (crossed-out eye), Delete for everyone (the only red icon).
  - Hidden row: Unhide.
- The existing agent-name row, bulk import, export, clear-all and prompt-limit notice keep working. Clear-all and export apply to Personal only.

### Sharing

- **One word:** the Share icon opens a popover titled "Share "{word}" with". It lists Everyone at {workspace} and each of the member's spaces, each with a member count and a checkbox. A list that already has the word is disabled and marked "Already shared". The footer says "Moves it out of Personal" and has a Share button.
- **Several words:** select rows (below), then use "Share with… ▾" in the action bar, which opens the same picker.

### Multi-select

- There is no separate select mode. Space for a checkbox is reserved at the left of every row, and an empty checkbox fades in on hover.
- Once one row is ticked, every row shows its checkbox and the hover icons hide. Shift-click ticks a range, ⌘A selects all and Esc clears.
- A dark action bar **floats pinned to the bottom of the list's scroll area** and stays visible while scrolling. The list gets bottom padding so the last row is never covered.
  - Personal: "{n} selected · Select all {total} · Delete · Share with… ▾ · ✕"
  - Shared list: "{n} selected · Select all {total} · Hide for me · Delete for everyone · ✕"

### Blocked states (Integrations pattern)

These reuse `UpsellBar` from `src/components/integrations/IntegrationsPane.tsx` and the dimmed-and-locked row treatment from `ConnectorsSection.tsx`. The upsell bar sits at the top of the Shared views, with the content dimmed below it (`opacity-60`) and a Lock icon on each row and on "All shared" in the left column.

1. **Not in a workspace:**
   - Bar: "Shared dictionaries are included with Business. Share your team's jargon, product names and acronyms with everyone." + View plans.
   - Dimmed rows: "Everyone in your workspace" and "A list per space".
2. **Workspace not on Business (owner or admin):**
   - Bar: "…Upgrade {workspace} so everyone gets the same words." + View plans.
   - Dimmed rows: the real workspace list and spaces, with member counts.
3. **Downgraded, with words kept:**
   - Bar: "{workspace}'s {n} shared words are paused. Upgrade to Business to use them in dictation again." + View plans.
   - Dimmed rows with word counts.
4. **Member, workspace not on Business:**
   - Bar: "…Ask an admin to upgrade {workspace}."
   - No button.

**Empty but available list** (not blocked): "No words in {list} yet. Add the terms this team uses, or share some from your personal list. Everyone in {list} ({n}) will get them." Buttons: **Import a list** (the existing bulk import, aimed at this list) and **Share from Personal** (opens Personal in select mode).

## Architecture (decided parts)

- **Server is the source of truth for shared words.** Shared entries live in the API's Postgres, scoped by `workspace_id` plus a nullable `space_id`, where null means the workspace list. They are kept separate from the per-user `dictionary_entries` table. Uniqueness is case-insensitive per list, with the same tombstone and upsert behaviour as personal entries.
- **Hides** are a per-user server table keyed by user and shared entry.
- **Access** reuses the space access helpers in `openwhispr-api/lib/space-access.ts` for space lists and `workspace_members` for the workspace list, plus the plan gate above.
- **Shared-dictionary writes are exempt from `cloudBackupAllowed`**, as notes and folders are (`lib/policy-enforce.ts`). Otherwise members of managed workspaces could never contribute.
- **Sharing is one server call:** creating the shared entries and tombstoning the personal entries happens atomically, so a word is never lost or duplicated partway through.
- **Desktop sync** follows the existing dictionary sync (`SyncService.syncDictionary`, `DictionaryService.ts`): an `(updated_at, id)` delta pull with tombstones, last writer wins. Lost access and downgrade purge or pause the local copy.
- **Merging happens on the desktop.** The server never reads the dictionary at transcription time; clients send `customDictionary` with each request (`api/transcribe.ts`). So the desktop builds the merged, prioritised hint list. Every consumer of `getDictionaryHintWords` (STT prompt, keyterms, keywords channel, cleanup-model dictionary suffix, echo filter) uses it.
- **i18n:** every new string goes in all locale files.

## Builder's calls (not discussed; change freely)

- Only the active workspace's shared words apply.
- Membership checks should reuse `getUserSpaceGrants`-style queries rather than `getAccessibleSpaceIds` as written, because the latter grants admins every space (see the decision under "Who gets what").
- Trialing Business and Enterprise workspaces count as entitled.
- Edit conflicts are last-writer-wins. Renaming to a word the list already has is refused with "Already in {list}".
- Undo after "Delete for everyone" restores the tombstoned entries. Tombstones are purged after 30 days, as personal ones are.
- When a space is deleted, its list stops applying. If the space is restored, the list comes back.
- A size cap per list, so one list can't grow without bound (personal has 5,000 per user). It is 2,000 per list, enforced under concurrent writes and on restore.
- The correction learner doesn't add a word to Personal when a shared list the member receives already has it.
- The new-member toast shows once per account and workspace on each device, keyed locally. A second device may show it once more.
- Hidden words stay out of every hint consumer, including the cleanup model. That includes the meeting keyterm path in `meetingRecordingStore.ts`, which reads `customDictionary` directly.
- **Snippet triggers** rank with personal words, ahead of all shared words, since they're the member's own. The agent name keeps its current always-recognised treatment. Full order: personal words and snippet triggers, then space words, then workspace words.
- **Downgrade reads:**
  - The list endpoint still returns a downgraded workspace's words, flagged `paused`. Writes are refused.
  - The desktop keeps its local copy but leaves it out of every hint consumer.
  - All shared shows the dimmed per-list counts (blocked state 3). Opening a list shows its words dimmed and read-only.
  - A member who joins during a downgrade receives them paused too.
- **Voice assistant `update_dictionary` tool** (`src/services/tools/dictionaryTool.ts`):
  - "Add" always goes to Personal.
  - "Remove" on a shared word becomes **Hide for me**, never Delete for everyone, and the assistant says so. A spoken command must never delete a teammate's word for the whole team.
- **Sync timing:** shared words and hides sync whenever the member is signed in and entitled, like team spaces do. They don't depend on the cloud-backup setting.

## Constraint: clients that don't know about shared lists

Older desktop builds, older mobile builds and the public v1 API must never lose a word when someone shares it. This is met by never tombstoning a moved personal entry (see "Conflicts between personal and shared words"). Old clients simply keep it as a personal word. New clients backfill `shared_at` once by re-reading their personal list.

## Constraint: company SSO

A workspace that requires company SSO applies that rule to every shared-dictionary read, write and hide, for the workspace list as well as space lists. The owner is exempt, as elsewhere.

## Constraint: long-offline devices

Tombstones are purged after 30 days, so a device whose last sync is older than that must re-download the lists in full instead of applying a delta.

## Open questions for the product owner

None. Everything raised by the builder check was answered or settled above.
