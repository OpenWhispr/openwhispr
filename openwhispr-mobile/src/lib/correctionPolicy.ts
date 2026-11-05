// iOS retains the upstream correction heuristics; Android filters unfinished/replaced text.
export function acceptsCorrectionEdit(_original: string, _edited: string): boolean {
  return true;
}
export function retainsCorrectionContext(_original: string[], _edited: string[]): boolean {
  return true;
}
