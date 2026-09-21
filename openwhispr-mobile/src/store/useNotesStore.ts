import { isManagedMeetingAudioUri } from '@/lib/transcriptAudio';
import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import { notesRepository, spacesRepository } from '@/data';
import type { Note, Folder, NoteUpdate, Space } from '@/data';
import type { ConflictedNote, Segment, Speaker, SpeakerProfile } from '@/data/types';
import type { CalendarParticipant } from '@/data/calendarTypes';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useConfigStore } from '@/store/useConfigStore';
import { deletePrivateNoteCloudCopy, queuePrivateNoteDeletion } from '@/sync/privateNoteDeletion';
import { createSyncContext } from '@/sync/createSyncContext';
import { getPreferredTranscriptionLanguage } from '@/lib/transcriptionLanguage';
import type { TranscriptionStatus } from '@/types';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import { assertTransition } from '@/lib/diarization/transcriptionStatus';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { buildMergeTargetPatch, buildRenameSpeakerPatch } from '@/lib/diarization/speakerEdits';
import {
  buildConfirmedSpeakerPatch,
  buildRejectedSuggestionPatch,
  runningMeanEmbedding,
} from '@/lib/diarization/voiceprints';
import {
  buildActionSystemPrompt,
  isDefaultGenerateNotesAction,
} from '@/lib/notes/generateNotesPrompt';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import { mapUtterancesToSegments } from '@/lib/notes/cloudMeetingSegments';
import { DEFAULT_MEETING_TITLE } from '@/lib/notes/meetingConstants';
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

const DEFAULT_FOLDER_ID = 1;
const MEETINGS_FOLDER_NAME = 'meetings';

export type CreateMeetingNoteContext = {
  expectedSpeakerCount?: number;
  calendarEventId?: string | null;
  title?: string | null;
  participants?: CalendarParticipant[] | null;
  /** Defaults to true (on-device path). Cloud realtime meetings have no diarization. */
  diarizationEnabled?: boolean;
};

const resolveMeetingFolderId = (folders: Folder[]): number => {
  const meetingsFolder = folders.find(
    (folder) => folder.name.trim().toLowerCase() === MEETINGS_FOLDER_NAME,
  );
  const fallbackFolder = folders.find((folder) => folder.isDefault) ?? folders[0];

  return meetingsFolder?.id ?? fallbackFolder?.id ?? DEFAULT_FOLDER_ID;
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
  if (!useAuthStore.getState().user) return false;
  if (useProcessingModeStore.getState().activeMode === 'private') return false;
  return !!note && !note.deletedAt && note.noteType === 'meeting' && note.isPrivate !== 1;
};

