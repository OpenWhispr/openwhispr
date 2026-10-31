import { notesRepository, spacesRepository } from '@/data';
import { resolveImportDestination, saveImportedNote } from '../importDestination';

let mockOwner = 'account-a';
const mockPersonal = { id: 1, name: 'Personal', kind: 'private' };
const mockTeam = { id: 2, name: 'Team', kind: 'team' };
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: mockOwner } }) },
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getFolders: jest.fn(),
    createNote: jest.fn(),
    setNotePrivacy: jest.fn(),
    updateNote: jest.fn(),
    deleteNote: jest.fn(),
  },
  spacesRepository: { getPrivateSpace: () => mockPersonal, listSpaces: jest.fn() },
}));
const repo = notesRepository as jest.Mocked<typeof notesRepository>;
const spaces = spacesRepository as jest.Mocked<typeof spacesRepository>;

beforeEach(() => {
  jest.resetAllMocks();
  mockOwner = 'account-a';
  spaces.listSpaces.mockReturnValue([mockPersonal, mockTeam] as never);
  repo.getFolders.mockReturnValue([{ id: 5, name: 'Research', spaceId: 2 }] as never);
  repo.createNote.mockReturnValue({ id: 42 } as never);
});

it('files into the original folder and uses the source filename as the note title', () => {
  const target = resolveImportDestination({ folderId: 5, isPrivate: false });
  saveImportedNote(target, 'Meeting transcript', 'Interview.wav');
  expect(repo.createNote).toHaveBeenCalledWith('Interview', '', 5, undefined);
  expect(repo.updateNote).toHaveBeenCalledWith(42, { content: 'Meeting transcript' });
});

it('keeps a private import personal even when started in a team folder', () => {
  const target = resolveImportDestination({ folderId: 5, isPrivate: true });
  expect(target).toMatchObject({
    spaceId: 1,
    folderId: undefined,
    isPrivate: true,
    label: 'Personal',
  });
  saveImportedNote(target, 'Private text', 'Private.wav');
  expect(repo.createNote).toHaveBeenCalledWith('Private', '', undefined, 1);
  expect(repo.setNotePrivacy).toHaveBeenCalledWith(42, true);
  expect(repo.setNotePrivacy.mock.invocationCallOrder[0]).toBeLessThan(
    repo.updateNote.mock.invocationCallOrder[0],
  );
});

it('does not write transcript content if setting privacy fails', () => {
  const target = resolveImportDestination({ isPrivate: true });
  repo.setNotePrivacy.mockImplementation(() => {
    throw new Error('Disk full');
  });
  expect(() => saveImportedNote(target, 'Secret', 'Audio.wav')).toThrow('Disk full');
  expect(repo.updateNote).not.toHaveBeenCalled();
  expect(repo.deleteNote).toHaveBeenCalledWith(42);
});

it('refuses to write into a different account', () => {
  const target = resolveImportDestination({ folderId: 5, isPrivate: false });
  mockOwner = 'account-b';
  expect(() => saveImportedNote(target, 'Text', 'Audio.wav')).toThrow('account changed');
  expect(repo.createNote).not.toHaveBeenCalled();
});

it('refuses a destination removed during transcription', () => {
  const target = resolveImportDestination({ folderId: 5, isPrivate: false });
  repo.getFolders.mockReturnValue([]);
  expect(() => saveImportedNote(target, 'Text', 'Audio.wav')).toThrow(
    'folder is no longer available',
  );
  expect(repo.createNote).not.toHaveBeenCalled();
});

it('refuses a folder moved into another space during transcription', () => {
  const target = resolveImportDestination({ folderId: 5, isPrivate: false });
  repo.getFolders.mockReturnValue([{ id: 5, spaceId: 1 }] as never);
  expect(() => saveImportedNote(target, 'Text', 'Audio.wav')).toThrow('destination changed');
  expect(repo.createNote).not.toHaveBeenCalled();
});

it('refuses a team space whose membership disappeared', () => {
  const target = resolveImportDestination({ spaceId: 2, isPrivate: false });
  spaces.listSpaces.mockReturnValue([mockPersonal] as never);
  expect(() => saveImportedNote(target, 'Text', 'Audio.wav')).toThrow(
    'space is no longer available',
  );
  expect(repo.createNote).not.toHaveBeenCalled();
});
