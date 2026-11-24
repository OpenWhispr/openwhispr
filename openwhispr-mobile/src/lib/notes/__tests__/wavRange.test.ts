import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { extractWavRange, splitWindows, WAV_HEADER_BYTES, wavByteRange } from '../wavRange';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
}));

const FILE_BYTES = WAV_HEADER_BYTES + 320_000;

describe('wavByteRange', (): void => {
  it('maps milliseconds to byte offsets past the header', (): void => {
    expect(wavByteRange(1000, 3000, FILE_BYTES)).toEqual({ offset: 44 + 32_000, length: 64_000 });
  });

  it('clamps to the data in the file', (): void => {
    expect(wavByteRange(9000, 20_000, FILE_BYTES)).toEqual({
      offset: 44 + 288_000,
      length: 32_000,
    });
  });

  it('gives length 0 for an empty range or a start beyond the end', (): void => {
    expect(wavByteRange(5000, 5000, FILE_BYTES).length).toBe(0);
    expect(wavByteRange(20_000, 30_000, FILE_BYTES).length).toBe(0);
  });

  it('aligns to whole samples', (): void => {
    const { offset, length } = wavByteRange(1, 3, FILE_BYTES);
    expect((offset - WAV_HEADER_BYTES) % 2).toBe(0);
    expect(length % 2).toBe(0);
  });
});

describe('splitWindows', (): void => {
  it('splits long windows and keeps a long enough remainder', (): void => {
    expect(splitWindows([{ startMs: 0, endMs: 250_000 }], 120_000, 2000)).toEqual([
      { startMs: 0, endMs: 120_000 },
      { startMs: 120_000, endMs: 240_000 },
      { startMs: 240_000, endMs: 250_000 },
    ]);
  });

  it('drops pieces shorter than the minimum, remainders included', (): void => {
    expect(splitWindows([{ startMs: 0, endMs: 1500 }], 120_000, 2000)).toEqual([]);
    expect(splitWindows([{ startMs: 0, endMs: 121_000 }], 120_000, 2000)).toEqual([
      { startMs: 0, endMs: 120_000 },
    ]);
  });
});

describe('extractWavRange', (): void => {
  beforeEach((): void => {
    jest.clearAllMocks();
    jest.mocked(FileSystem.getInfoAsync).mockResolvedValue({
      exists: true,
      isDirectory: false,
      uri: 'file:///source.wav',
      size: FILE_BYTES,
      modificationTime: 0,
    });
  });

  it('writes a valid header and exactly the requested bytes', async (): Promise<void> => {
    const data = Buffer.alloc(64_000, 7);
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue(data.toString('base64'));

    const uri = await extractWavRange('file:///source.wav', 1000, 3000);

    expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith('file:///source.wav', {
      encoding: 'base64',
      position: 44 + 32_000,
      length: 64_000,
    });
    expect(uri).toMatch(/^file:\/\/\/cache\/.+\.wav$/);
    const [dest, base64] = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0];
    expect(dest).toBe(uri);
    const written = Buffer.from(base64, 'base64');
    expect(written.length).toBe(44 + 64_000);
    expect(written.toString('ascii', 0, 4)).toBe('RIFF');
    expect(written.readUInt32LE(4)).toBe(36 + 64_000);
    expect(written.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(written.readUInt32LE(16)).toBe(16);
    expect(written.readUInt16LE(20)).toBe(1);
    expect(written.readUInt16LE(22)).toBe(1);
    expect(written.readUInt32LE(24)).toBe(16_000);
    expect(written.readUInt32LE(28)).toBe(32_000);
    expect(written.readUInt16LE(32)).toBe(2);
    expect(written.readUInt16LE(34)).toBe(16);
    expect(written.toString('ascii', 36, 40)).toBe('data');
    expect(written.readUInt32LE(40)).toBe(64_000);
    expect(written.subarray(44).equals(data)).toBe(true);
  });

  it('rejects an empty range without writing a file', async (): Promise<void> => {
    await expect(extractWavRange('file:///source.wav', 20_000, 30_000)).rejects.toThrow();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });
});
