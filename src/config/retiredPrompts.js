// Registry of default prompt texts the app has shipped over time, as SHA-256
// hashes. Old releases persisted the then-current default prompt into
// localStorage as a "custom" prompt (unedited Prompt Studio saves, plus the
// customUnifiedPrompt/customPrompts migrations), where it permanently shadows
// every default shipped since. The sweep below clears a stored override only
// when it byte-matches one of these retired defaults; anything a user edited,
// even by one character, hashes differently and is never touched.
//
// Extracted from every revision of src/config/promptData.json,
// src/locales/*/prompts.json, prompts.ts and ReasoningService.ts on main.
// When a shipped default changes: move its hash from
// CURRENT_DEFAULT_PROMPT_HASHES to RETIRED_DEFAULT_PROMPT_HASHES and add the
// new hash (the registry test walks the locale bundles and fails until both
// sides are updated).

export const RETIRED_DEFAULT_PROMPT_HASHES = new Set([
  //    65ch 28ac9b59 ReasoningService.ts DEFAULT_PROMPTS.regular (+24 more)
  "79abaafa51ba1fe06614d5392d6879f458b3ffc1f9e727528d6a9c896c530365",
  //   165ch 28ac9b59 ReasoningService.ts DEFAULT_PROMPTS.agent (+24 more)
  "c7451d27f2a2a109d1a1849b04f3a637798381cf93ac622872688222de87f449",
  //   173ch 88ce1814 promptData.json LEGACY_PROMPTS.regular (+6 more)
  "66b8adbc0beb6b22498e9dc00001d5f4c27d772890d2b1c7a98c0fdb8a92325f",
  //   256ch 88ce1814 promptData.json LEGACY_PROMPTS.agent (+6 more)
  "9c5aa22bc866d9ec6d6f93def82354537e831819926feb74ef55340d1c7afa1c",
  //   931ch ed117e27 zh-TW cleanupPrompt (+1 more)
  "b58b5b339ea425b615bbb4cf40708ab2269ae6ba9d6ff9613b37c5c867b65962",
  //   937ch 2f0637ed zh-TW cleanupPrompt
  "555b20380886213031250560364f7c677abec1ebec883746d260d05fbcba580e",
  //   952ch 2f0637ed zh-CN cleanupPrompt
  "a14e00cf10e3f872e634d9d918cd07e6b8437356512759c49ed0fd544f6f1f61",
  //  1095ch a3c63ce1 pt cleanupPrompt
  "34024d7d3994248b76b043e80b301b63b9562b4ed5120fada5a0e076c2f70aae",
  //  1170ch a3c63ce1 it cleanupPrompt
  "296ca433abc59a1428d81d208795c5e12fbebad4d6bf726650ee036b75cd8faa",
  //  1207ch a3c63ce1 de cleanupPrompt
  "f9f802aaf81b440793cf607f54c20ef3e88a8782133541d51cc70a79ea170fcd",
  //  1239ch 1c1e3db1 ja cleanupPrompt
  "bc4344d2c952fde6085fb92efa96f14dc6446ed869bd41f26a1227b1ab53b0f2",
  //  1296ch a3c63ce1 fr cleanupPrompt
  "aea75b29c3fa9c0adfea20c3a940768fed02ec52422dfa4082a0d395059d4089",
  //  1418ch a3c63ce1 es cleanupPrompt
  "376aa65adbb640b236d8a1e96c657fd426b20e49de65a4e9914e420798b48e76",
  //  1517ch ea9fd583 promptData.json CLEANUP_PROMPT (+1 more)
  "0fc56bad8e19cfd523d436d5bbf8022ce41ace0de74be9205c08c44f3545c65b",
  //  1629ch 88ce1814 promptData.json CLEANUP_PROMPT (+1 more)
  "a6acdbe8005a320c802a2b72e0b779f6707207f7a4be4e797c39289ce63cd6df",
  //  1749ch 2804af04 en cleanupPrompt (+1 more)
  "6334e82181b678ca5d7670e1d101c032729509f4daf3e0f38206cb56e25b9fbe",
  //  2047ch 2f0637ed zh-TW fullPrompt
  "2dfd35dcbfad136ad51d1741c1ecd865e3659d40373022822bb103c7b5ef75f5",
  //  2047ch e794b337 zh-TW fullPrompt (+2 more)
  "7c97f7e6dae37d384d2ce44fff020622402b8cff968cb61df8f38b0b6c90ff23",
  //  2070ch e794b337 zh-CN fullPrompt (+1 more)
  "772d7680d17ef1b26cbc1aa923af55b513df871ca7ea92188837cfca02b6bafe",
  //  2632ch e794b337 ja fullPrompt (+1 more)
  "14dfe90903d0b3b6ed21e2d6b9d55782a86de6c87113d990d1decd91793694f8",
  //  2708ch 560f0973 promptData.json CLEANUP_PROMPT (+1 more)
  "774da7ce7c876581a95f408e1c0e2d698a3e2f40f3790dd4c190737199835a73",
  //  3040ch bb664542 ru cleanupPrompt
  "91f52cc9967b29ccb69f759adc2591b82105dfb0fd5cd1b47aaed588bf1e4102",
  //  3126ch 88ce1814 promptData.json FULL_PROMPT (+4 more)
  "72f77f2b23f8bcdb9a54b47f187f85804ff736736f71fe72f94908165ca462d6",
  //  4448ch e3969d05 promptData.json UNIFIED_SYSTEM_PROMPT (+1 more)
  "055f1ba27ebbc09f1e0808fdb4a6972ae57f9b7cad07ffc26fdbb1b35d88a47e",
  //  4560ch e794b337 pt fullPrompt (+1 more)
  "f3d2ed749d4bf3a5851b1e1b727b8157a3a832bb79a7298f0ad4011b72f1dd49",
  //  4749ch e794b337 it fullPrompt (+1 more)
  "c02185317c2e412ff01265be01ed4944cb10956ab894619bf7129aa7bd842eaf",
  //  4838ch e794b337 es fullPrompt (+1 more)
  "18833862070391a6b607a1489251707420924d0ba1edecb532c88d927c6d768e",
  //  4919ch e794b337 de fullPrompt (+1 more)
  "a2ec8d14150c68b3fcddeea53d8fb16612b823e51ec3886a990943910239684a",
  //  4988ch e794b337 fr fullPrompt (+1 more)
  "62916354d5877daa1b0a58054f58171696d6a50d8d96d7a9b6ee77e06cf960ba",
  //  5265ch 560f0973 promptData.json FULL_PROMPT (+1 more)
  "da949ad38781c948306f1b43c6259a15825796eddfae0828fe7fe2cae813e990",
  //  5762ch e794b337 ru fullPrompt (+1 more)
  "969a7e84fbe1f18f1969eb2566c2394ecde11b6d659f2b4bdb9a030f3a07b8d2",
  //  7473ch 173642e6 promptData.json UNIFIED_SYSTEM_PROMPT
  "88aa19874565e2c0621485640b71d45ab89f6f8237f178dd71d44c4b0c92941f",
  //  9888ch 1e3ed5d3 promptData.json UNIFIED_SYSTEM_PROMPT
  "c667ef52a6ae19354cd5f93f06dca6372df09e8a87ecd81179e65f45e7543081",
]);

