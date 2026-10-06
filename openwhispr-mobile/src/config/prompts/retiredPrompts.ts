import * as Crypto from 'expo-crypto';
import { customPromptStorageKey, type PromptKind } from './registry';

// Port of desktop src/config/retiredPrompts.js: SHA-256 hashes of every default
// prompt the apps have shipped. Old desktop releases persisted the then-current
// default as a "custom" prompt, where it shadows every default shipped since.
// The sweep clears a stored override only when it byte-matches one of these;
// a user edit of even one character hashes differently and is never touched.
// Mobile carries the registry so a stale default can't survive a future sync.
//
// When a shipped default changes: move its hash from CURRENT to RETIRED and
// add the new one (retiredPrompts.test fails until both are updated).

export const RETIRED_DEFAULT_PROMPT_HASHES: ReadonlySet<string> = new Set([
  //    65ch 28ac9b59 ReasoningService.ts DEFAULT_PROMPTS.regular (+24 more)
  '79abaafa51ba1fe06614d5392d6879f458b3ffc1f9e727528d6a9c896c530365',
  //   165ch 28ac9b59 ReasoningService.ts DEFAULT_PROMPTS.agent (+24 more)
  'c7451d27f2a2a109d1a1849b04f3a637798381cf93ac622872688222de87f449',
  //   173ch 88ce1814 promptData.json LEGACY_PROMPTS.regular (+6 more)
  '66b8adbc0beb6b22498e9dc00001d5f4c27d772890d2b1c7a98c0fdb8a92325f',
  //   256ch 88ce1814 promptData.json LEGACY_PROMPTS.agent (+6 more)
  '9c5aa22bc866d9ec6d6f93def82354537e831819926feb74ef55340d1c7afa1c',
  //   931ch ed117e27 zh-TW cleanupPrompt (+1 more)
  'b58b5b339ea425b615bbb4cf40708ab2269ae6ba9d6ff9613b37c5c867b65962',
  //   937ch 2f0637ed zh-TW cleanupPrompt
  '555b20380886213031250560364f7c677abec1ebec883746d260d05fbcba580e',
  //   952ch 2f0637ed zh-CN cleanupPrompt
  'a14e00cf10e3f872e634d9d918cd07e6b8437356512759c49ed0fd544f6f1f61',
  //  1095ch a3c63ce1 pt cleanupPrompt
  '34024d7d3994248b76b043e80b301b63b9562b4ed5120fada5a0e076c2f70aae',
  //  1170ch a3c63ce1 it cleanupPrompt
  '296ca433abc59a1428d81d208795c5e12fbebad4d6bf726650ee036b75cd8faa',
  //  1207ch a3c63ce1 de cleanupPrompt
  'f9f802aaf81b440793cf607f54c20ef3e88a8782133541d51cc70a79ea170fcd',
  //  1239ch 1c1e3db1 ja cleanupPrompt
  'bc4344d2c952fde6085fb92efa96f14dc6446ed869bd41f26a1227b1ab53b0f2',
  //  1296ch a3c63ce1 fr cleanupPrompt
  'aea75b29c3fa9c0adfea20c3a940768fed02ec52422dfa4082a0d395059d4089',
  //  1418ch a3c63ce1 es cleanupPrompt
  '376aa65adbb640b236d8a1e96c657fd426b20e49de65a4e9914e420798b48e76',
  //  1517ch ea9fd583 promptData.json CLEANUP_PROMPT (+1 more)
  '0fc56bad8e19cfd523d436d5bbf8022ce41ace0de74be9205c08c44f3545c65b',
  //  1629ch 88ce1814 promptData.json CLEANUP_PROMPT (+1 more)
  'a6acdbe8005a320c802a2b72e0b779f6707207f7a4be4e797c39289ce63cd6df',
  //  1749ch 2804af04 en cleanupPrompt (+1 more)
  '6334e82181b678ca5d7670e1d101c032729509f4daf3e0f38206cb56e25b9fbe',
  //  2047ch 2f0637ed zh-TW fullPrompt
  '2dfd35dcbfad136ad51d1741c1ecd865e3659d40373022822bb103c7b5ef75f5',
  //  2047ch e794b337 zh-TW fullPrompt (+2 more)
  '7c97f7e6dae37d384d2ce44fff020622402b8cff968cb61df8f38b0b6c90ff23',
  //  2070ch e794b337 zh-CN fullPrompt (+1 more)
  '772d7680d17ef1b26cbc1aa923af55b513df871ca7ea92188837cfca02b6bafe',
  //  2632ch e794b337 ja fullPrompt (+1 more)
  '14dfe90903d0b3b6ed21e2d6b9d55782a86de6c87113d990d1decd91793694f8',
  //  2708ch 560f0973 promptData.json CLEANUP_PROMPT (+1 more)
  '774da7ce7c876581a95f408e1c0e2d698a3e2f40f3790dd4c190737199835a73',
  //  3040ch bb664542 ru cleanupPrompt
  '91f52cc9967b29ccb69f759adc2591b82105dfb0fd5cd1b47aaed588bf1e4102',
  //  3126ch 88ce1814 promptData.json FULL_PROMPT (+4 more)
  '72f77f2b23f8bcdb9a54b47f187f85804ff736736f71fe72f94908165ca462d6',
  //  4448ch e3969d05 promptData.json UNIFIED_SYSTEM_PROMPT (+1 more)
  '055f1ba27ebbc09f1e0808fdb4a6972ae57f9b7cad07ffc26fdbb1b35d88a47e',
  //  4560ch e794b337 pt fullPrompt (+1 more)
  'f3d2ed749d4bf3a5851b1e1b727b8157a3a832bb79a7298f0ad4011b72f1dd49',
  //  4749ch e794b337 it fullPrompt (+1 more)
  'c02185317c2e412ff01265be01ed4944cb10956ab894619bf7129aa7bd842eaf',
  //  4838ch e794b337 es fullPrompt (+1 more)
  '18833862070391a6b607a1489251707420924d0ba1edecb532c88d927c6d768e',
  //  4919ch e794b337 de fullPrompt (+1 more)
  'a2ec8d14150c68b3fcddeea53d8fb16612b823e51ec3886a990943910239684a',
  //  4988ch e794b337 fr fullPrompt (+1 more)
  '62916354d5877daa1b0a58054f58171696d6a50d8d96d7a9b6ee77e06cf960ba',
  //  5265ch 560f0973 promptData.json FULL_PROMPT (+1 more)
  'da949ad38781c948306f1b43c6259a15825796eddfae0828fe7fe2cae813e990',
  //  5762ch e794b337 ru fullPrompt (+1 more)
  '969a7e84fbe1f18f1969eb2566c2394ecde11b6d659f2b4bdb9a030f3a07b8d2',
  //  7473ch 173642e6 promptData.json UNIFIED_SYSTEM_PROMPT
  '88aa19874565e2c0621485640b71d45ab89f6f8237f178dd71d44c4b0c92941f',
  //  9888ch 1e3ed5d3 promptData.json UNIFIED_SYSTEM_PROMPT
  'c667ef52a6ae19354cd5f93f06dca6372df09e8a87ecd81179e65f45e7543081',
]);