const autoGenerateMeetingNotes = async (noteId: number): Promise<void> => {
  const note = notesRepository.getNoteById(noteId);
  if (!note || note.deletedAt || note.noteType !== 'meeting') return;

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
  const canUseCloud = canUseCloudForMeetingNote(note);
  const canUseLocal = await shouldUseLocalReasoning(routing);
  const systemPrompt = buildActionSystemPrompt({
    actionPrompt: action.prompt,
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: isDefaultGenerateNotesAction(action),
  });

  const writeGeneratedText = (generatedText: string) => {
    if (!generatedText.trim()) return;
    notesRepository.updateNote(noteId, {
      enhancedContent: generatedText,
      enhancementPrompt: action.prompt,
      enhancedAtContentHash: contentHash,
    });
  };

  const generateCloudOnce = async () => {
    const result = await ReasoningService.processText({
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
    if (isLocalReasoningRequired(routing)) {
      const readiness = await getLocalReasoningReadiness();
      const signedIn = !!useAuthStore.getState().user;
      promptLocalReasoningFallback({
        readiness,
        signedIn,
        onEnableLocal: async () => {
          try {
            await autoGenerateMeetingNotes(noteId);
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
const finalizeMeetingNoteContent = async (noteId: number): Promise<void> => {
  const currentNote = notesRepository.getNoteById(noteId);
  if (!currentNote || currentNote.deletedAt || currentNote.noteType !== 'meeting') return;

  const canUseCloud = canUseCloudForMeetingNote(currentNote);

  // Auto-title from the transcript, matching the action path and the "Auto-generate Note
  // Titles" setting. A selected calendar title is durable until the user clears it back to
  // the default title state.
  if (useConfigStore.getState().config?.autoGenerateNoteTitle ?? true) {
    const currentTitle = currentNote?.title?.trim() ?? '';
    const calendarTitleBlocksAutoTitle =
      !!currentNote?.calendarEventId &&
      currentTitle.length > 0 &&
      currentTitle !== DEFAULT_MEETING_TITLE;

    if (!calendarTitleBlocksAutoTitle) {
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
        if (title) notesRepository.updateNote(noteId, { title });
      }
    }
  }
  await autoGenerateMeetingNotes(noteId).catch((error) => {
    Sentry.captureException(error, { tags: { feature: 'meeting-auto-notes' } });
  });
};

interface NotesStore {
  /** Private-space folders only (see NotesRepository.getPrivateFolders) — every UI folder surface
   * reads this. Team-space content is reached through the Spaces section instead. */
  folders: Folder[];
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
  /** Creates in the private space unless `spaceId` names a team space to create it inside. */
  createFolder: (name: string, spaceId?: number) => Folder;
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
  ) => Promise<void>;
  retryMeetingTranscription: (noteId: number) => Promise<void>;
  finalizeCloudMeeting: (
    noteId: number,
    utterances: RealtimeUtterance[],
    elapsedSeconds: number,
  ) => Promise<void>;
  isDiarizerAvailable: () => Promise<boolean>;
  isDiarizerModelReady: () => Promise<boolean>;
  isLocalAsrModelReady: () => Promise<boolean>;
  downloadDiarizerModel: () => Promise<void>;
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
  mergeSpeakers: (noteId: number, sourceSpeakerId: number, targetSpeakerId: number) => void;
}

export const useNotesStore = create<NotesStore>((set, get) => ({
  folders: [],
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
    const folders = notesRepository.getPrivateFolders();
    const folderCounts = notesRepository.getFolderCounts();
    const defaultFolder = folders.find((f) => f.isDefault) ?? folders[0];
    const notes = defaultFolder ? notesRepository.getNotesByFolder(defaultFolder.id) : [];
    const voiceProfiles = notesRepository.getSpeakerProfiles();
    const spaces = spacesRepository.listSpaces();
    set({
      folders,
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
      folders: notesRepository.getPrivateFolders(),
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
    // Browsing a space (mutually exclusive with browsing a folder): the note
    // belongs to that space, not to the personal default folder.
    const note =
      folderId == null && activeSpaceId != null
        ? notesRepository.createNote(title, content, undefined, activeSpaceId)
        : notesRepository.createNote(title, content, folderId ?? activeFolderId ?? 1);

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
    // Deleting a folder deletes the notes inside it — the server's own cascade.
    // The repository journals both so a refused push can undo the whole thing.
    notesRepository.deleteFolderCascade(id);
    const { activeFolderId } = get();
    get().loadFolders();
    if (activeFolderId === id) {
      const folders = get().folders;
      const defaultFolder = folders.find((f) => f.isDefault) ?? folders[0];
      get().setActiveFolderId(defaultFolder?.id ?? null);
    } else {
      get().loadNotes();
    }
  },

  createFolder: (name, spaceId) => {
    const folder = notesRepository.createFolder(name, spaceId);
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
    const note = notesRepository.createNote(
      title,
      '',
      resolveMeetingFolderId(notesRepository.getPrivateFolders()),
    );
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

  runMeetingPipeline: async (noteId, wavUri, expectedSpeakerCount) => {
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
          diarizer: getDiarizer(),
          repo: notesRepository,
        },
      );
      if (notesRepository.getSegments(noteId).some((segment) => segment.text.trim())) {
        logTranscriptionCompleted({ source: 'meeting', provider: 'local' });
      }
      set((state) => ({
        meetingSpeakerEmbeddingsByNoteId: {
          ...state.meetingSpeakerEmbeddingsByNoteId,
          [noteId]: result.speakerEmbeddingsByLabel,
        },
      }));
      const note = notesRepository.getNoteById(noteId);
      const preferredProfileEmails = getCalendarParticipantEmails(
        parseCalendarParticipants(note?.participants ?? null) ?? [],
      );
      const identification = identifyNoteSpeakers(
        noteId,
        result.speakerEmbeddingsByLabel,
        {
          repo: notesRepository,
        },
        {
          preferredProfileEmails,
        },
      );
      if (identification.updatedSpeakerIds.length > 0) {
        set((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
      }
      await finalizeMeetingNoteContent(noteId);
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
    await get().runMeetingPipeline(noteId, note.sourceFile, note.expectedSpeakerCount ?? undefined);
  },

  finalizeCloudMeeting: async (noteId, utterances, elapsedSeconds) => {
    try {
      get().transitionStatus(noteId, 'transcribing'); // recording -> transcribing
      const segments = mapUtterancesToSegments(utterances, elapsedSeconds).map((segment) => ({
        ...segment,
        noteId,
      }));
      notesRepository.replaceSegments(noteId, segments);
      get().transitionStatus(noteId, 'done'); // transcribing -> done (cloud skips diarizing)
      if (segments.some((segment) => segment.text?.trim())) {
        logTranscriptionCompleted({ source: 'meeting', provider: 'cloud' });
      }
      await finalizeMeetingNoteContent(noteId);
    } finally {
      get().loadNotes();
    }
  },

  isDiarizerAvailable: async () => loadDiarizer().isAvailable(),

  isDiarizerModelReady: async () => loadDiarizer().isModelDownloaded(),

  // True only if the local ASR model the meeting path would route to is actually downloaded.
  isLocalAsrModelReady: async () => {
    const LocalTranscriptionService = loadLocalTranscriptionService();
    if (!LocalTranscriptionService.isAvailable()) return false;
    return LocalTranscriptionService.isReadyForLanguage();
  },

  downloadDiarizerModel: async () => {
    await loadDiarizer().downloadModel();
  },

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