// Hashes of the defaults currently shipped, keyed by locale/bundle key. Not
// used by the sweep; the registry test compares these against the live locale
// bundles so a prompt change cannot land without updating the retired set.
export const CURRENT_DEFAULT_PROMPT_HASHES = {
  "de/cleanupPrompt": "89452bfcce253803ae9fd9b0e9fc3f50afbf9c8d89706ad92dfc48d1e29ec4af",
  "de/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "de/translatePrompt": "818b9176518120cd7889726574b61026733ffb69768d3d00e417c28389e5875e",
  "en/cleanupPrompt": "58ed65fbc679a7bac1483ef850c51ac7932a02d17fab9ca688f4d11f6aa9b7e6",
  "en/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "en/translatePrompt": "2acf77e82671cfb27f56210461369cca96da52d68597dd825bb5f3cf7fd4cd47",
  "es/cleanupPrompt": "3a977c7d5435d799873a1003d68924b08a51d720386fe8cc9ac16304607df56d",
  "es/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "es/translatePrompt": "ebbe5a397e989bb3c1068e2fd186f27aa12a29150ed4d335734a9b9ff3c8c025",
  "fr/cleanupPrompt": "8e97d2a98decbba356733bfdd7fb4aff2ec157eab177ad4fd06003cecc32aa56",
  "fr/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "fr/translatePrompt": "14d5e101c3258669c73fe4968ddbe749c65848b339a334392bcb43cd6acb772e",
  "it/cleanupPrompt": "cdc5472ffa032e9cb508fa8e25acb7f64d29840e0a248e7d97d90f6f6b9fc6f0",
  "it/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "it/translatePrompt": "6c44f9899ddbd9f0cb0b925f4763408548839d8e2aee404cf23e4a5f7d966e5c",
  "ja/cleanupPrompt": "fd8903a8ae80ab6baca57217b7505777378e4a2f7b15f31274deb4b52fcb0b8d",
  "ja/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "ja/translatePrompt": "f8835cda69a81c7979a59c2770eb0377cc30979855fee1f84b0f876fd6d99e29",
  "pt/cleanupPrompt": "2de91bc76da3682dc819297616966d1e90ba511ca8fcb5232691710e712da619",
  "pt/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "pt/translatePrompt": "a108543fd389248279ac251b473697adae1cfe44adcaa9bd5a5cefd2e8a4df63",
  "ru/cleanupPrompt": "caa4cb470101df0f494a2e323548aabe4bcc28318938ade7487f7d1507f6eb8e",
  "ru/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "ru/translatePrompt": "d395352106e834778deca6f54e6285eddb28bc7739d242048988fa581e8f48be",
  "zh-CN/cleanupPrompt": "c38d3f454a576f6d5c3a22294215283cfc04da7b370d7bdb7e1b123d6e89f055",
  "zh-CN/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "zh-CN/translatePrompt": "f1b9e55ad9e3ccf3982e741e5d2d291c1db7c0054f5a3a8996bc3ee02581f61b",
  "zh-TW/cleanupPrompt": "9b586c6141f09263fdf9d06973b9bb9579fc325b2b6f906a0a7804f9418824be",
  "zh-TW/fullPrompt": "9312644f8de56d874e0de9e18d610a3ed6afd0ca1b31411f02d021e012fee601",
  "zh-TW/translatePrompt": "6b1c867216603f9741d13b8c564fcf6d484c817e69e2c7d6fe2de83118ed862e",
  chatAgent: "ca35b88c4f8a0e1fd0b2b6efea1b066c70b772e6a55033e0fca731b2e74fbf06",
};

export async function hashPromptText(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isRetiredDefaultPrompt(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (!globalThis.crypto?.subtle) return false;
  return RETIRED_DEFAULT_PROMPT_HASHES.has(await hashPromptText(text));
}

// Clears customPrompt.<kind> overrides that byte-match a retired shipped
// default, archiving each swept value under customPrompt.<kind>.retired.
// Safe to run on every startup: user-edited prompts never match, and a swept
// key is simply absent on the next run.
export async function sweepRetiredPromptOverrides(storage, kinds) {
  const swept = [];
  for (const kind of kinds) {
    try {
      const key = `customPrompt.${kind}`;
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
