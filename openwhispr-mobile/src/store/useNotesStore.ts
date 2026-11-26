import {
  clearPendingBackfill,
  isBackfillRetryDue,
  isManagedMeetingAudioUri,
  readPendingBackfillState,
  savePendingBackfill,
  saveRecordingAwaitingConnection,
  type BackfillRetry,
  type PendingBackfillState,
} from '@/lib/transcriptAudio';
import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sentry from '@sentry/react-native';
import { notesRepository, spacesRepository } from '@/data';
import type { Note, Folder, NoteUpdate, Space } from '@/data';
import type { ConflictedNote, NewSegment, Segment, Speaker, SpeakerProfile } from '@/data/types';
import type { CalendarParticipant } from '@/data/calendarTypes';
import type { Diarizer } from '@/lib/diarization/diarizer';
import {
  captureMeetingAccount,
  meetingAccountFenceFor,
  type MeetingAccountFence,
} from '@/lib/notes/meetingAccountFence';
import { activeMeetingNoteId } from '@/lib/notes/activeMeeting';
import { alertMeetingNoteNotDeletable } from '@/lib/alerts';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useConfigStore } from '@/store/useConfigStore';
import { deletePrivateNoteCloudCopy, queuePrivateNoteDeletion } from '@/sync/privateNoteDeletion';
import { createSyncContext } from '@/sync/createSyncContext';
import {
  readPrivateWorkspaceContext,
  setActivePrivateWorkspaceChoice,
} from '@/sync/teamSpacesCapability';
import {
  foldersInPrivateWorkspace,
  pickPrivateDefaultFolder,
  pickPrivateMeetingsFolder,
  type PrivateWorkspace,
} from '@/lib/privateWorkspaces';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import type { TranscriptionStatus } from '@/types';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { CloudMeetingResult } from '@/hooks/useCloudMeeting';
import type { AudioWindow } from '@/services/transcription/realtimeReconnect';
import { assertTransition, canTransition } from '@/lib/diarization/transcriptionStatus';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { assignSpeakersToSegments } from '@/lib/diarization/assignSpeakers';
import { diarizationToTurns, speakerLabelFor } from '@/lib/diarization/diarizationBridge';
import { buildMergeTargetPatch, buildRenameSpeakerPatch } from '@/lib/diarization/speakerEdits';
import {
  buildConfirmedSpeakerPatch,
  buildRejectedSuggestionPatch,
  hasFiniteNonZeroNorm,
  l2Normalize,
  runningMeanEmbedding,
} from '@/lib/diarization/voiceprints';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
} from '@/lib/notes/generateNotesPrompt';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import {
  inSpokenOrder,
  mapUtterancesToSegments,
  type CloudMeetingSegment,
} from '@/lib/notes/cloudMeetingSegments';
import {
  BACKFILL_CHUNK_MS,
  BACKFILL_MIN_MS,
  backfillDroppedAudio,
  createCloudPostPassDeps,
  errorCode,
  isDeviceOnline,
  mergeTranscript,
  recordingDurationMs,
  transcribeRecordingToSegments,
} from '@/lib/notes/meetingPostPass';
import { splitWindows } from '@/lib/notes/wavRange';
import { DEFAULT_MEETING_TITLE } from '@/lib/notes/meetingConstants';
import { isRegenerableNoteTitle } from '@/lib/notes/regenerableNoteTitle';
import { generateLocalMeetingNotes } from '@/lib/notes/localMeetingNotes';
import {
  getLocalReasoningReadiness,
  isLocalReasoningRequired,
  shouldUseLocalReasoning,
} from '@/lib/localReasoning';
import { promptLocalReasoningFallback } from '@/lib/localReasoningFallback';
import {
  getCalendarParticipantEmails,
  parseCalendarParticipants,
} from '@/lib/calendar/meetingContext';
import { makeContentHash } from '@/lib/utils';
import { logTranscriptionCompleted } from '@/lib/appsflyer';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import type {
  EnrollVoiceProfileInput,
  ReenrollVoiceProfileInput,
} from '@/services/diarization/VoiceprintService';
import {
  VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED,
  VoiceEnrollmentError,
  identifyNoteSpeakers,
} from '@/services/diarization/VoiceprintService';

// These deps are loaded lazily via require() (literal paths, so Metro still bundles them) rather than
// dynamic import(): require keeps the native diarizer/whisper bindings off the cold-start path while
// staying usable under jest, which cannot execute native dynamic import() without --experimental-vm-modules.
/* eslint-disable @typescript-eslint/no-var-requires */
const loadMeetingPipelineDeps = () => {
  const diarizationService =
    require('@/services/diarization/DiarizationService') as typeof import('@/services/diarization/DiarizationService');
  const diarizerModule =
    require('@/lib/diarization/getDiarizer') as typeof import('@/lib/diarization/getDiarizer');
  const localTranscriptionModule =
    require('@/services/transcription/LocalTranscriptionService') as typeof import('@/services/transcription/LocalTranscriptionService');

  return {
    processMeeting: diarizationService.processMeeting,
    getDiarizer: diarizerModule.getDiarizer,
    LocalTranscriptionService: localTranscriptionModule.LocalTranscriptionService,
  };
};

const loadVoiceEnrollmentDeps = () => {
  const voiceprintService =
    require('@/services/diarization/VoiceprintService') as typeof import('@/services/diarization/VoiceprintService');
  const diarizerModule =
    require('@/lib/diarization/getDiarizer') as typeof import('@/lib/diarization/getDiarizer');

  return {
    enrollVoiceProfile: voiceprintService.enrollVoiceProfile,
    reenrollVoiceProfile: voiceprintService.reenrollVoiceProfile,
    getDiarizer: diarizerModule.getDiarizer,
  };
};

const loadVoiceEnrollmentProcessingDeps = () => {
  const speechActivityModule =
    require('@/lib/speechActivity') as typeof import('@/lib/speechActivity');
  const audioToolsModule =
    require('../../modules/audio-tools/src') as typeof import('../../modules/audio-tools/src');

  return {
    analyzeSpeechActivity: speechActivityModule.analyzeSpeechActivity,
    AudioTools: audioToolsModule.AudioTools,
  };
};

const loadInsertNewSpeakers = () =>
  (
    require('@/services/diarization/DiarizationService') as typeof import('@/services/diarization/DiarizationService')
  ).insertNewSpeakers;

const loadDiarizer = () => {
  const diarizerModule =
    require('@/lib/diarization/getDiarizer') as typeof import('@/lib/diarization/getDiarizer');
  return diarizerModule.getDiarizer();
};

