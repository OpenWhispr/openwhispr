jest.mock('@/lib/apiClient', () => ({
  api: { get: jest.fn() },
}));

import { api } from '@/lib/apiClient';
import { fetchSharedDictionary, fetchSharedDictionaryHides } from '../sharedDictionaryApi';

const mockGet = api.get as jest.Mock;

const WORKSPACE_ID = '7b0c2f5e-1d4a-4a52-9a3e-0c1f6f1d2b11';

describe('sharedDictionaryApi', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('fetchSharedDictionary', () => {
    it('builds /api/shared-dictionary/list?workspace_id=W&since=S&since_id=I&limit=200', async () => {
      mockGet.mockResolvedValue({ entries: [], hasMore: false, scopes: [], paused: false });

      await fetchSharedDictionary(WORKSPACE_ID, {
        since: '2026-10-20T10:00:00.000Z',
        sinceId: 'entry-1',
        limit: 200,
      });

      const expected = new URLSearchParams({
        workspace_id: WORKSPACE_ID,
        since: '2026-10-20T10:00:00.000Z',
        since_id: 'entry-1',
        limit: '200',
      }).toString();
      expect(mockGet).toHaveBeenCalledWith(`/api/shared-dictionary/list?${expected}`);
    });

    it('uses the cursor keyset for snapshot pages and omits unset params', async () => {
      mockGet.mockResolvedValue({ entries: [], hasMore: false, scopes: [], paused: false });

      await fetchSharedDictionary(WORKSPACE_ID, {
        cursor: '2026-10-19T08:00:00.000Z',
        cursorId: 'entry-9',
      });

      const url = new URL(`https://x${mockGet.mock.calls[0][0]}`);
      expect(url.pathname).toBe('/api/shared-dictionary/list');
      expect(url.searchParams.get('workspace_id')).toBe(WORKSPACE_ID);
      expect(url.searchParams.get('cursor')).toBe('2026-10-19T08:00:00.000Z');
      expect(url.searchParams.get('cursor_id')).toBe('entry-9');
      expect(url.searchParams.has('since')).toBe(false);
      expect(url.searchParams.has('since_id')).toBe(false);
      expect(url.searchParams.has('limit')).toBe(false);
    });

    it('returns entries, scopes, paused and server_time, ignoring other fields', async () => {
      const entry = {
        id: 'e1',
        workspace_id: WORKSPACE_ID,
        space_id: null,
        word: 'Kubernetes',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
        deleted_at: null,
      };
      const scope = { space_id: null, name: 'Acme', member_count: 4, word_count: 1 };
      mockGet.mockResolvedValue({
        entries: [entry],
        hasMore: true,
        scopes: [scope],
        contributors: [{ id: 'u1' }],
        paused: true,
        server_time: '2026-10-20T10:00:00.000Z',
      });

      const result = await fetchSharedDictionary(WORKSPACE_ID, {});

      expect(result).toEqual({
        entries: [entry],
        hasMore: true,
        scopes: [scope],
        paused: true,
        server_time: '2026-10-20T10:00:00.000Z',
      });
    });

    it('defaults hasMore, scopes and paused when the server omits them', async () => {
      mockGet.mockResolvedValue({ entries: [], server_time: '2026-10-20T10:00:00.000Z' });

      const result = await fetchSharedDictionary(WORKSPACE_ID, {});

      expect(result).toMatchObject({ hasMore: false, scopes: [], paused: false });
    });
  });

  describe('fetchSharedDictionaryHides', () => {
    it('builds /api/shared-dictionary/hides?workspace_id=W&since=S&since_id=I&limit=500', async () => {
      mockGet.mockResolvedValue({ hides: [], hasMore: false, server_time: 't' });

      await fetchSharedDictionaryHides(WORKSPACE_ID, {
        since: '2026-10-20T10:00:00.000Z',
        sinceId: 'entry-1',
        limit: 500,
      });

      const expected = new URLSearchParams({
        workspace_id: WORKSPACE_ID,
        since: '2026-10-20T10:00:00.000Z',
        since_id: 'entry-1',
        limit: '500',
      }).toString();
      expect(mockGet).toHaveBeenCalledWith(`/api/shared-dictionary/hides?${expected}`);
    });

    it('returns hides, hasMore and server_time', async () => {
      const hide = {
        entry_id: 'e1',
        workspace_id: WORKSPACE_ID,
        updated_at: '2026-10-02T00:00:00.000Z',
        deleted_at: null,
      };
      mockGet.mockResolvedValue({
        hides: [hide],
        hasMore: false,
        server_time: '2026-10-20T10:00:00.000Z',
      });

      await expect(fetchSharedDictionaryHides(WORKSPACE_ID, {})).resolves.toEqual({
        hides: [hide],
        hasMore: false,
        server_time: '2026-10-20T10:00:00.000Z',
      });
    });
  });
});