// Hashes of the defaults currently shipped on mobile. Not used by the sweep;
// the registry test compares these against DEFAULT_CLEANUP_PROMPT so a prompt
// change cannot land without updating the retired set.
export const CURRENT_DEFAULT_PROMPT_HASHES: Partial<Record<PromptKind, string>> = {
  cleanup: '58ed65fbc679a7bac1483ef850c51ac7932a02d17fab9ca688f4d11f6aa9b7e6',
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Null when the native digest is unavailable (jest-expo, see lib/uuid.ts) so
// callers degrade to "not retired" instead of throwing.
export async function hashPromptText(text: string): Promise<string | null> {
  try {
    const digest: unknown = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      text,
    );
    return typeof digest === 'string' && SHA256_HEX.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

export async function isRetiredDefaultPrompt(text: unknown): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) return false;
  const hash = await hashPromptText(text);
  return hash !== null && RETIRED_DEFAULT_PROMPT_HASHES.has(hash);
}

export type PromptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Clears customPrompt.<kind> overrides that byte-match a retired shipped
// default, archiving each swept value under customPrompt.<kind>.retired.
// Safe to run on every startup: user-edited prompts never match, and a swept
// key is simply absent on the next run.
export async function sweepRetiredPromptOverrides(
  storage: PromptStorage,
  kinds: readonly PromptKind[],
): Promise<PromptKind[]> {
  const swept: PromptKind[] = [];
  for (const kind of kinds) {
    try {
      const key = customPromptStorageKey(kind);
      const value = storage.getItem(key);
      if (!value) continue;
      if (!(await isRetiredDefaultPrompt(value))) continue;
      // Re-read before removing: the user may have saved a new prompt while
      // the hash was being computed.
      if (storage.getItem(key) !== value) continue;
      storage.setItem(`${key}.retired`, value);
      storage.removeItem(key);
      swept.push(kind);
    } catch {
      // Storage failures skip this kind; the sweep retries on next startup.
    }
  }
  return swept;
}
