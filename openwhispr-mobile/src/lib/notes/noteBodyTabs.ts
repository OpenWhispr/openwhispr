export type NoteBodyView = 'enhanced' | 'transcript' | 'notes';

export interface NoteBodyTabInput {
  usesSegmentTranscript: boolean;
  /** The transcript is still being made or failed, so its tab shows that status. */
  transcriptPending: boolean;
  /** Uploaded audio stores its flat transcript as the note body; it has no notes of its own. */
  contentIsTranscript: boolean;
  hasEnhanced: boolean;
}

const NOTE_BODY_TAB_LABELS: Record<NoteBodyView, string> = {
  enhanced: 'Enhanced',
  transcript: 'Transcript',
  notes: 'My notes',
};

/**
 * Once notes are generated the transcript moves to ⋯ → View Transcript. A transcript status and
 * an upload's transcript have nowhere else to go, so they keep their tab.
 */
export function getNoteBodyTabs({
  usesSegmentTranscript,
  transcriptPending,
  contentIsTranscript,
  hasEnhanced,
}: NoteBodyTabInput): NoteBodyView[] {
  const tabs: NoteBodyView[] = [];
  if (hasEnhanced) tabs.push('enhanced');
  const showTranscript =
    transcriptPending || (usesSegmentTranscript && (!hasEnhanced || contentIsTranscript));
  if (showTranscript) tabs.push('transcript');
  // An upload's body only duplicates its transcript, so it shows only when there is no other.
  if (!(contentIsTranscript && showTranscript)) tabs.push('notes');
  return tabs;
}

/** An upload without segments shows its transcript as editable text under the Transcript name. */
export function getNoteBodyTabLabel(
  tab: NoteBodyView,
  { contentIsTranscript }: Pick<NoteBodyTabInput, 'contentIsTranscript'>,
): string {
  return tab === 'notes' && contentIsTranscript ? 'Transcript' : NOTE_BODY_TAB_LABELS[tab];
}

/**
 * The view to show for the user's last pick. A pick whose tab disappeared (Transcript once notes
 * are generated) lands on the first tab; My notes stays while it exists, so typing is never
 * interrupted.
 */
export function resolveNoteBodyView(
  requested: NoteBodyView,
  input: NoteBodyTabInput,
): NoteBodyView {
  const tabs = getNoteBodyTabs(input);
  return tabs.includes(requested) ? requested : tabs[0];
}

/**
 * The pick a note opens with. Audio notes ask for the transcript even before their segments
 * exist, so the view follows the transcript and then the generated notes as they arrive.
 */
export function defaultNoteBodyView({
  isAudioTranscript,
  hasEnhanced,
}: {
  isAudioTranscript: boolean;
  hasEnhanced: boolean;
}): NoteBodyView {
  if (hasEnhanced) return 'enhanced';
  return isAudioTranscript ? 'transcript' : 'notes';
}