const loadLocalTranscriptionService = () => {
  const localTranscriptionModule =
    require('@/services/transcription/LocalTranscriptionService') as typeof import('@/services/transcription/LocalTranscriptionService');
  return localTranscriptionModule.LocalTranscriptionService;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const reloadVoiceProfiles = (): Pick<NotesStore, 'voiceProfiles'> => ({
  voiceProfiles: notesRepository.getSpeakerProfiles(),
});

/** Labels a meeting's speakers from the saved voice profiles; true when any speaker changed. */
const identifyMeetingSpeakers = (
  noteId: number,
  speakerEmbeddingsByLabel: Record<string, number[]>,
  onlyProfileId?: number,
): boolean => {
  const note = notesRepository.getNoteById(noteId);
  const preferredProfileEmails = getCalendarParticipantEmails(
    parseCalendarParticipants(note?.participants ?? null) ?? [],
  );
  const identification = identifyNoteSpeakers(
    noteId,
    speakerEmbeddingsByLabel,
    { repo: notesRepository },
    { preferredProfileEmails, onlyProfileId },
  );
  return identification.updatedSpeakerIds.length > 0;
};

let diarizerModelDownload: Promise<void> | null = null;

// Diarizing with the model missing downloads it natively, into the folder a download
// already running is writing, so it waits for that download first.
const diarizerAfterModelDownload = (diarizer: Diarizer): Diarizer => ({
  ...diarizer,
  diarize: async (wavUri, numberOfSpeakers) => {
    await diarizerModelDownload?.catch(() => undefined);
    return diarizer.diarize(wavUri, numberOfSpeakers);
  },
});

// The default folders a workspace's Private gets the first time a note needs one, as on desktop.
const PRIVATE_DEFAULT_FOLDERS = [
  { name: 'Personal', sortOrder: 0 },
  { name: 'Meetings', sortOrder: 1 },
] as const;

export type CreateMeetingNoteContext = {
  expectedSpeakerCount?: number;
  calendarEventId?: string | null;
  title?: string | null;
  participants?: CalendarParticipant[] | null;
  /** Defaults to true (on-device path). Cloud realtime meetings have no diarization. */
  diarizationEnabled?: boolean;
  /** The folder the meeting was started from. */
  folderId?: number;
  /** The team space the meeting was started from, when no folder was open. */
  spaceId?: number;
};

type PrivateSectionState = {
  folders: Folder[];
  privateWorkspaces: PrivateWorkspace[];
  activePrivateWorkspaceId: string | null;
  defaultPrivateWorkspaceId: string | null;
};

/** The active workspace's Private folders, and the workspaces the switcher offers. */
const readPrivateSection = (): PrivateSectionState => {
  const { workspaces, activeId, defaultId } = readPrivateWorkspaceContext();
  return {
    folders: foldersInPrivateWorkspace(
      notesRepository.getPrivateFolders(),
      activeId,
      defaultId,
      workspaces.map((w) => w.id),
    ),
    privateWorkspaces: workspaces,
    activePrivateWorkspaceId: activeId,
    defaultPrivateWorkspaceId: defaultId,
  };
};

const pickActivePrivateDefaultFolder = (section: PrivateSectionState): Folder | null =>
  pickPrivateDefaultFolder(
    foldersInPrivateWorkspace(
      section.folders,
      section.activePrivateWorkspaceId,
      section.defaultPrivateWorkspaceId,
    ),
  );

const canFileInPrivateWorkspace = (workspaceId: string | null): boolean => {
  const { placementSupported, workspaces, defaultId } = readPrivateWorkspaceContext();
  return (
    !placementSupported ||
    workspaceId == null ||
    workspaceId === defaultId ||
    workspaces.some((workspace) => workspace.id === workspaceId)
  );
};

/**
 * The folder a new note or meeting goes to in the active workspace's Private: its Meetings or
 * Personal, never another workspace's same-named folder. A Private with no folders yet gets its
 * own Personal and Meetings first.
 */
const resolvePrivateFolderId = (kind: 'note' | 'meeting'): number => {
  const { activeId: workspaceId, defaultId } = readPrivateWorkspaceContext();
  const own = foldersInPrivateWorkspace(
    notesRepository.getPrivateFolders(),
    workspaceId,
    defaultId,
  );
  const existing =
    kind === 'meeting'
      ? (pickPrivateMeetingsFolder(own) ?? pickPrivateDefaultFolder(own))
      : pickPrivateDefaultFolder(own);
  if (existing) return existing.id;
  const [personal, meetings] = PRIVATE_DEFAULT_FOLDERS.map(({ name, sortOrder }) =>
    notesRepository.createFolder(name, undefined, {
      privateWorkspaceId: workspaceId,
      isDefault: true,
      sortOrder,
    }),
  );
  return (kind === 'meeting' ? meetings : personal).id;
};

/**
 * A meeting goes where it was started: that folder, or that team space. Anywhere else it
 * goes to the personal Meetings folder. So does a meeting started in a team space this
 * device no longer has, and a Private-mode one, since a private note can't be shared.
 */
const createMeetingNoteRow = (title: string, context: CreateMeetingNoteContext): Note => {
  const canFileInTeamSpace = (spaceId: number | null): boolean =>
    useProcessingModeStore.getState().activeMode !== 'private' &&
    spacesRepository.listSpaces().some(({ id, kind }) => id === spaceId && kind === 'team');
  if (context.folderId != null) {
    const folder = notesRepository.getFolders().find(({ id }) => id === context.folderId);
    if (
      folder &&
      (folder.spaceId === spacesRepository.getPrivateSpace().id
        ? canFileInPrivateWorkspace(folder.privateWorkspaceId)
        : canFileInTeamSpace(folder.spaceId))
    ) {
      return notesRepository.createNote(title, '', folder.id);
    }
  } else if (context.spaceId != null && canFileInTeamSpace(context.spaceId)) {
    return notesRepository.createNote(title, '', undefined, context.spaceId);
  }
  return notesRepository.createNote(title, '', resolvePrivateFolderId('meeting'));
};

const assertDiarizerModelReadyForEnrollment = async (
  getDiarizer: ReturnType<typeof loadVoiceEnrollmentDeps>['getDiarizer'],
): Promise<void> => {
  if (!(await getDiarizer().isModelDownloaded())) {
    throw new VoiceEnrollmentError(
      VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED,
      'Download the diarization model before enrolling a voice profile.',
    );
  }
};

const canUseCloudForMeetingNote = (note: Note | null | undefined): note is Note => {
  if (
    !useAuthStore.getState().user &&
    useConfigStore.getState().config?.inference?.notes?.mode !== 'providers'
  )
    return false;
  // Local Mode's meetings are private notes; note formatting follows its own selection otherwise.
  return !!note && !note.deletedAt && note.noteType === 'meeting' && note.isPrivate !== 1;
};

const autoGenerateMeetingNotes = async (
  noteId: number,
  fence: MeetingAccountFence = captureMeetingAccount(),
): Promise<void> => {
  const note = notesRepository.getNoteById(noteId);
  if (!note || note.deletedAt || note.noteType !== 'meeting') return;
  // Generated notes the user already has (edited, or from an action they ran) are never replaced
  // automatically, e.g. by retrying a transcript; the Enhanced tab marks them stale instead.
  if (note.enhancedContent?.trim()) return;

  const action = notesRepository.getActions().find(isDefaultGenerateNotesAction);
  if (!action) return;

  const segments = notesRepository.getSegments(noteId);
  if (segments.length === 0) return;

  const transcript = formatTranscriptForExport({
    title: note.calendarEventId ? undefined : note.title,
    segments,
    speakers: notesRepository.getSpeakers(noteId),
    suppressUnlabeledSpeakerNames: true,
  });
  const generationInput = buildMeetingNotesInput({
    rawNotes: note.content,
    transcript,
    meetingContext: note.calendarEventId
      ? {
          eventTitle: note.title,
          participants: parseCalendarParticipants(note.participants ?? null) ?? [],
        }
      : undefined,
  });
  const contentHash = makeContentHash(generationInput);
  if (!generationInput.trim() || note.enhancedAtContentHash === contentHash) return;

  const routing = { isPrivateNote: note.isPrivate === 1 };
  // Another account's credentials never carry this transcript to the cloud.
  const canUseCloud = fence.isCurrent() && canUseCloudForMeetingNote(note);
  const notesMode = useConfigStore.getState().config?.inference?.notes?.mode;
  // On-Device notes take the chunked local path: a whole meeting rarely fits
  // the on-device context in one request.
  const canUseLocal =
    notesMode === 'local'
      ? (await getLocalReasoningReadiness()).status === 'ready'
      : (notesMode !== 'providers' || !canUseCloud) && (await shouldUseLocalReasoning(routing));
  const systemPrompt = buildActionSystemPrompt({
    actionPrompt: action.prompt,
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
  });

  const writeGeneratedText = (generatedText: string) => {
    // The user may have run an action or written notes while these were generated.
    if (!generatedText.trim() || notesRepository.getNoteById(noteId)?.enhancedContent?.trim()) {
      return;
    }
    notesRepository.updateNote(noteId, {
      enhancedContent: generatedText,
      enhancementPrompt: action.prompt,
      enhancedAtContentHash: contentHash,
    });
  };

  const generateCloudOnce = async () => {
    if (!fence.isCurrent()) return;
    const result = await ReasoningService.processText({
      inferenceScope: 'notes',
      text: generationInput,
      systemPrompt,
      temperature: 0.3,
      routing: {
        ...routing,
        allowCloudFallback: true,
      },
    });
    writeGeneratedText(result.text);
  };

  const captureError = (error: unknown) => {
    Sentry.captureException(error, { tags: { feature: 'meeting-auto-notes' } });
  };

  if (!canUseCloud && !canUseLocal) {
    // A prompt about this meeting would be answered by whoever is signed in now.
    if (fence.isCurrent() && isLocalReasoningRequired(routing)) {
      const readiness = await getLocalReasoningReadiness();
      const signedIn = !!useAuthStore.getState().user;
      promptLocalReasoningFallback({
        readiness,
        signedIn,
        onEnableLocal: async () => {
          try {
            await autoGenerateMeetingNotes(noteId, fence);
          } catch (error) {
            captureError(error);
          }
        },
        onUseCloudOnce: signedIn
          ? async () => {
              try {
                await generateCloudOnce();
              } catch (error) {
                captureError(error);
              }
            }
          : undefined,
      });
    }
    return;
  }

  const generatedText = canUseLocal
    ? await generateLocalMeetingNotes(noteId, { actionPrompt: action.prompt })
    : (
        await ReasoningService.processText({
          inferenceScope: 'notes',
          text: generationInput,
          systemPrompt,
          temperature: 0.3,
          routing: {
            ...routing,
            allowCloudFallback: canUseCloud,
          },
        })
      ).text;

  writeGeneratedText(generatedText);
};

// Shared finalization tail for both meeting paths (local runMeetingPipeline and cloud
// finalizeCloudMeeting): auto-title from the transcript, then the AI summary/cleanup pass.
const finalizeMeetingNoteContent = async (
  noteId: number,
  fence: MeetingAccountFence = captureMeetingAccount(),
  /**
   * For a pass that runs once the note has been the user's for a while (audio transcribed after
   * the meeting): the title is replaced only while it is still a placeholder.
   */
  { keepNamedTitle = false }: { keepNamedTitle?: boolean } = {},
): Promise<void> => {
  const currentNote = notesRepository.getNoteById(noteId);
  if (!currentNote || currentNote.deletedAt || currentNote.noteType !== 'meeting') return;

  // The title falls back to the local derivation below when the account has changed.
  const canUseCloud = fence.isCurrent() && canUseCloudForMeetingNote(currentNote);

  // Auto-title from the transcript, matching the action path and the "Auto-generate Note
  // Titles" setting. A selected calendar title is durable until the user clears it back to
  // the default title state.
  if (useConfigStore.getState().config?.autoGenerateNoteTitle ?? true) {
    const currentTitle = currentNote?.title?.trim() ?? '';
    const calendarTitleBlocksAutoTitle =
      !!currentNote?.calendarEventId &&
      currentTitle.length > 0 &&
      currentTitle !== DEFAULT_MEETING_TITLE;
    const namedTitleBlocksAutoTitle = keepNamedTitle && !isRegenerableNoteTitle(currentTitle);

    if (!calendarTitleBlocksAutoTitle && !namedTitleBlocksAutoTitle) {
      const transcriptText = notesRepository
        .getSegments(noteId)
        .map((segment) => segment.text)
        .join(' ')
        .trim();
      if (transcriptText) {
        const { deriveLocalTitle, generateNoteTitle } =
          require('@/utils/generateTitle') as typeof import('@/utils/generateTitle');
        const routing = { isPrivateNote: currentNote.isPrivate === 1 };
        const canUseLocalTitle = await shouldUseLocalReasoning(routing);
        const generatedTitle =
          canUseCloud || canUseLocalTitle
            ? await generateNoteTitle(transcriptText, {
                ...routing,
                allowCloudFallback: canUseCloud,
              })
            : '';
        const title = generatedTitle || (!canUseCloud ? deriveLocalTitle(transcriptText) : '');
        // Read again: the user may have named or deleted the note while the title was generated.
        const latest = notesRepository.getNoteById(noteId);
        const stillUnnamed =
          !!latest &&
          !latest.deletedAt &&
          (!keepNamedTitle || isRegenerableNoteTitle(latest.title));
        if (title && stillUnnamed) notesRepository.updateNote(noteId, { title });
      }
    }
  }
  await autoGenerateMeetingNotes(noteId, fence).catch((error) => {
    Sentry.captureException(error, { tags: { feature: 'meeting-auto-notes' } });
  });
};

const isLiveNote = (noteId: number): boolean => {
  const note = notesRepository.getNoteById(noteId);
  return !!note && !note.deletedAt;
};

const withNoteId = (noteId: number, segments: CloudMeetingSegment[]): NewSegment[] =>
  segments.map((segment) => ({ ...segment, noteId }));

const savedAsNew = (noteId: number, rows: Segment[]): NewSegment[] =>
  rows.map((row) => ({
    noteId,
    text: row.text,
    startMs: row.startMs,
    endMs: row.endMs,
    speakerLabel: row.speakerLabel,
    sortOrder: row.sortOrder,
  }));

/**
 * Fills the stretches the live stream missed. Best effort: on any failure the live transcript
 * stands, and the windows not transcribed come back so the recording can be kept for them.
 */
const backfillCloudMeeting = async (
  noteId: number,
  recordingUri: string,
  /** Read after the backfill, so the merge never drops a row saved while it ran. */
  readLive: () => CloudMeetingSegment[],
  droppedWindows: CloudMeetingResult['droppedWindows'],
  shouldStop?: () => boolean,
): Promise<{
  transcript: CloudMeetingSegment[];
  failedWindows: AudioWindow[];
  /** At least one piece was transcribed or found empty. */
  progressed: boolean;
  /** `shouldStop` ended it; the pieces left were never tried. */
  stopped: boolean;
}> => {
  try {
    const { segments, failed, failedWindows, stopped } = await backfillDroppedAudio(
      recordingUri,
      droppedWindows,
      createCloudPostPassDeps(getPreferredTranscriptionLanguage()),
      { shouldStop },
    );
    const pieces = splitWindows(droppedWindows, BACKFILL_CHUNK_MS, BACKFILL_MIN_MS).length;
    const outcome = { failedWindows, progressed: failed < pieces, stopped: stopped === true };
    // A note deleted meanwhile has lost its segments; writing would bring them back.
    if (segments.length === 0 || !isLiveNote(noteId)) {
      return { transcript: readLive(), ...outcome };
    }
    const merged = mergeTranscript(readLive(), segments);
    notesRepository.replaceSegments(noteId, withNoteId(noteId, merged));
    return { transcript: merged, ...outcome };
  } catch (error) {
    Sentry.captureMessage('meeting-post-pass-backfill-failed', {
      level: 'warning',
      tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
      extra: { windows: droppedWindows.length },
    });
    // Nothing is known to be transcribed, so every gap is still owed.
    return {
      transcript: readLive(),
      failedWindows: droppedWindows,
      progressed: false,
      stopped: false,
    };
  }
};

const windowsMs = (windows: AudioWindow[]): number =>
  windows.reduce((sum, window) => sum + (window.endMs - window.startMs), 0);

/** Writes what the recording still owes beside it; false when it could not be written. */
const recordOwedAudio = async (
  noteId: number,
  windows: AudioWindow[],
  retry?: BackfillRetry,
): Promise<boolean> => {
  try {
    await savePendingBackfill(noteId, windows, retry);
    return true;
  } catch (error) {
    Sentry.captureMessage('meeting-backfill-sidecar-failed', {
      level: 'warning',
      tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
    });
    return false;
  }
};

/** Marks the whole recording as waiting for a connection; false when it could not be written. */
const recordAwaitingConnection = async (
  noteId: number,
  accountId: string | null,
  retry?: BackfillRetry,
): Promise<boolean> => {
  try {
    await saveRecordingAwaitingConnection(noteId, accountId, retry);
    return true;
  } catch (error) {
    Sentry.captureMessage('meeting-backfill-sidecar-failed', {
      level: 'warning',
      tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
    });
    return false;
  }
};

/**
 * Brings the list beside the recording up to what is still owed after a backfill, and deletes
 * the recording once nothing is. A recording that still owes audio is always kept, even when
 * the list can't be rewritten: the earlier list (written before the backfill) still names it.
 */
const settleMeetingRecording = async (
  noteId: number,
  failedWindows: AudioWindow[],
  discard: (noteId: number) => Promise<void>,
  retry: BackfillRetry,
): Promise<void> => {
  if (failedWindows.length === 0 || !isLiveNote(noteId)) {
    await discard(noteId);
    return;
  }
  Sentry.captureMessage('meeting-post-pass-incomplete', {
    level: 'warning',
    tags: { feature: 'meeting-post-pass' },
    extra: { failedPieces: failedWindows.length, failedMs: windowsMs(failedWindows) },
  });
  await recordOwedAudio(noteId, failedWindows, retry);
};

// One backfill per note at a time: launch recovery, a return to the foreground and Stop can
// all reach the same note, and two runs would upload and merge the same stretches twice.
// Launch recovery's speaker pass takes it too: a backfill that finishes deletes the recording
// the diarizer is reading. So does the upload of a recording waiting for the connection, which
// a resume, a return of the connection and the note's Retry can all start.
const meetingBackfillsInFlight = new Set<number>();

export type MeetingRetryOutcome =
  /** The transcription ran (a failure throws instead). */
  | 'transcribed'
  /** Offline: nothing was uploaded, and the recording waits for the connection. */
  | 'waiting-for-connection'
  /** Another run already has the note. */
  | 'already-running';

interface NotesStore {
  /** The active workspace's Private folders (see NotesRepository.getPrivateFolders) — every UI
   * folder surface reads this. Team-space content is reached through the Spaces section instead. */
  folders: Folder[];
  /** The workspaces the Folders switcher offers; empty until the API keeps a Private per
   * workspace, when only the default's Private exists. */
  privateWorkspaces: PrivateWorkspace[];
  /** The workspace whose Private and team spaces are on screen. */
  activePrivateWorkspaceId: string | null;
  /** The workspace whose Private holds folders and notes with no placement. */
  defaultPrivateWorkspaceId: string | null;
  /** Folders of the space currently being browsed (activeSpaceId). Kept separate from `folders`,
   * which is private-space only, so team folders never leak into personal folder surfaces. */
  spaceFolders: Folder[];
  folderCounts: Record<number, number>;
  notes: Note[];
  /** All spaces (private + team, excludes soft-deleted) — populated by initialize() and refreshed
   * after every sync pass, mirroring `folders`. */
  spaces: Space[];
  voiceProfiles: SpeakerProfile[];
  meetingSpeakerEmbeddingsByNoteId: Record<number, Record<string, number[]>>;
  activeNoteId: number | null;
  activeFolderId: number | null;
  /** The team space currently being browsed (FoldersScreen's Spaces section), if any. Mutually
   * exclusive with activeFolderId — selecting one clears the other. */
  activeSpaceId: number | null;
  isInitialized: boolean;
  searchQuery: string;
  isSearching: boolean;
  transcriptRevision: number;

  initialize: () => void;
  getNoteById: (id: number) => Note | null;
  loadFolders: () => void;
  loadSpaces: () => void;
  /** Shows another workspace's Private and team spaces, and remembers the choice. */
  setActivePrivateWorkspace: (workspaceId: string | null) => void;
  loadNotes: (folderId?: number) => void;
  setActiveNoteId: (id: number | null) => void;
  setActiveFolderId: (id: number | null) => void;
  setActiveSpaceId: (id: number | null) => void;
  setSearchQuery: (query: string) => void;
  createNote: (title?: string, content?: string, folderId?: number) => Note;
  updateNote: (id: number, updates: NoteUpdate) => void;
  deleteNote: (id: number) => void;
  moveNoteToFolder: (noteId: number, folderId: number) => void;
  moveNoteToSpace: (noteId: number, spaceId: number) => void;
  deleteFolderSafe: (id: number) => void;
  /** Creates in the active workspace's Private (or `privateWorkspaceId`'s) unless `spaceId`
   * names a team space to create it inside. */
  createFolder: (
    name: string,
    spaceId?: number,
    options?: { privateWorkspaceId: string | null },
  ) => Folder;
  /** Folders of any space, read from the repository. `spaceFolders` only caches the browsed space's. */
  getSpaceFolders: (spaceId: number) => Folder[];
  /** Every workspace's Private folders, read from the repository. `folders` is the active one's. */
  getAllPrivateFolders: () => Folder[];
  /** Where a new note goes in the active workspace's Private, making its Personal if needed. */
  getPrivateNoteFolderId: () => number;
  renameFolder: (id: number, name: string) => void;
  setNotePrivacy: (id: number, isPrivate: boolean) => Promise<void>;
  /** Data source for the conflict banner (see NoteEditorScreen) — the parked 409 row for this note, if any. */
  getConflictedNote: (noteId: number) => ConflictedNote | null;
  /** Keep the local edit; clears the conflict banner. */
  resolveConflictKeepMine: (noteId: number) => void;
  /** Adopt the server's copy; clears the conflict banner. Callers must re-read the note afterward
   * (e.g. via getNoteById) to refresh any locally-held draft — this only updates the repository. */
  resolveConflictUseServer: (noteId: number) => void;
  createMeetingNote: (context?: number | CreateMeetingNoteContext) => Note;
  transitionStatus: (noteId: number, to: TranscriptionStatus) => void;
  runMeetingPipeline: (
    noteId: number,
    wavUri: string,
    expectedSpeakerCount?: number,
    /** The account the meeting was recorded under; defaults to the one signed in now. */
    options?: { fence?: MeetingAccountFence },
  ) => Promise<void>;
  retryMeetingTranscription: (noteId: number) => Promise<MeetingRetryOutcome>;
  /**
   * A cloud meeting stopped offline with nothing heard live, whose recording is waiting to be
   * transcribed once the phone is back online: shown as waiting rather than failed. False once an
   * upload has been tried and refused (the note offers Retry again) or the account changed.
   */
  isMeetingAwaitingConnection: (noteId: number) => Promise<boolean>;
  /**
   * Saves the live transcript, fills what the stream missed from the recording, and deletes
   * the recording once the note is done. A note with a recording and no text at all ends
   * failed with its recording kept, so Retry can try again; stopped offline, it waits for the
   * connection instead (see isMeetingAwaitingConnection).
   */
  finalizeCloudMeeting: (
    noteId: number,
    result: CloudMeetingResult,
    /** Audio the mic delivered, in seconds; spreads utterances that carry no timings. */
    capturedSeconds: number,
    /** The account the meeting was recorded under; defaults to the one signed in now. */
    options?: { fence?: MeetingAccountFence },
  ) => Promise<{
    /** Audio the note is done without, still to be transcribed from its recording. */
    owedMs: number;
    /**
     * Audio the note is done without whose list could not be saved, so nothing will resume it;
     * present only when there is some.
     */
    unsavedOwedMs?: number;
  }>;
  /**
   * A done cloud meeting whose backfill fell short: transcribes the stretches its sidecar still
   * owes into the saved transcript, then deletes the recording, or keeps it for what is still
   * owed, and brings the title (while still a placeholder) and the AI summary (while it has
   * none) up to date. A meeting waiting for the connection gets its whole recording transcribed,
   * under the account that recorded it and on the same backoff. Uploads nothing for a note that
   * may not use the cloud. Never throws.
   */
  resumeMeetingBackfill: (
    noteId: number,
    options?: {
      /** Asked before each piece; true leaves the rest owed without counting a failed try. */
      shouldStop?: () => boolean;
    },
  ) => Promise<void>;
  /** A meeting with a recording and no transcript: transcribes the whole file through cloud chunks. */
  transcribeMeetingRecording: (
    noteId: number,
    options?: { fence?: MeetingAccountFence },
  ) => Promise<void>;
  /** Runs the diarizer on the note's recording and labels its segments. Never throws; false when it did nothing. */
  labelMeetingSpeakers: (
    noteId: number,
    options: {
      utteranceTimed: boolean;
      /**
       * Holds the note's backfill guard while it reads the recording, and does nothing while a
       * backfill holds it. For a caller not already holding it (launch recovery).
       */
      exclusive?: boolean;
      /** Speakers are matched to voice profiles only while the account is unchanged. */
      fence?: MeetingAccountFence;
    },
  ) => Promise<boolean>;
  /** Deletes a meeting's recording and clears its `sourceFile`. Never throws. */
  discardMeetingRecording: (noteId: number) => Promise<void>;
  /** Saves one live utterance. Never throws: a failed write is reported and the meeting goes on. */
  appendCloudMeetingUtterance: (
    noteId: number,
    utterance: RealtimeUtterance,
    index: number,
    capturedMs: number,
  ) => void;
  /** recording or transcribing or diarizing → done, keeping the segments already saved. */
  keepCloudMeetingTranscript: (noteId: number) => void;
  /**
   * Title (while still a placeholder) and AI summary (while it has none) for a recovered meeting.
   * Its backfill resume may already have written both.
   */
  finishRecoveredMeetingNotes: (noteId: number) => Promise<void>;
  isDiarizerAvailable: () => Promise<boolean>;
  isDiarizerModelReady: () => Promise<boolean>;
  isLocalAsrModelReady: () => Promise<boolean>;
  downloadDiarizerModel: () => Promise<void>;
  isDiarizerModelDownloading: () => boolean;
  deleteDiarizerModel: () => Promise<void>;
  getNoteSegments: (noteId: number) => Segment[];
  getNoteSpeakers: (noteId: number) => Speaker[];
  loadVoiceProfiles: () => void;
  enrollVoiceProfile: (input: EnrollVoiceProfileInput) => Promise<SpeakerProfile>;
  reenrollVoiceProfile: (input: ReenrollVoiceProfileInput) => Promise<SpeakerProfile>;
  updateVoiceProfile: (
    profileId: number,
    updates: { displayName?: string; email?: string | null },
  ) => void;
  deleteVoiceProfile: (profileId: number) => void;
  deleteAllVoiceProfiles: () => void;
  confirmSpeakerSuggestion: (
    noteId: number,
    speakerId: number,
    meetingEmbedding?: number[],
  ) => void;
  rejectSpeakerSuggestion: (noteId: number, speakerId: number) => void;
  renameSpeaker: (noteId: number, speakerId: number, displayName: string) => void;
  /** Makes a speaker from a meeting just processed on this device your voice profile. */
  claimSpeakerAsMe: (noteId: number, speakerId: number) => void;
  /**
   * Labels a meeting processed since launch with a newly added or retrained voice profile,
   * leaving speakers already linked to another profile alone.
   */
  relabelMeetingSpeakers: (noteId: number, profileId: number) => void;
  mergeSpeakers: (noteId: number, sourceSpeakerId: number, targetSpeakerId: number) => void;
}

/**
 * Uploads the whole recording of a meeting that was waiting for the connection, once the phone
 * is back online. The attempt is counted before the upload, so one that kills the app still
 * waits out the backoff; a success removes the mark with the recording.
 */
const transcribeAwaitedRecording = async (
  store: NotesStore,
  noteId: number,
  awaiting: { accountId: string | null },
  retry: PendingBackfillState,
  { shouldStop }: { shouldStop?: () => boolean },
): Promise<void> => {
  // Anything else is a Retry or another run already transcribing it.
  if (notesRepository.getTranscriptionStatus(noteId) !== 'failed') return;
  const fence = meetingAccountFenceFor(awaiting.accountId);
  if (!fence.isCurrent()) {
    // Never under another account: as at Stop, the note keeps its recording for a Retry. Signed
    // out (or not restored yet) it waits for whoever signs in next.
    if (useAuthStore.getState().user) await clearPendingBackfill(noteId);
    return;
  }
  if (shouldStop?.() || !isBackfillRetryDue(retry, Date.now())) return;
  if (!(await isDeviceOnline())) return;
  // A count that can't be saved would let a run that kills the app repeat on every launch.
  const counted = await recordAwaitingConnection(noteId, fence.accountId, {
    attempts: retry.attempts + 1,
    lastAttemptAt: Date.now(),
  });
  if (!counted) return;
  if (notesRepository.getTranscriptionStatus(noteId) !== 'failed' || !fence.isCurrent()) return;
  store.transitionStatus(noteId, 'transcribing'); // failed -> transcribing, as Retry does
  // A failure leaves the note failed with its recording, the count kept for the backoff.
  await store.transcribeMeetingRecording(noteId, { fence }).catch(() => undefined);
};

export const useNotesStore = create<NotesStore>((set, get) => ({
  folders: [],
  privateWorkspaces: [],
  activePrivateWorkspaceId: null,
  defaultPrivateWorkspaceId: null,
  spaceFolders: [],
  folderCounts: {},
  notes: [],
  spaces: [],
  voiceProfiles: [],
  meetingSpeakerEmbeddingsByNoteId: {},
  activeNoteId: null,
  activeFolderId: null,
  activeSpaceId: null,
  isInitialized: false,
  searchQuery: '',
  isSearching: false,
  transcriptRevision: 0,

  initialize: () => {
    const section = readPrivateSection();
    const folderCounts = notesRepository.getFolderCounts();
    const defaultFolder = pickActivePrivateDefaultFolder(section);
    const notes = defaultFolder ? notesRepository.getNotesByFolder(defaultFolder.id) : [];
    const voiceProfiles = notesRepository.getSpeakerProfiles();
    const spaces = spacesRepository.listSpaces();
    set({
      ...section,
      folderCounts,
      notes,
      spaces,
      voiceProfiles,
      activeFolderId: defaultFolder?.id ?? null,
      isInitialized: true,
    });
  },

  getNoteById: (id) => {
    const note = notesRepository.getNoteById(id);
    return note && !note.deletedAt ? note : null;
  },

  loadFolders: () => {
    const { activeSpaceId } = get();
    set({
      // A sync pass can also change the workspace list or the default, so the section is
      // read whole.
      ...readPrivateSection(),
      folderCounts: notesRepository.getFolderCounts(),
      // A sync pass can add or remove folders in the space on screen, so refresh
      // those alongside the personal ones.
      ...(activeSpaceId != null
        ? { spaceFolders: notesRepository.getFoldersBySpace(activeSpaceId) }
        : {}),
    });
  },

  loadSpaces: () => {
    set({ spaces: spacesRepository.listSpaces() });
  },

  setActivePrivateWorkspace: (workspaceId) => {
    setActivePrivateWorkspaceChoice(workspaceId);
    const section = readPrivateSection();
    const defaultFolder = pickActivePrivateDefaultFolder(section);
    set({
      ...section,
      activeFolderId: defaultFolder?.id ?? null,
      activeSpaceId: null,
      activeNoteId: null,
      spaceFolders: [],
      searchQuery: '',
      isSearching: false,
      notes: defaultFolder ? notesRepository.getNotesByFolder(defaultFolder.id) : [],
    });
  },

  loadNotes: (folderId) => {
    if (folderId != null) {
      set({ notes: notesRepository.getNotesByFolder(folderId) });
      return;
    }
    const { activeFolderId, activeSpaceId } = get();
    if (activeFolderId != null) {
      set({ notes: notesRepository.getNotesByFolder(activeFolderId) });
    } else if (activeSpaceId != null) {
      set({ notes: notesRepository.getSpaceNotesWithoutFolder(activeSpaceId) });
    } else {
      set({ notes: notesRepository.getAllNotes() });
    }
  },

  setActiveNoteId: (id) => set({ activeNoteId: id }),

  setActiveFolderId: (id) => {
    set({
      activeFolderId: id,
      activeSpaceId: null,
      activeNoteId: null,
      searchQuery: '',
      isSearching: false,
    });
    if (id != null) {
      set({ notes: notesRepository.getNotesByFolder(id) });
    } else {
      set({ notes: notesRepository.getAllNotes() });
    }
  },

  setActiveSpaceId: (id) => {
    set({
      activeSpaceId: id,
      activeFolderId: null,
      activeNoteId: null,
      searchQuery: '',
      isSearching: false,
    });
    set({
      spaceFolders: id != null ? notesRepository.getFoldersBySpace(id) : [],
      notes:
        id != null ? notesRepository.getSpaceNotesWithoutFolder(id) : notesRepository.getAllNotes(),
    });
  },

  setSearchQuery: (query) => {
    const { activeFolderId } = get();
    if (query.trim()) {
      const notes = notesRepository.searchNotes(query, activeFolderId ?? undefined);
      set({ searchQuery: query, isSearching: true, notes });
    } else {
      set({ searchQuery: '', isSearching: false });
      get().loadNotes();
    }
  },

  createNote: (title = 'Untitled', content = '', folderId) => {
    const { activeFolderId, activeSpaceId } = get();
    const requestedFolderId = folderId ?? activeFolderId;
    const privateFolder = notesRepository
      .getPrivateFolders()
      .find((folder) => folder.id === requestedFolderId);
    const targetFolderId =
      privateFolder && !canFileInPrivateWorkspace(privateFolder.privateWorkspaceId)
        ? null
        : requestedFolderId;
    // Browsing a space (mutually exclusive with browsing a folder): the note
    // belongs to that space, not to the personal default folder.
    const note =
      folderId == null && activeSpaceId != null
        ? notesRepository.createNote(title, content, undefined, activeSpaceId)
        : notesRepository.createNote(
            title,
            content,
            targetFolderId ?? resolvePrivateFolderId('note'),
          );

    if (useProcessingModeStore.getState().activeMode === 'private') {
      notesRepository.setNotePrivacy(note.id, true);
    }

    get().loadNotes();
    get().loadFolders();
    return note;
  },

  updateNote: (id, updates) => {
    notesRepository.updateNote(id, updates);
    get().loadNotes();
  },

  deleteNote: (id) => {
    // Refused like a cancelled delete: the live meeting still records into this note.
    if (activeMeetingNoteId() === id) {
      alertMeetingNoteNotDeletable();
      return;
    }
    notesRepository.deleteNote(id);
    const { activeNoteId, notes, meetingSpeakerEmbeddingsByNoteId } = get();
    if (activeNoteId === id) {
      const remaining = notes.filter((n) => n.id !== id);
      set({ activeNoteId: remaining[0]?.id ?? null });
    }
    if (id in meetingSpeakerEmbeddingsByNoteId) {
      const next = { ...meetingSpeakerEmbeddingsByNoteId };
      delete next[id];
      set({ meetingSpeakerEmbeddingsByNoteId: next });
    }
    get().loadNotes();
    get().loadFolders();
  },

  getSpaceFolders: (spaceId) => notesRepository.getFoldersBySpace(spaceId),

  getAllPrivateFolders: () => notesRepository.getPrivateFolders(),

  getPrivateNoteFolderId: () => resolvePrivateFolderId('note'),

  moveNoteToFolder: (noteId, folderId) => {
    notesRepository.moveNoteToFolder(noteId, folderId);
    get().loadNotes();
    get().loadFolders();
  },

  moveNoteToSpace: (noteId, spaceId) => {
    notesRepository.moveNoteToSpace(noteId, spaceId);
    get().loadNotes();
    get().loadFolders();
  },

  getConflictedNote: (noteId) =>
    notesRepository.listConflictedNotes().find((c) => c.id === noteId) ?? null,

  resolveConflictKeepMine: (noteId) => {
    notesRepository.resolveConflictKeepMine(noteId);
    get().loadNotes();
  },

  resolveConflictUseServer: (noteId) => {
    notesRepository.resolveConflictUseServer(noteId);
    get().loadNotes();
  },

  deleteFolderSafe: (id) => {
    // Refused whole rather than skipping the live note: keeping one note of a deleted folder would
    // leave it pointing at a tombstoned folder, and the cascade's journal undoes all or nothing.
    const liveNoteId = activeMeetingNoteId();
    if (liveNoteId != null && notesRepository.getNoteById(liveNoteId)?.folderId === id) {
      alertMeetingNoteNotDeletable();
      return;
    }
    // Deleting a folder deletes the notes inside it — the server's own cascade.
    // The repository journals both so a refused push can undo the whole thing.
    notesRepository.deleteFolderCascade(id);
    const { activeFolderId } = get();
    get().loadFolders();
    if (activeFolderId === id) {
      const defaultFolder = pickActivePrivateDefaultFolder(get());
      get().setActiveFolderId(defaultFolder?.id ?? null);
    } else {
      get().loadNotes();
    }
  },

  createFolder: (name, spaceId, options) => {
    const { activeId } = readPrivateWorkspaceContext();
    const requestedWorkspaceId = options ? options.privateWorkspaceId : activeId;
    const folder =
      spaceId != null
        ? notesRepository.createFolder(name, spaceId)
        : notesRepository.createFolder(name, undefined, {
            privateWorkspaceId: canFileInPrivateWorkspace(requestedWorkspaceId)
              ? requestedWorkspaceId
              : activeId,
          });
    get().loadFolders();
    return folder;
  },

  renameFolder: (id, name) => {
    notesRepository.renameFolder(id, name);
    get().loadFolders();
  },

  setNotePrivacy: async (id, isPrivate) => {
    if (!isPrivate) {
      const note = notesRepository.getNoteById(id);
      if (note?.isPrivate === 1) {
        // Keep old cleanup work durable before publishing under a fresh identity.
        queuePrivateNoteDeletion(note);
        notesRepository.setNotePrivacy(id, false);
      }
      get().loadNotes();
      return;
    }
    const { checkpoint, dispose } = createSyncContext();
    try {
      // Opt-out is immediate. Retain identifiers until deletion is acknowledged,
      // including a create already in flight whose remote id has not arrived yet.
      notesRepository.setNotePrivacy(id, true);
      const note = notesRepository.getNoteById(id);
      if (note?.isPrivate === 1 && (note.remoteId || note.clientNoteId)) {
        await deletePrivateNoteCloudCopy(note, checkpoint);
      }
    } catch (error) {
      // A later publication supersedes this toggle; its retired ID remains queued.
      if (notesRepository.getNoteById(id)?.isPrivate === 1) throw error;
    } finally {
      dispose();
      get().loadNotes();
    }
  },

  createMeetingNote: (input) => {
    const context: CreateMeetingNoteContext =
      typeof input === 'number' ? { expectedSpeakerCount: input } : (input ?? {});
    const title = context.title?.trim() || DEFAULT_MEETING_TITLE;
    const participants =
      context.participants === undefined || context.participants === null
        ? null
        : JSON.stringify(context.participants);
    const note = createMeetingNoteRow(title, context);
    notesRepository.updateNoteMeta(note.id, {
      noteType: 'meeting',
      diarizationEnabled: context.diarizationEnabled === false ? 0 : 1,
      expectedSpeakerCount: context.expectedSpeakerCount ?? null,
    });
    if (context.calendarEventId) {
      notesRepository.updateNoteCalendarContext(note.id, {
        calendarEventId: context.calendarEventId,
        participants,
      });
    }
    get().transitionStatus(note.id, 'recording'); // idle -> recording via the guarded boundary
    if (useProcessingModeStore.getState().activeMode === 'private') {
      notesRepository.setNotePrivacy(note.id, true);
    }
    get().loadNotes();
    get().loadFolders();
    return note;
  },

  transitionStatus: (noteId, to) => {
    const from = notesRepository.getTranscriptionStatus(noteId);
    assertTransition(from, to); // throws on an illegal jump
    notesRepository.setTranscriptionStatus(noteId, to);
    get().loadNotes();
  },

  runMeetingPipeline: async (noteId, wavUri, expectedSpeakerCount, options = {}) => {
    const fence = options.fence ?? captureMeetingAccount();
    const { processMeeting, getDiarizer, LocalTranscriptionService } = loadMeetingPipelineDeps();
    notesRepository.updateNoteMeta(noteId, { sourceFile: wavUri });
    try {
      const result = await processMeeting(
        // The facade picks the engine + best downloaded model from the user's language
        // selection, same routing as the dictation path.
        { noteId, wavUri, expectedSpeakerCount, language: getPreferredTranscriptionLanguage() },
        {
          transcribe: (uri, opts) =>
            LocalTranscriptionService.transcribe(uri, {
              language: opts.language,
              wordTimestamps: opts.wordTimestamps,
            }),
          diarizer: diarizerAfterModelDownload(getDiarizer()),
          repo: notesRepository,
        },
      );
      if (notesRepository.getSegments(noteId).some((segment) => segment.text.trim())) {
        logTranscriptionCompleted({ source: 'meeting', provider: 'local' });
      }
      // Voice profiles are the signed-in account's: another account's profiles are never matched
      // against this meeting, and its speaker embeddings are not kept for the banner to match.
      if (fence.isCurrent()) {
        set((state) => ({
          meetingSpeakerEmbeddingsByNoteId: {
            ...state.meetingSpeakerEmbeddingsByNoteId,
            [noteId]: result.speakerEmbeddingsByLabel,
          },
        }));
        if (identifyMeetingSpeakers(noteId, result.speakerEmbeddingsByLabel)) {
          set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
        }
      }
      // processMeeting returns only once the note is done, and the diarizer and identification
      // are the recording's last readers (the banner works from the embeddings kept above). A
      // throw above leaves the note failed with its recording, which Retry needs.
      await get().discardMeetingRecording(noteId);
      await finalizeMeetingNoteContent(noteId, fence);
    } finally {
      get().loadNotes();
    }
  },

  retryMeetingTranscription: async (noteId) => {
    const note = notesRepository.getNoteById(noteId);
    if (!note || note.deletedAt) {
      throw new Error('Note not found');
    }
    if (!note.sourceFile || !isManagedMeetingAudioUri(noteId, note.sourceFile)) {
      throw new Error('Original audio is no longer available for this note.');
    }
    // A cloud meeting's recording goes back to the cloud; the on-device pipeline would
    // diarize a meeting the user never chose to process on this phone.
    if (canUseCloudForMeetingNote(note) && note.diarizationEnabled === 0) {
      if (meetingBackfillsInFlight.has(noteId)) return 'already-running';
      meetingBackfillsInFlight.add(noteId);
      try {
        if (!(await isDeviceOnline())) {
          // The upload would only spin through its timeouts. The recording waits for the
          // connection instead, under the account retrying it.
          if (!(await recordAwaitingConnection(noteId, captureMeetingAccount().accountId))) {
            throw new Error("You're offline. Try again once you're back online.");
          }
          return 'waiting-for-connection';
        }
        await get().transcribeMeetingRecording(noteId);
        return 'transcribed';
      } finally {
        meetingBackfillsInFlight.delete(noteId);
      }
    }
    await get().runMeetingPipeline(noteId, note.sourceFile, note.expectedSpeakerCount ?? undefined);
    return 'transcribed';
  },

  isMeetingAwaitingConnection: async (noteId) => {
    try {
      const note = notesRepository.getNoteById(noteId);
      if (!note || note.deletedAt || !isManagedMeetingAudioUri(noteId, note.sourceFile)) {
        return false;
      }
      if (notesRepository.getTranscriptionStatus(noteId) !== 'failed') return false;
      const pending = await readPendingBackfillState(noteId);
      if (!pending?.awaitingConnection) return false;
      // After a refused upload the note offers Retry again, and uploads go on behind it on the
      // backoff. Another account's recording never goes up, so that note is a failure too.
      return (
        pending.attempts === 0 &&
        meetingAccountFenceFor(pending.awaitingConnection.accountId).isCurrent()
      );
    } catch {
      return false;
    }
  },

  finalizeCloudMeeting: async (noteId, result, capturedSeconds, options = {}) => {
    const fence = options.fence ?? captureMeetingAccount();
    meetingBackfillsInFlight.add(noteId);
    try {
      get().transitionStatus(noteId, 'transcribing'); // recording -> transcribing
      const live = mapUtterancesToSegments(result.utterances, capturedSeconds);
      // Saved first, so whatever happens to the post-pass the live transcript is kept.
      notesRepository.replaceSegments(noteId, withNoteId(noteId, live));
      const recordingUri = isManagedMeetingAudioUri(noteId, result.recordingUri)
        ? result.recordingUri
        : null;
      if (recordingUri && notesRepository.getNoteById(noteId)?.sourceFile !== recordingUri) {
        notesRepository.updateNoteMeta(noteId, { sourceFile: recordingUri });
      }
      const heardLive = live.some((segment) => segment.text?.trim());
      if (recordingUri && !heardLive) {
        // Nothing heard live (often offline the whole time): the whole file is transcribed.
        // When the account changed the upload would go out under the new account, so the note
        // ends failed at once with its recording, which is what the note's Retry needs.
        if (!fence.isCurrent()) {
          get().transitionStatus(noteId, 'failed');
          return { owedMs: 0 };
        }
        if (!(await isDeviceOnline())) {
          // Offline the upload would only hold the processing screen through its timeouts. The
          // note settles with its recording and, written first so a kill in between leaves it,
          // a mark that it waits for the connection, which the resumers and launch recovery act
          // on. A mark that can't be written leaves a plain failure with Retry.
          await recordAwaitingConnection(noteId, fence.accountId);
          get().transitionStatus(noteId, 'failed');
          return { owedMs: 0 };
        }
        // A failure leaves the note failed with its recording too.
        await get()
          .transcribeMeetingRecording(noteId, { fence })
          .catch(() => undefined);
        return { owedMs: 0 };
      }
      let transcript = live;
      let owed: AudioWindow[] = recordingUri ? result.droppedWindows : [];
      // Whether a list on disk names what is still owed. The first list covers what the second
      // would, so either one being written is enough.
      let owedSaved = false;
      if (recordingUri && owed.length > 0) {
        // Before the first upload: a kill from here on leaves the list on disk, so the launch
        // recovery transcribes exactly these stretches instead of deleting a recording that
        // looks processed. A list that can't be written does not stop the pass.
        owedSaved = await recordOwedAudio(noteId, owed);
        // Offline every piece would wait out its timeouts; the stretches stay owed instead.
        // A changed account leaves the stretches owed, in the list just saved, for launch recovery.
        if ((await isDeviceOnline()) && fence.isCurrent()) {
          ({ transcript, failedWindows: owed } = await backfillCloudMeeting(
            noteId,
            recordingUri,
            () => live,
            owed,
          ));
        }
        // Before the speaker pass and done: a done note's list never claims less than its
        // recording owes, and a kill from here on resumes only what is still owed, never the
        // stretches just transcribed, which would go up again and be merged twice. With nothing
        // owed the list is emptied, not deleted, or recovery would guess the owed audio from the
        // transcript's pauses; the discard below removes it with the recording.
        if ((owedSaved || owed.length > 0) && isLiveNote(noteId)) {
          owedSaved = (await recordOwedAudio(noteId, owed)) || owedSaved;
        }
      }
      // While the recording is still on disk: the diarizer reads it. Leaves the status at
      // transcribing or diarizing, both of which may move to done. An utterance the session
      // sent without timing was spread evenly over the meeting, which must not be labelled.
      const utteranceTimed =
        result.utterances.length > 0 &&
        result.utterances.every((u) => u.startMs != null && u.endMs != null);
      await get().labelMeetingSpeakers(noteId, { utteranceTimed, fence });
      get().transitionStatus(noteId, 'done');
      if (transcript.some((segment) => segment.text?.trim())) {
        logTranscriptionCompleted({ source: 'meeting', provider: 'cloud' });
      }
      if (owed.length === 0 || !isLiveNote(noteId)) {
        await get().discardMeetingRecording(noteId);
      } else {
        // The recording stays linked. If its list could not be written either, the launch
        // clean-up will take this done note for a processed one and delete the recording:
        // accepted, since a phone that can't write a few bytes can't keep the audio safe anyway.
        Sentry.captureMessage('meeting-post-pass-incomplete', {
          level: 'warning',
          tags: { feature: 'meeting-post-pass' },
          extra: { failedPieces: owed.length, failedMs: windowsMs(owed) },
        });
      }
      await finalizeMeetingNoteContent(noteId, fence);
      const stillOwedMs = isLiveNote(noteId) ? windowsMs(owed) : 0;
      if (stillOwedMs > 0 && !owedSaved) return { owedMs: 0, unsavedOwedMs: stillOwedMs };
      return { owedMs: stillOwedMs };
    } finally {
      meetingBackfillsInFlight.delete(noteId);
      get().loadNotes();
    }
  },

  resumeMeetingBackfill: async (noteId, options = {}) => {
    if (meetingBackfillsInFlight.has(noteId)) return;
    meetingBackfillsInFlight.add(noteId);
    // The account signed in when the run began: the notes made afterwards use the cloud only while
    // it still is.
    const fence = captureMeetingAccount();
    let refreshNotes = false;
    try {
      const note = notesRepository.getNoteById(noteId);
      if (!note || note.deletedAt) return;
      // The recording of a meeting that may not use the cloud (signed out, Private) never
      // leaves the phone. Only a cloud meeting has a sidecar at all, which is read below.
      if (!canUseCloudForMeetingNote(note)) return;
      const recordingUri = note.sourceFile;
      if (!recordingUri || !isManagedMeetingAudioUri(noteId, recordingUri)) return;
      const pending = await readPendingBackfillState(noteId);
      if (!pending) return;
      if (pending.awaitingConnection) {
        await transcribeAwaitedRecording(get(), noteId, pending.awaitingConnection, pending, {
          shouldStop: options.shouldStop,
        });
        return;
      }
      if (notesRepository.getTranscriptionStatus(noteId) !== 'done') return;
      if (pending.windows.length === 0) return;
      // A piece the server keeps refusing would otherwise go up again on every return to the app.
      if (!isBackfillRetryDue(pending, Date.now())) return;
      // Re-read at merge time: the note is done, so the user may be editing it meanwhile.
      const readSaved = (): CloudMeetingSegment[] =>
        savedAsNew(noteId, notesRepository.getSegments(noteId));
      const { failedWindows, progressed, stopped } = await backfillCloudMeeting(
        noteId,
        recordingUri,
        readSaved,
        pending.windows,
        options.shouldStop,
      );
      // Any run that added transcript, even one that left pieces owed: a summary is written only
      // while the note has none, so waiting for every piece could leave it with none at all. A
      // run paused for a meeting skips it; the run that resumes the rest refreshes instead.
      refreshNotes = progressed && !stopped;
      let retry: BackfillRetry;
      if (progressed) retry = { attempts: 0, lastAttemptAt: Date.now() };
      // Paused before it tried anything: not a failure.
      else if (stopped)
        retry = { attempts: pending.attempts, lastAttemptAt: pending.lastAttemptAt };
      else retry = { attempts: pending.attempts + 1, lastAttemptAt: Date.now() };
      await settleMeetingRecording(noteId, failedWindows, get().discardMeetingRecording, retry);
    } catch (error) {
      Sentry.captureMessage('meeting-backfill-resume-failed', {
        level: 'warning',
        tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
      });
    } finally {
      meetingBackfillsInFlight.delete(noteId);
      get().loadNotes();
    }
    if (!refreshNotes) return;
    // A meeting stopped offline was titled and summarised from what was heard before the
    // outage, if at all. Outside the guard: this reads no audio and can take minutes on-device,
    // so it never holds up this note's next run.
    try {
      await finalizeMeetingNoteContent(noteId, fence, { keepNamedTitle: true });
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'meeting-auto-notes' } });
    } finally {
      get().loadNotes();
    }
  },

  transcribeMeetingRecording: async (noteId, options = {}) => {
    const fence = options.fence ?? captureMeetingAccount();
    try {
      const note = notesRepository.getNoteById(noteId);
      if (!note || note.deletedAt) {
        throw new Error('Note not found');
      }
      const recordingUri = note.sourceFile;
      if (!recordingUri || !isManagedMeetingAudioUri(noteId, recordingUri)) {
        throw new Error('Original audio is no longer available for this note.');
      }
      if (notesRepository.getTranscriptionStatus(noteId) !== 'transcribing') {
        get().transitionStatus(noteId, 'transcribing'); // failed -> transcribing (Retry)
      }
      let segments: CloudMeetingSegment[];
      try {
        if (!fence.isCurrent()) throw new Error('The account changed before the upload.');
        segments = await transcribeRecordingToSegments(
          recordingUri,
          getPreferredTranscriptionLanguage(),
        );
      } catch (error) {
        Sentry.captureMessage('meeting-post-pass-whole-file-failed', {
          level: 'warning',
          tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
        });
        const status = notesRepository.getTranscriptionStatus(noteId);
        if (isLiveNote(noteId) && canTransition(status, 'failed')) {
          get().transitionStatus(noteId, 'failed');
        }
        throw error;
      }
      if (!isLiveNote(noteId)) return;
      // Silence in the file must not erase live text a crashed meeting already saved.
      const transcript =
        segments.length > 0
          ? withNoteId(noteId, segments)
          : savedAsNew(noteId, notesRepository.getSegments(noteId));
      notesRepository.replaceSegments(noteId, transcript);
      // The whole recording is in the transcript, so nothing it owes is left: a mark that it
      // waited for the connection goes even if deleting the recording below fails.
      await clearPendingBackfill(noteId);
      // No speaker pass: each segment is a two-minute chunk holding several speakers.
      get().transitionStatus(noteId, 'done');
      if (transcript.some((segment) => segment.text?.trim())) {
        logTranscriptionCompleted({ source: 'meeting', provider: 'cloud' });
      }
      await get().discardMeetingRecording(noteId);
      await finalizeMeetingNoteContent(noteId, fence);
    } finally {
      get().loadNotes();
    }
  },

  labelMeetingSpeakers: async (noteId, { utteranceTimed, exclusive = false, fence }) => {
    if (!utteranceTimed) return false;
    if (exclusive) {
      if (meetingBackfillsInFlight.has(noteId)) return false;
      meetingBackfillsInFlight.add(noteId);
      try {
        return await get().labelMeetingSpeakers(noteId, { utteranceTimed, fence });
      } finally {
        meetingBackfillsInFlight.delete(noteId);
      }
    }
    const startedAt = Date.now();
    // Set while labelled segments are written but their speakers aren't yet, the one stretch a
    // failure must undo.
    let restore: NewSegment[] | null = null;
    let labelled = false;
    try {
      const note = notesRepository.getNoteById(noteId);
      const recordingUri = note?.sourceFile;
      if (
        !note ||
        note.deletedAt ||
        !recordingUri ||
        !isManagedMeetingAudioUri(noteId, recordingUri)
      ) {
        return false;
      }
      if (!(await get().isDiarizerAvailable()) || !(await get().isDiarizerModelReady())) {
        return false;
      }
      if (notesRepository.getSegments(noteId).length === 0) return false;
      if (canTransition(notesRepository.getTranscriptionStatus(noteId), 'diarizing')) {
        get().transitionStatus(noteId, 'diarizing');
      }
      // The native engine streams the file from disk; the recording never enters JS memory.
      const diarization = await loadDiarizer().diarize(
        recordingUri,
        note.expectedSpeakerCount ?? 0,
      );
      // Deleting the note removed its segments; writing would bring them back.
      if (!isLiveNote(noteId)) return false;
      // Read again: the segments are the user's text and may have changed while it ran.
      const current = savedAsNew(noteId, notesRepository.getSegments(noteId));
      const segments = assignSpeakersToSegments(current, diarizationToTurns(diarization));
      const labels = segments.flatMap((segment) =>
        segment.speakerLabel ? [segment.speakerLabel] : [],
      );
      if (labels.length === 0) return false;
      restore = current;
      notesRepository.replaceSegments(noteId, segments);
      loadInsertNewSpeakers()(noteId, labels, notesRepository);
      notesRepository.updateNoteMeta(noteId, { diarizationEnabled: 1 });
      restore = null;
      labelled = true;
      const speakerEmbeddingsByLabel = Object.fromEntries(
        Object.entries(diarization.embeddings).map(([id, embedding]) => [
          speakerLabelFor(Number(id)),
          embedding,
        ]),
      );
      // Plain labels from the diariser use no account data; profiles do.
      if (fence == null || fence.isCurrent()) {
        set((state) => ({
          meetingSpeakerEmbeddingsByNoteId: {
            ...state.meetingSpeakerEmbeddingsByNoteId,
            [noteId]: speakerEmbeddingsByLabel,
          },
        }));
        if (identifyMeetingSpeakers(noteId, speakerEmbeddingsByLabel)) {
          set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
        }
      }
      Sentry.captureMessage('meeting-speaker-pass', {
        level: 'info',
        tags: { feature: 'meeting-post-pass', outcome: 'labelled' },
        extra: {
          durationMs: Date.now() - startedAt,
          audioMs: await recordingDurationMs(recordingUri),
          speakers: new Set(labels).size,
        },
      });
      return true;
    } catch (error) {
      // Nothing here may throw: the caller moves the note on to done only once this settles.
      try {
        if (restore && isLiveNote(noteId)) notesRepository.replaceSegments(noteId, restore);
      } catch {
        // The labelled rows stay; their text and timing are the user's, unchanged.
      }
      try {
        Sentry.captureMessage('meeting-speaker-pass', {
          level: 'warning',
          tags: { feature: 'meeting-post-pass', outcome: 'failed', error_code: errorCode(error) },
          extra: { durationMs: Date.now() - startedAt },
        });
      } catch {
        // Telemetry is best effort.
      }
      // Labels already written stand even if identifying them failed.
      return labelled;
    }
  },

  discardMeetingRecording: async (noteId) => {
    try {
      const uri = notesRepository.getNoteById(noteId)?.sourceFile;
      // A sidecar is only ever written beside a linked recording, and every path that
      // deletes the recording deletes the sidecar with it, so without one there is none.
      if (!uri || !isManagedMeetingAudioUri(noteId, uri)) return;
      await FileSystem.deleteAsync(uri, { idempotent: true });
      // The launch repair re-links a recording whose note has no sourceFile, so the link
      // goes only once the file is really gone.
      if ((await FileSystem.getInfoAsync(uri)).exists) {
        throw Object.assign(new Error('Recording still on disk'), { code: 'still_exists' });
      }
      await clearPendingBackfill(noteId);
      if (notesRepository.getNoteById(noteId)?.sourceFile === uri) {
        notesRepository.updateNoteMeta(noteId, { sourceFile: null });
      }
    } catch (error) {
      Sentry.captureMessage('meeting-recording-discard-failed', {
        level: 'warning',
        tags: { feature: 'meeting-post-pass', error_code: errorCode(error) },
      });
    }
  },

  appendCloudMeetingUtterance: (noteId, utterance, index, capturedMs) => {
    try {
      // A late utterance after Stop must not add a row beside the final list.
      if (notesRepository.getTranscriptionStatus(noteId) !== 'recording') return;
      // The server may send no timing; the capture clock keeps the row ordered and non-null.
      const startMs = utterance.startMs ?? capturedMs;
      notesRepository.appendSegments(noteId, [
        {
          noteId,
          text: utterance.text.trim(),
          startMs,
          endMs: Math.max(utterance.endMs ?? capturedMs, startMs),
          speakerLabel: null,
          sortOrder: index,
        },
      ]);
    } catch (error) {
      // Never the utterance: it is the user's speech.
      Sentry.captureException(error, { tags: { feature: 'meeting-live-transcript' } });
    }
  },

  keepCloudMeetingTranscript: (noteId) => {
    // A meeting killed during its post-pass is already past recording.
    if (notesRepository.getTranscriptionStatus(noteId) === 'recording') {
      get().transitionStatus(noteId, 'transcribing');
    }
    get().transitionStatus(noteId, 'done');
    // Live rows are local drafts; re-saving them makes the kept transcript syncable. They were
    // numbered as each utterance finished, which is not always the order it was spoken in.
    notesRepository.replaceSegments(
      noteId,
      inSpokenOrder(savedAsNew(noteId, notesRepository.getSegments(noteId))),
    );
  },

  finishRecoveredMeetingNotes: async (noteId) => {
    try {
      // A title the resume already generated, or one the user typed since, is kept.
      await finalizeMeetingNoteContent(noteId, captureMeetingAccount(), { keepNamedTitle: true });
    } finally {
      get().loadNotes();
    }
  },

  isDiarizerAvailable: async () => loadDiarizer().isAvailable(),

  // A download in flight has created some model files, which reads as downloaded.
  isDiarizerModelReady: async () =>
    diarizerModelDownload === null && loadDiarizer().isModelDownloaded(),

  // True only if the local ASR model the meeting path would route to is actually downloaded.
  isLocalAsrModelReady: async () => {
    const LocalTranscriptionService = loadLocalTranscriptionService();
    if (!LocalTranscriptionService.isAvailable()) return false;
    return LocalTranscriptionService.isReadyForLanguage();
  },

  // Shared, so a second caller can't start another download into the same model folder.
  downloadDiarizerModel: () => {
    diarizerModelDownload ??= loadDiarizer()
      .downloadModel()
      .finally(() => {
        diarizerModelDownload = null;
      });
    return diarizerModelDownload;
  },
  isDiarizerModelDownloading: () => diarizerModelDownload !== null,

  deleteDiarizerModel: async () => {
    await loadDiarizer().deleteModel();
  },

  getNoteSegments: (noteId) => notesRepository.getSegments(noteId),
  getNoteSpeakers: (noteId) => notesRepository.getSpeakers(noteId),
  loadVoiceProfiles: () => {
    set(reloadVoiceProfiles());
  },
  enrollVoiceProfile: async (input) => {
    const { enrollVoiceProfile, getDiarizer } = loadVoiceEnrollmentDeps();
    await assertDiarizerModelReadyForEnrollment(getDiarizer);
    const { analyzeSpeechActivity, AudioTools } = loadVoiceEnrollmentProcessingDeps();
    const profile = await enrollVoiceProfile(input, {
      diarizer: getDiarizer(),
      analyzeSpeechActivity,
      audioTools: AudioTools,
      repo: notesRepository,
    });
    set(reloadVoiceProfiles());
    return profile;
  },
  reenrollVoiceProfile: async (input) => {
    const { reenrollVoiceProfile, getDiarizer } = loadVoiceEnrollmentDeps();
    await assertDiarizerModelReadyForEnrollment(getDiarizer);
    const { analyzeSpeechActivity, AudioTools } = loadVoiceEnrollmentProcessingDeps();
    const profile = await reenrollVoiceProfile(input, {
      diarizer: getDiarizer(),
      analyzeSpeechActivity,
      audioTools: AudioTools,
      repo: notesRepository,
    });
    set(reloadVoiceProfiles());
    return profile;
  },
  updateVoiceProfile: (profileId, updates) => {
    const patch: Partial<SpeakerProfile> = {};
    if (updates.displayName !== undefined) {
      const trimmed = updates.displayName.trim();
      if (!trimmed) return;
      patch.displayName = trimmed;
    }
    if (updates.email !== undefined) {
      const trimmed = updates.email?.trim() ?? '';
      patch.email = trimmed.length > 0 ? trimmed : null;
    }
    if (Object.keys(patch).length === 0) return;
    notesRepository.updateSpeakerProfile(profileId, patch);
    set(reloadVoiceProfiles());
  },
  deleteVoiceProfile: (profileId) => {
    notesRepository.deleteSpeakerProfile(profileId);
    set((state) => ({
      ...reloadVoiceProfiles(),
      transcriptRevision: state.transcriptRevision + 1,
    }));
  },
  deleteAllVoiceProfiles: () => {
    notesRepository.deleteAllSpeakerProfiles();
    set((state) => ({
      voiceProfiles: [],
      transcriptRevision: state.transcriptRevision + 1,
    }));
  },
  confirmSpeakerSuggestion: (noteId, speakerId, meetingEmbedding) => {
    const speaker = notesRepository.getSpeakers(noteId).find((row) => row.id === speakerId);
    if (!speaker?.profileId) return;
    const profile = notesRepository.getSpeakerProfileById(speaker.profileId);
    if (!profile) return;

    const patch = buildConfirmedSpeakerPatch(speaker, profile);
    if (Object.keys(patch).length === 0) return;

    notesRepository.updateSpeaker(speaker.id, patch);

    const resolvedEmbedding =
      meetingEmbedding ?? get().meetingSpeakerEmbeddingsByNoteId[noteId]?.[speaker.speakerLabel];

    if (resolvedEmbedding) {
      const embedding = runningMeanEmbedding(
        profile.embedding,
        profile.sampleCount,
        resolvedEmbedding,
        1,
      );
      if (embedding.length > 0) {
        notesRepository.updateSpeakerProfile(profile.id, {
          embedding,
          sampleCount: profile.sampleCount + 1,
        });
      }
    }

    set((state) => ({
      ...reloadVoiceProfiles(),
      transcriptRevision: state.transcriptRevision + 1,
    }));
  },
  rejectSpeakerSuggestion: (noteId, speakerId) => {
    const speaker = notesRepository.getSpeakers(noteId).find((row) => row.id === speakerId);
    if (!speaker) return;
    const patch = buildRejectedSuggestionPatch(speaker);
    if (Object.keys(patch).length === 0) return;
    notesRepository.updateSpeaker(speaker.id, patch);
    set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
  },
  renameSpeaker: (noteId, speakerId, displayName) => {
    if (!displayName.trim()) return;
    const speaker = notesRepository.getSpeakers(noteId).find((row) => row.id === speakerId);
    if (!speaker) throw new Error('Speaker not found');
    const patch = buildRenameSpeakerPatch(speaker, displayName);
    if (Object.keys(patch).length === 0) return;
    notesRepository.updateSpeaker(speaker.id, patch);
    set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
  },
  claimSpeakerAsMe: (noteId, speakerId) => {
    if (notesRepository.getSpeakerProfiles().some((profile) => profile.isOwner === 1)) {
      throw new SpeakerProfileOwnerAlreadyExistsError();
    }
    // A retry rewrites the speakers under new labels before it replaces the samples.
    if (notesRepository.getTranscriptionStatus(noteId) !== 'done') {
      throw new Error('This meeting is still being processed.');
    }
    const speaker = notesRepository.getSpeakers(noteId).find((row) => row.id === speakerId);
    if (!speaker) throw new Error('Speaker not found');
    // Only held in memory for meetings processed since the app started.
    const embeddings = get().meetingSpeakerEmbeddingsByNoteId[noteId] ?? {};
    const embedding = embeddings[speaker.speakerLabel];
    if (!hasFiniteNonZeroNorm(embedding)) {
      throw new Error("This meeting's voice sample is no longer available.");
    }

    const profile = notesRepository.createOwnerProfileForSpeaker(
      speaker.id,
      {
        displayName: 'Me',
        embedding: l2Normalize(embedding),
        sampleCount: 1,
        consentAt: new Date().toISOString(),
      },
      buildRenameSpeakerPatch(speaker, 'Me'),
    );
    set((state) => ({
      ...reloadVoiceProfiles(),
      transcriptRevision: state.transcriptRevision + 1,
    }));
    // The claim is saved; labelling the rest of the meeting is a bonus that must not undo it.
    try {
      get().relabelMeetingSpeakers(noteId, profile.id);
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'voice-setup' } });
    }
  },
  relabelMeetingSpeakers: (noteId, profileId) => {
    const embeddings = get().meetingSpeakerEmbeddingsByNoteId[noteId];
    if (!embeddings || !identifyMeetingSpeakers(noteId, embeddings, profileId)) return;
    set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
  },
  mergeSpeakers: (noteId, sourceSpeakerId, targetSpeakerId) => {
    if (sourceSpeakerId === targetSpeakerId) {
      throw new Error('Cannot merge a speaker into itself');
    }
    const rows = notesRepository.getSpeakers(noteId);
    const source = rows.find((row) => row.id === sourceSpeakerId);
    const target = rows.find((row) => row.id === targetSpeakerId);
    if (!source) throw new Error('Source speaker not found');
    if (!target) throw new Error('Target speaker not found');
    notesRepository.mergeSpeakers(noteId, source.id, target.id, buildMergeTargetPatch(target));
    set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
  },
}));
