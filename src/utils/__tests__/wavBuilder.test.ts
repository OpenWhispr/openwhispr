import { describe, it, expect } from "vitest";
import { buildWav } from "../wavBuilder";

describe("buildWav", () => {
  function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return blob.arrayBuffer();
  }

  it("returns a Blob with audio/wav MIME type", () => {
    const samples = new Int16Array([0, 100, -100]);
    const blob = buildWav(samples, 16000);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/wav");
  });

  it("produces correct total size (44-byte header + sample data)", () => {
    const samples = new Int16Array(100);
    const blob = buildWav(samples, 16000);
    // 44 bytes header + 100 samples * 2 bytes each = 244
    expect(blob.size).toBe(244);
  });

  it("writes correct RIFF header", async () => {
    const samples = new Int16Array([1, 2, 3]);
    const blob = buildWav(samples, 44100);
    const buffer = await blobToArrayBuffer(blob);
    const view = new DataView(buffer);

    // "RIFF" magic
    const riff = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    );
    expect(riff).toBe("RIFF");

    // File size - 8 = total - 8
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);

    // "WAVE" format
    const wave = String.fromCharCode(
      view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
    );
    expect(wave).toBe("WAVE");
  });

  it("writes correct fmt chunk", async () => {
    const sampleRate = 16000;
    const samples = new Int16Array([0]);
    const blob = buildWav(samples, sampleRate);
    const buffer = await blobToArrayBuffer(blob);
    const view = new DataView(buffer);

    // fmt chunk ID
    const fmt = String.fromCharCode(
      view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15)
    );
    expect(fmt).toBe("fmt ");

    // Subchunk1 size (16 for PCM)
    expect(view.getUint32(16, true)).toBe(16);
    // Audio format (1 = PCM)
    expect(view.getUint16(20, true)).toBe(1);
    // Number of channels (1 = mono)
    expect(view.getUint16(22, true)).toBe(1);
    // Sample rate
    expect(view.getUint32(24, true)).toBe(sampleRate);
    // Byte rate = sampleRate * 2 (16-bit mono)
    expect(view.getUint32(28, true)).toBe(sampleRate * 2);
    // Block align (2 bytes for 16-bit mono)
    expect(view.getUint16(32, true)).toBe(2);
    // Bits per sample
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("writes correct data chunk with sample values", async () => {
    const samples = new Int16Array([0, 32767, -32768]);
    const blob = buildWav(samples, 44100);
    const buffer = await blobToArrayBuffer(blob);
    const view = new DataView(buffer);

    // "data" chunk ID
    const data = String.fromCharCode(
      view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39)
    );
    expect(data).toBe("data");

    // Data size
    expect(view.getUint32(40, true)).toBe(6); // 3 samples * 2 bytes

    // Sample values
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("handles empty sample array", () => {
    const samples = new Int16Array(0);
    const blob = buildWav(samples, 16000);
    expect(blob.size).toBe(44); // header only
  });
});
