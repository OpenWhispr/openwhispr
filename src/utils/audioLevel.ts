/** RMS of an analyser's current time-domain window, reusing `buf` across reads. */
export function analyserRms(
  analyser: AnalyserNode,
  buf: { current: Float32Array<ArrayBuffer> | null }
): number {
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(buf.current);
  let sumSquares = 0;
  for (let i = 0; i < buf.current.length; i++) {
    const v = buf.current[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / buf.current.length);
}
