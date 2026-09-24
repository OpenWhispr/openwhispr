# Empty states implementation plan

## Base and scope

- Working branch: `codex/empty-states` at `6ecfea8c3`, created from freshly fetched `origin/main` (the same commit as `upstream/main`).
- Worktree: `/Users/saket/Documents/boseq/openwhispr-empty-states`. The existing `fix/meeting-timer-and-auto-end-summary` checkout and its untracked files remain untouched.
- The eight PNGs in `/Users/saket/Downloads/assets/page` are visual references. The twelve SVGs in `/Users/saket/Downloads/assets` are decorative component art, not runtime dependencies on Downloads. Copy them into `src/assets/empty-states/` during implementation, correcting the source filename typos (`calander`, `trascripts`) in the destination names.
- Implement the empty content regions and their actions. Keep the existing app shell, navigation, search, note editor controls, and data flows. The screenshots use a different full-page shell, so copying their frame geometry would widen the change.

## Reference-to-code map

| Reference | True empty condition and target | Illustration pair | Behaviour to keep |
| --- | --- | --- | --- |
| `transcription-history.png` | No saved transcriptions after loading: `src/components/HistoryView.tsx` | `home-history-*.svg` | Actual platform hotkey; data-retention notice; loading, discarded and populated history |
| `transcription-history.png` calendar card | Connected calendar with an empty day: `DayCard` in `src/components/UpcomingMeetings.tsx` | `home-calander-*.svg` | Separate disconnected, permission-required, loading and event-list states |
| `notes-page.png` | Empty selected private space/folder: `src/components/notes/overview/ContainerOverview.tsx` and `OverviewNoteList.tsx` | `notes-empty-*.svg` | Create note; Add existing only for folders; existing container and permission rules |
| `notes-transcript-tab.png` | Note has no transcript: `src/components/notes/NoteEditor.tsx` | `notes-empty-trascripts-*.svg` | Start recording only when editable and permitted; recording/processing guards |
| `shared-space-sidebar.png` and `notes-chat-panel.png` | Shared Spaces section has no team spaces after workspace load: `src/components/notes/SpacesTree.tsx` | `notes-shared-space-*.svg` | Capability and workspace creation permissions; grouped-workspace controls |
| `assistant-chat-panel.png` | Conversation list is empty: `src/components/chat/ConversationList.tsx` / `EmptyConversationList.tsx`; new chat canvas: `ChatView.tsx` | `chat-empty-*.svg` for the list | New Chat, search, archived-list distinction, existing input and message flow; three prompt starters only if wired to the existing send path |
| `notes-chat-panel.png` | Open note chat has no messages: `src/components/notes/EmbeddedChat.tsx` | Reuse the existing chat mark or supplied chat art only if it fits the compact panel | Floating/sidebar modes, conversation picker, input, focus and Escape behaviour |
| `dictionary-page.png` | No user dictionary words: `src/components/DictionaryView.tsx` | No dedicated SVG supplied | Add first word focuses the existing input; import remains available; search-no-match stays distinct |
| `dictionary-page-snippets.png` | No snippets: `src/components/SnippetsView.tsx` | No dedicated SVG supplied | New Snippet focuses the existing input; creation, edit and search-no-match stay distinct |

## Implementation order

1. **Asset and layout foundation.** Copy the six light/dark SVG pairs. Add one small decorative illustration component or equivalent existing pattern that selects assets using the app's `.dark` class, not `prefers-color-scheme` (manual theme overrides system theme). Give both images empty alt text and reserve their natural aspect ratio so changing themes does not shift layout. Use the existing Tailwind v4 semantic tokens, `Button`, and `PAGE_CONTENT_WIDTH_CLASS`. Keep each empty state's layout local; the existing `EmptyStateCard` is intentionally card-shaped and should not be changed globally to match borderless references.
2. **Home.** Replace only the loaded, zero-history presentation in `HistoryView`. Apply the calendar illustration inside the empty `DayCard` branch, with a compact variant for the connected/no-upcoming-events case if that branch is also shown. Keep connected, disconnected and system-audio permission states separate. Use the actual hotkey label rather than the macOS-only shortcut shown in the PNG.
3. **Notes.** Make the truly empty selected container a focused canvas in `ContainerOverview`/`OverviewNoteList`, while preserving folder-specific Add existing and note-creation actions. Gate space emptiness on `spaceNotes !== null` and tree loading to avoid a blank-state flash. In `NoteEditor`, replace the transcript card locally and retain the current recording guards. In `SpacesTree`, show shared-space art only after workspace loading and only when the shared section is actually empty.
4. **Chat.** Add the supplied illustration and copy to `EmptyConversationList`. Add the reference's three starter prompts to the new-chat canvas and connect them to the existing `handleTextSubmit` path with busy-state guards. Keep the selected-conversation/no-message state distinct. Update `EmbeddedChat` only for its empty message body, keeping the narrower floating panel usable.
5. **Dictionary and Snippets.** Rework their existing empty branches into the reference's horizontal explanatory cards. Use existing icons plus small local, token-based example artwork because no SVGs were supplied for these two surfaces. Keep entry controls, import, edit, populated lists and no-match results as they are.
6. **Copy and translations.** Reuse existing i18n keys where wording still fits. Add only necessary keys across all 11 `src/locales/*/translation.json` files. Adapt reference copy when it would assert something untrue (for example, zero saved history does not prove the user has not dictated “for a while”). No literal example dates, names or platform shortcuts from the mockups.
7. **Review and QA.** Check the diff for duplicate JSX, dead imports, raw one-off colors, changes outside empty branches, and public API changes. Run targeted ESLint/Prettier on touched files, `npm run typecheck`, `npm run i18n:check`, and `npm run build:renderer`. Inspect fresh/empty and populated states in light, dark and auto themes at a wide desktop size and a smaller window; verify keyboard focus, RTL layout, long translations and macOS/Windows/Linux hotkey labels. Exercise calendar disconnected, permission-required, connected/no-event and event-present conditions; notes private/folder/team and read-only conditions; chat new/archived/error states; and dictionary/snippet no-match states.

## Acceptance criteria and risks

- Every supplied empty-state illustration appears in its intended light or dark branch, with no Downloads path in the application.
- Empty art never appears during loading, after a fetch error, or over populated content. The current conversation-list and space-note catch paths can turn errors into empty arrays; distinguish failure from genuine emptiness where those paths are touched.
- CTAs execute existing actions and respect access/recording permissions. Decorative SVGs do not enter the accessibility tree; actionable starter cards and buttons are keyboard reachable.
- No global `EmptyStateCard`, theme token, shell, IPC or data-service change is needed unless inspection during implementation proves one necessary.
