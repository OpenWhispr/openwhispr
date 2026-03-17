# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4](https://github.com/jrschumacher/cloudfree-openwhispr/compare/v1.0.3...v1.0.4) (2026-03-17)


### Bug Fixes

* trigger release with signing workflow fixes ([c81743e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c81743ef87ce3a0917c528d794e0286a7508b61d))

## [1.0.3](https://github.com/jrschumacher/cloudfree-openwhispr/compare/v1.0.2...v1.0.3) (2026-03-17)


### Bug Fixes

* allow build jobs to run on workflow_dispatch ([5a1e4b9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5a1e4b95aa808cd6bc15c001549bdc00458de377))

## [1.0.2](https://github.com/jrschumacher/cloudfree-openwhispr/compare/v1.0.1...v1.0.2) (2026-03-17)


### Bug Fixes

* set APPLE_CERTIFICATE_BASE64 as job-level env for signing check ([57269f9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/57269f94a26d342736c1a3f4bec97e2d2ac07c81))
* use secrets context for code signing conditional check ([dd3260f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/dd3260fabf291cd879ca47a70631beaac60ceb9f))

## [1.0.1](https://github.com/jrschumacher/cloudfree-openwhispr/compare/v1.0.0...v1.0.1) (2026-03-17)


### Bug Fixes

* sync lockfile with Node 22 and update signing identity ([b4d0c56](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b4d0c56b60be8457d2446c09eed38031d946498d))

## 1.0.0 (2026-03-16)


### Features

* add Agent Mode with glassmorphism chat overlay ([bd72e9d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bd72e9d3e5f19e8dfee74af83e0906a2bbe5f9b5))
* add auto-paste toggle in clipboard settings ([3ea55e9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3ea55e954031a1505a29de759fbff4acc0df8e3b))
* add Business tier and redesign pricing grid with per-card billi… ([5b09015](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5b090159b8c207c145e6f028d575700d087ef4fe))
* add Business tier and redesign pricing grid with per-card billing toggles ([0069f97](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0069f973e63a13490fc64d321f8f87bfccba327e))
* add chinse (simplified and traditional) to interface language options ([2f0637e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2f0637ed977d6f22bf2239eb1072f09d4039ef0d))
* add Claude 4.6, Gemini 3 Flash, and Gemini 3.1 Pro models ([#301](https://github.com/jrschumacher/cloudfree-openwhispr/issues/301)) ([9ae751a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9ae751a49879bb221ca0f340e92814dc886bff16))
* add clear-all button for transcription history ([139b84c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/139b84c57e24a279911b137d353966cbd66d94bc))
* add Cmd+B, Cmd+I, Cmd+E formatting shortcuts to notes editor ([1a9432c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1a9432c92db9ee72c56bf456eec6b108b90a46ac))
* add configurable start position for voice recorder panel ([3d51f5d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3d51f5d66120e32b44413f6c19fa1c5e30ce7b73))
* add Gemma 3 local models to model registry ([c76cec0](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c76cec0977c8d020aec193c0ea15f3630bfd3243))
* add granular build scripts for individual targets ([#339](https://github.com/jrschumacher/cloudfree-openwhispr/issues/339)) ([a762a0b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a762a0b1c155a8c2b89cb029a8a16e5332469fa7))
* add helpful CTA on failed transcriptions guiding users to settings ([0450ff0](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0450ff01d86e35495cd4a28f24455b53e0ad013f))
* add in-app plan switching with proration preview dialog ([fa77321](https://github.com/jrschumacher/cloudfree-openwhispr/commit/fa77321d140001630b121e3d6ced9e155230e517))
* add Integrations tab with Google Calendar multi-account support ([58aad3d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/58aad3dea6389598ba3e4a14d7db58f97a7348d6))
* add Mistral Voxtral transcription support ([#227](https://github.com/jrschumacher/cloudfree-openwhispr/issues/227)) ([d53d9f2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d53d9f288d9068701bfb1da20df0ac240a972d1c))
* add model validation on delete/load and download cancellation for whisper pickers ([365edd4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/365edd4ddd35be9e880aea1d432890c8d70cd086))
* add nircmd for faster windows pasting ([a594ed4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a594ed4003660886006c5f3fa18105de0d06bec2))
* Add ONNX warm-up inference on Parakeet server start to eliminate first-request latency from JIT compilation ([5f02d5c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5f02d5ccad55faba8ad0a946de0a8516ad4fa479))
* add OpenWhispr Cloud and Groq provider support to Prompt Studio ([e2b8bec](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e2b8bec9e5f4ddb4483a20f1a2cf7fdb59a19010))
* add optional screen recording permission card to onboarding (macOS) ([e7ece21](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e7ece2132ab5a8e76df0cf7f05d1489fd5a41fae))
* add periodic update check every 4 hours ([06da9d4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/06da9d4bb3fb258b0590f05fd0bec65218446b32))
* add pipeline timing instrumentation and whisper-server pre-warming ([e3919ce](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e3919cedcdd85581aeb72e7b8c40c06e0c34a5c7))
* add proactive token refresh and keyterms support for Deepgram streaming ([00185ff](https://github.com/jrschumacher/cloudfree-openwhispr/commit/00185ffe66ea1bdb24fd50881d8d42ef07700669))
* add russian to interface languages ([bb66454](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bb66454255c7008b2d3917204fe280e9e096e9aa))
* add start minimized option ([#387](https://github.com/jrschumacher/cloudfree-openwhispr/issues/387)) ([9661dbc](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9661dbc0a3ca83ce53db2de09127c85bf2491d41))
* add step-by-step guides for Wayland paste setup ([1352abf](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1352abfd6fbfbfc408029f9b14317ab133358601))
* add streaming liveness check, batch fallback, and full locale codes ([c589a56](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c589a563df477536b98b1bfe83f57c83f457a2fd))
* add system audio capture to note recording ([7721ba2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/7721ba2149f3c919db2c3cec24dfa28628870028))
* add Wayland paste diagnostics in settings ([9a0556d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9a0556db692d2ca2a40f85aeba29f239418956d2))
* add whisper-server HTTP mode for faster repeated transcriptions ([47201c5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/47201c53610b52337cbe6110b8369a71a45bfee3))
* add ydotool as required Linux dependency ([#346](https://github.com/jrschumacher/cloudfree-openwhispr/issues/346)) ([9e198a1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9e198a17a7ace9fc27dd0fc9887d43cf45b7c1da))
* add ydotool fallback on linux ([349cfd8](https://github.com/jrschumacher/cloudfree-openwhispr/commit/349cfd8d803c25fdac6fd764a74c7350e22897f7))
* agent mode window starts at full screen height with drag-to-resize ([ba78ef0](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ba78ef0ee6013d39069f0d8c01c6445bc9dba491))
* agent overlay hotkey display and cloud streaming fixes ([1fdd213](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1fdd21329d6ff16229daff560a2a5dcab3b20f67))
* allow usrs to retain their settings on pro ([2470316](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2470316505d6f67c60f021e3afdb87d419795fad))
* audio retention, raw transcript viewing, and hover actions ([1a1b054](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1a1b05450fc91b61848a136c681372d798029aea))
* **audio:** add microphone input selection with built-in mic preference to prevent Bluetooth audio interruptions ([b36c73f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b36c73ffbf45cc9887b79a242b3ebc2cd280d3bf))
* auto-enable system audio and simplify notes recording UX ([0d1de32](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0d1de324d93cfa11747787bb5b6af62656bc0323))
* auto-pause media playback during dictation ([2634114](https://github.com/jrschumacher/cloudfree-openwhispr/commit/263411420f97c815979bcb6ea711e0dc3d68dde2))
* auto-pause media playback during dictation ([#331](https://github.com/jrschumacher/cloudfree-openwhispr/issues/331)) ([13e6e62](https://github.com/jrschumacher/cloudfree-openwhispr/commit/13e6e62ba61cbcb76352e0003de0243b71d3ec84))
* batch meeting transcription via BaseTen chain ([21cf340](https://github.com/jrschumacher/cloudfree-openwhispr/commit/21cf3402f3457a8153877940e2dd34806f03e267))
* bulletproof meeting detection with process and audio layers ([ee1497b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ee1497b9186776c8f58deb36678f317114046840))
* cloud notes — local-first storage, FTS5, cloud sync and semantic search ([b85d90f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b85d90fb567acadc71206c8876aafbe160bf9666))
* Cmd+K command search across notes and transcripts ([dc52293](https://github.com/jrschumacher/cloudfree-openwhispr/commit/dc522935f7b6f3bd597d5fabfd78c40f12cefbab))
* config-driven STT routing with streaming provider adapter ([#324](https://github.com/jrschumacher/cloudfree-openwhispr/issues/324)) ([d41598c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d41598c6668198c16ee1a078b62531d7d908700c))
* CUDA GPU acceleration for local Whisper transcription ([#314](https://github.com/jrschumacher/cloudfree-openwhispr/issues/314)) ([d108e00](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d108e00592be845393721ec6e331140d15e9f86c))
* default notes live transcription to off for new users ([b5f415e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b5f415efd1685d27b75a2fda97e00ac6946d76f5))
* delete all whisper models ([baa669f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/baa669faca1c0981ffdbd99b4c2227f9f27de995))
* detailed clipboard debug logging ([1c229c8](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1c229c8417b46f76fb8f7f6abac0c53f48351692))
* extend OpenAI Realtime WebSocket streaming to normal dictation ([a730a3f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a730a3f5a796e81d749d7f8a868599ccf5b55be9))
* full meeting note flow — notification, window snap, live transcription ([5cc0ee9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5cc0ee91b8997f63eb68098798b748beccc0695a))
* gate meeting features behind screen recording permission on macOS ([acf1352](https://github.com/jrschumacher/cloudfree-openwhispr/commit/acf1352fb17db1380f81a19cf7a41bd345c4a403))
* gate meeting recording behind paid plan and add calendar integration messaging ([cbf91af](https://github.com/jrschumacher/cloudfree-openwhispr/commit/cbf91afbb068c6df37a4e845ab69bfa0a69fad2e))
* global hyprland hotkeys integration ([6cd1964](https://github.com/jrschumacher/cloudfree-openwhispr/commit/6cd196443cd422e9a19b828c5267a44f00d0442c))
* Google Calendar integration with meeting recording ([02d9a56](https://github.com/jrschumacher/cloudfree-openwhispr/commit/02d9a56d4c09ba898880a4c98906def202695367))
* GPU-accelerated local inference (Vulkan/Metal) ([#315](https://github.com/jrschumacher/cloudfree-openwhispr/issues/315)) ([8988876](https://github.com/jrschumacher/cloudfree-openwhispr/commit/898887628666dd9dc8d9e6ded26066e18a1e280d))
* handle past_due subscriptions and improve user-facing copy ([26c7c40](https://github.com/jrschumacher/cloudfree-openwhispr/commit/26c7c40581b30e34d7828a2149eb579ddc959398))
* harden model download pipeline with stall detection, disk space checks, and file validation ([#248](https://github.com/jrschumacher/cloudfree-openwhispr/issues/248)) ([4affd21](https://github.com/jrschumacher/cloudfree-openwhispr/commit/4affd21f90097272f0177e5c5df3738d2347f8b2))
* **hotkey:** add listening mode to prevent hotkey conflicts during capture, fallback system with user notifications, and cross-platform accessibility settings opener ([b905a5b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b905a5b976931934a640bca1c7ba544923491a0e))
* **i18n:** add Japanese locale with full UI and prompt translations ([1c1e3db](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1c1e3db1362508001f563941808ed076c44ad99e))
* improve dictation audio cue audibility ([#219](https://github.com/jrschumacher/cloudfree-openwhispr/issues/219)) ([30e91d3](https://github.com/jrschumacher/cloudfree-openwhispr/commit/30e91d30234e0c8470bdce80b9d7355bd660558e))
* Linux Wayland paste reliability improvements ([#351](https://github.com/jrschumacher/cloudfree-openwhispr/issues/351)) ([2b13a6b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2b13a6be2da50449042ee748cecd03fc040e0481))
* macOS state-aware media pause via MediaRemote framework ([8632219](https://github.com/jrschumacher/cloudfree-openwhispr/commit/863221968c7ee1510cbaad9d2a4a6cf39dbe2279))
* meeting mode back button, window restore, and upcoming meetings ([01e747b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/01e747b71c3e749fd156b7e5b78e6af6411e95e4))
* meeting recording mode — focused note view with sidebar collapse ([c62e499](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c62e4997e8b1b1522612b3e4c61f34b1c5fc1911))
* migrate streaming transcription from AssemblyAI to Deepgram ([#249](https://github.com/jrschumacher/cloudfree-openwhispr/issues/249)) ([232d210](https://github.com/jrschumacher/cloudfree-openwhispr/commit/232d210ddac8494782c8458b0ee0c92c3742526e))
* move Wayland paste setup to Preferences tab ([8c15360](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8c15360c24dbe55a2a8d4f41358c35a918fa5b56))
* native XTest paste binary for Linux with compositor-aware fallbacks ([#262](https://github.com/jrschumacher/cloudfree-openwhispr/issues/262)) ([e565753](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e565753ca54fe45a81ab244b81772a03374a02c7))
* pre-warm meeting transcription WebSocket for instant recording start ([9c7a211](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9c7a211b1b29a73508001f6c240f53adb92d7d2a))
* prompt architecture overhaul, dynamic agent window, code cleanup ([f329c21](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f329c2173710b45317f3ed65faf2ae79b954230f))
* push to talk ([b7eb2dd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b7eb2dd05c594832f61bb6b9ce586868ccb4fc32))
* redesign meeting notes with transcript view, generate notes action, and 3-way toggle ([9a31a47](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9a31a47b1444139006aa4414098b116609c7f6a3))
* redirect Google Calendar OAuth to desktop-callback page ([6ee296c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/6ee296c314ef35077ff5f7b05b6843c4fd939481))
* replace auto-paste toggle with keep-transcription-in-clipboard option ([53d6ef5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/53d6ef5f9b392501def9cf20170e9a234daa183b))
* replace paid plan gate with sign-in gate and beta messaging for meeting recording ([cda8aa7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/cda8aa7f3e2ecf2b6e6451aa66eda8319b3521a5))
* replace polling-based meeting detection with event-driven OS APIs ([b97d060](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b97d0600edf36ee484c112640bfa1ad0eb5cb33a))
* retry transcription runs full pipeline with AI reasoning when enabled ([65848a9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/65848a9ae1b502f447a1fd6c203774a2d8827366))
* reuse Intelligence model selector in Agent Mode + add cloud streaming ([5870993](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5870993f680a7e5de4ea58008f517eeedcd19408))
* runtime .env ([c8ac86f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c8ac86f4147fe47f0e263aedcb81e8f373d033f1))
* save failed transcriptions with audio for retry ([bd6efa4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bd6efa45502a1476299fb5e0087e1490aa517bda))
* split Chinese into Simplified and Traditional language options ([#267](https://github.com/jrschumacher/cloudfree-openwhispr/issues/267)) ([29441c6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/29441c60005def30a32233d0c22ff42a6a2e1dd9))
* stream live meeting transcription via OpenAI Realtime API ([5ec0d48](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5ec0d480d946090b3cad538d235527aae5265d90))
* sync renderer startup preferences to .env for server pre-warming on restart ([5454a3c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5454a3c227761c4b34009017f2e48b01f14e0030))
* troubleshooting mode ([1c76da5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1c76da5c5c490cfbe5a3631ee19b4cd57488075e))
* update groq models list ([4844d92](https://github.com/jrschumacher/cloudfree-openwhispr/commit/4844d9221190492e97511fe0c899cfa04c5a2831))
* update groq models list ([d3d6ec8](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d3d6ec8584785e9c4bacad20f3c7ba5a7bc1a572))
* Wayland paste setup guides and diagnostics in Preferences ([f492e3b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f492e3bad4c50d1a1e883148cc242c48d9365d1e))
* WebSocket streaming for BYOK + fix blocking execSync in meeting detection ([27542f5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/27542f54e5b498f8f04f21b85d3abb1122ecf4eb))
* **windows:** add native fast-paste binary with terminal detection ([#229](https://github.com/jrschumacher/cloudfree-openwhispr/issues/229)) ([91b131e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/91b131e0c929eed6b80d7c5ba800ec2d2fe5da84)), closes [#272](https://github.com/jrschumacher/cloudfree-openwhispr/issues/272)
* **windows:** add Push-to-Talk support with compound hotkeys ([#153](https://github.com/jrschumacher/cloudfree-openwhispr/issues/153)) ([e3969d0](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e3969d05385b6fda6f162522f3ffe11449584a65))


### Bug Fixes

* accessibility permission not detected during onboarding ([#394](https://github.com/jrschumacher/cloudfree-openwhispr/issues/394)) ([5b28644](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5b2864441e7848df3fc50fac8555cfa2e40ea56e))
* Add auth-aware routing to show re-authentication screen for signed-out returning users ([95bb281](https://github.com/jrschumacher/cloudfree-openwhispr/commit/95bb2815694a8eaf9d1d9873cfad6070aadde48e))
* add better path resolution ([3a759c7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3a759c7e5bf24b7b7a97d8ed56bb6b1ff127d7e6))
* add config to bundle ([89d0a74](https://github.com/jrschumacher/cloudfree-openwhispr/commit/89d0a74b7f5b3ea2087fee792c145ba82137d28b))
* add confirmation dialog for deleting models in settings ([44a316a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/44a316a098f5b4960c4bc33b4a1a0f1e99f1bf3e))
* add disable-library-validation entitlement to resolve macOS launch crash ([#120](https://github.com/jrschumacher/cloudfree-openwhispr/issues/120)) ([a9824ae](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a9824aef380dfc7469807d64cda15eb8e326433c))
* add JS fallback for bzip2 extraction on Windows 10 ([a90279d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a90279d99d99e0cf3f70323dd98d54a57ff29fb3))
* add JS fallback for bzip2 extraction on Windows 10 ([5618153](https://github.com/jrschumacher/cloudfree-openwhispr/commit/56181535e3ff5b59cb0ce98dca74455b275dae1c))
* add language selector dropdown positioning and sizing inside settings modal ([874e398](https://github.com/jrschumacher/cloudfree-openwhispr/commit/874e398bf5d2d71395d8fce75448390e7ad75cf8))
* add LLM download cancellation support and throttle progress updates to prevent UI flashing ([bc673b6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bc673b605efdc05c356ae42a37df23c189fe3ae8))
* add missing Linux build deps to release workflow ([196397f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/196397fb3a8f4d42fb6e5e88d645057f3527df94))
* add missing Linux build deps to release workflow ([66286a1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/66286a18ccc12566336a188d2bf4a7145a0ec402))
* add neon origin ([de6da47](https://github.com/jrschumacher/cloudfree-openwhispr/commit/de6da474912ad19e01702658d4a38dd60081af40))
* add os.tmpdir ([182016a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/182016a73f551ab20cf7e6cf74a68be352905549))
* add trycatch ([#223](https://github.com/jrschumacher/cloudfree-openwhispr/issues/223)) ([3d522db](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3d522dbe0f535248b619c63d75a33469c00ba922))
* add whiper.cpp to electron-builder ([ee003e6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ee003e6df5f4c6e51b7d7978cc24dc1d1b9102d9))
* agent hotkey toggles recording instead of closing overlay ([68cf74c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/68cf74c00b89a2f36eccc07c6a313ab0667d86f4))
* allow reasoning pipeline for custom providers ([#426](https://github.com/jrschumacher/cloudfree-openwhispr/issues/426)) ([b8ee70b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b8ee70bc4403ffa57cee2887eee0cadb499aafff))
* always overwrite shared libraries during download and add --force support to sherpa-onnx ([ea07e16](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ea07e1642b381f2afd20c1c336d023bd15636d38))
* always pre-convert audio to 16kHz mono WAV for whisper-server ([5daf562](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5daf5627f1e4e36bc9899196e159ba3791405786))
* apply PTT cooldown and press-identity check to macOS handlers ([304b6e2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/304b6e28bd1a1c7c4071bce51851e6bfcbd3eaa8))
* asar path resolution ([cd436fd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/cd436fd63aa73f8410908c702ec4b9d0cbcb1cd0))
* **auth:** add newUserCallbackURL to desktop Google OAuth flow ([146e366](https://github.com/jrschumacher/cloudfree-openwhispr/commit/146e366b69830a2b643b6e5497a3cdeb1d1130d0))
* auto-repair native binary permissions on startup ([373261f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/373261f4b93e14bcf2a29942f10a2f38399b1a1d))
* await async zip extraction in download scripts ([92deca7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/92deca76ac7c36b5d9dac30aede1fe3df4a3a8b4))
* await init-user before completing auth and add missing user dep ([3686b63](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3686b63cb9ff7135154d8c0471fee45c94a25a80))
* better path resolution + error handling ([81eafb1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/81eafb1cf2f889ae69dd6cfde431c458360e33de))
* blank screen on upgrade from older onboarding versions ([ee5cddb](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ee5cddbbb9a5c3105b33d864d9c49c0320049f54))
* broken ipc handler, standardize logging, improve react hook deps ([53fa746](https://github.com/jrschumacher/cloudfree-openwhispr/commit/53fa74662f852adb837686d5e39d60ec93a93bab))
* bundle llama-server shared libraries and add STT/reasoning debug logging ([fa34889](https://github.com/jrschumacher/cloudfree-openwhispr/commit/fa3488984319c6631b4a322ca410d8bca993cabf))
* check audio state before sending media key on Windows ([52f8e2f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/52f8e2faa2ce3473216a858e203b69ca70258ec0))
* **ci:** install x64 ffmpeg-static binary for Intel Mac builds ([24212a1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/24212a130f582293f1eb68504cbf2e91e04b0982))
* **ci:** prevent prebuild hook from deleting x64 binaries on arm64 CI runners ([c810d2b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c810d2b20544af854b28a4504b885c774a99188a))
* **ci:** resolve Intel Mac binary architecture mismatch ([#196](https://github.com/jrschumacher/cloudfree-openwhispr/issues/196)) ([8eb7556](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8eb75563389368bd85f4aea7e6a029f513518d82))
* **ci:** resolve Intel Mac binary architecture mismatch ([#196](https://github.com/jrschumacher/cloudfree-openwhispr/issues/196)) ([0580e1e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0580e1e0b1cfbd519c7f1f2ebe721b7da46790a3))
* command search — input styling, note type icons, sidebar spacing, deleted_at column ([19b7034](https://github.com/jrschumacher/cloudfree-openwhispr/commit/19b7034620162bb4540d09372ff7e7cb123f79fa))
* commit audio buffer before WebSocket close to prevent transcript loss ([8d49b88](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8d49b88b09ef6d19bee280581d085536704666ca))
* configure OpenAI Realtime session with pcm16 format and VAD ([a76fbdd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a76fbddcc480fc2b8a1784b209710dbbcf7ceb98))
* copy update ([332f6e7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/332f6e711f5e50f4e50c433718c1411152d133be))
* correct FFmpeg availability types and optimize whisper-cpp download ([a0c9c9d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a0c9c9d83fafd5c627cf7f522b2d42e1d3b8641c))
* correct Gemma model metadata and add provider icon ([54317b2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/54317b2d0fe5b15e787639efdf807e449d61d01f))
* CUDA and Vulkan binary download failures on Windows ([d086e10](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d086e10d7a0a48c1173cc67f81ab0b4ac5967b4f))
* CUDA and Vulkan binary download failures on Windows ([f92c274](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f92c274b38902488b23857fad51413ae8e721dcb))
* defer debugLogger file initialization until app.whenReady() ([#141](https://github.com/jrschumacher/cloudfree-openwhispr/issues/141)) ([3440d18](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3440d18702880d798fb0f124b68eca760c461168))
* defer manager initialization until after app.whenReady() ([#140](https://github.com/jrschumacher/cloudfree-openwhispr/issues/140)) ([ca74ec8](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ca74ec84b6c60dc90b23bfba2414d7e3f774dc40))
* detect Rosetta to self-heal x64-on-arm64 auto-updates on macOS ([d1b209a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d1b209a1b89fc58622e6ea0647ada2d09dd30f38))
* disable neon auth verify email ([6a411f8](https://github.com/jrschumacher/cloudfree-openwhispr/commit/6a411f8fa56ac17336ea3dd05ac6f20099014993))
* display readable error message instead of [object Object] ([88410d9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/88410d96003f6c9817cffca732cb5dd18b79442e))
* enable actions when transcript is present and include transcript in action content ([375f7d0](https://github.com/jrschumacher/cloudfree-openwhispr/commit/375f7d01ee923516d2c32220eec8160d09ca7768))
* enable mic auto-gain and skip silent system audio chunks ([a23736f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a23736fe8cd363ce62e799cd6c48b308799bc73d))
* enforce single instance lock and add isLiveWindow helper for cleaner window state checks ([54f61dc](https://github.com/jrschumacher/cloudfree-openwhispr/commit/54f61dcd63ecea5a243add3ec44628986b5cb771))
* expose auto-learn toggle in Preferences settings ([db38e37](https://github.com/jrschumacher/cloudfree-openwhispr/commit/db38e37d9cdf9a1ca5cd9e1050be8148f13b324b))
* expose auto-learn toggle in Preferences settings ([9849f9a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9849f9aedd6a185ded1bc0bc24a29f703693d782))
* fallback to nova-2 for unsupported nova-3 languages ([55ce187](https://github.com/jrschumacher/cloudfree-openwhispr/commit/55ce187b8930e7af1d9af23ddd60c07a570664b0))
* Fix AssemblyAI streaming WebSocket going silent after idle periods by adding keep-alive pings, readyState validation, re-warm recovery, and connection death handling ([ea7acea](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ea7acea803d7d6bce2e599f2a6d41dda82c5c2a0))
* fix incorrect .env command in docs ([#216](https://github.com/jrschumacher/cloudfree-openwhispr/issues/216)) ([e3de1df](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e3de1df726381e02104ebb08bffb8a531cefc2dc))
* Fix Neon Auth Origin header rejection for Electron desktop app and API proxy ([c33cd1b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c33cd1b89f52716836356841bcbe7a3df318c677))
* fix open mic settings ([f17e67a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f17e67aae8189022feaca06340a6b6708c5649e3))
* fix whisper-models path ([f2cd603](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f2cd6038f1daadfb4bc3bb57209855d099594f29))
* fix wildacrd pattern ([7254d73](https://github.com/jrschumacher/cloudfree-openwhispr/commit/7254d73de9d06fb14c041fb9b3217cea3ee04c5e))
* focus control panel on deep link ([932bca5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/932bca5c48069362d1a4dc516c0debdcf4c9fbe0))
* force cold-start Deepgram connection for meeting transcription ([00f72a4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/00f72a417043cb99dd1f2c6b8ca79496190fc635))
* force GTK3 on Linux startup to avoid GTK symbol crash ([#291](https://github.com/jrschumacher/cloudfree-openwhispr/issues/291)) ([06672c9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/06672c9a2c6c62956225b5cec28755e1255ba24f))
* force x64 ffmpeg download for Intel Mac builds ([505b055](https://github.com/jrschumacher/cloudfree-openwhispr/commit/505b05514b438b8a443bd1da258eba015cade0f3))
* forward complete STT metadata and client e2e latency to API ([#321](https://github.com/jrschumacher/cloudfree-openwhispr/issues/321)) ([9741781](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9741781470d6b6ce1d13244826b7a30cab33b3a2))
* **gcal:** extract email from id_token instead of userinfo endpoint ([22da6c9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/22da6c95fa2099a4a224d6430edfb61551037687))
* GNOME Wayland hotkey improvements ([#154](https://github.com/jrschumacher/cloudfree-openwhispr/issues/154)) ([ea2747e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ea2747ec615337f3b50e017374e97f027017aa3c))
* GPU activation and Vulkan fallback ([#340](https://github.com/jrschumacher/cloudfree-openwhispr/issues/340)) ([75f0db5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/75f0db586ae6731bd1acca6450872715026f9de1))
* guard BYOK override for signed-in users and fix missing deps ([0c59e21](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0c59e210120a616a7dd78fac299c70dd2c729e2b))
* handle empty transcription and dictionary-only output ([9b3a592](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9b3a592416324652023638d80cbb38db916d1227))
* Harden auth code: safe JSON parsing, guarded URL constructor, fix error leaks ([e424e1d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e424e1dbe24cd16dbab74010650ca1f107992e99))
* harden model download pipeline and progress UI ([fcf146f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/fcf146f4fc718cedf7d4b9e3235837a7043fbc22))
* harden Windows PTT with post-stop cooldown and press-identity check ([e095b07](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e095b0797d43c8101d3df8c5d94e72c0f939f335))
* hotkey fixes ([d7d2139](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d7d2139146591613e0348259e8c3ce0d40b11efb))
* **i18n:** translate groq_whisper_large_v3 in 6 missing locales ([9e50e41](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9e50e41e203c684f5a52b1ca733760603dc289c2))
* **i18n:** update Groq model descriptions across all locales ([aa60f5f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/aa60f5ff64d5881d0f5c0e8a765a1cd328a7d2e8))
* import Os top line ([5533c22](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5533c2242d289b758fbf7f3bbee8c393b7e5aec3))
* improve download progress UI and simplify parakeet archive validation ([ed117e2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ed117e2743903b144764fdf28a73124afa679d65))
* improve integrations page design and remove false diarization claims ([85d0922](https://github.com/jrschumacher/cloudfree-openwhispr/commit/85d09220e009b893315e633d224382b5319d3062))
* improve screen recording permission UX across meetings and integrations ([2d41753](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2d41753e3acfd03cb1d5405a2f15a416b6215464))
* improve soft voice recognition with AGC and lower VAD threshold ([9f6f809](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9f6f8098a8978c4d78ec9dbb8155a154270bd95d))
* include business plan in past-due subscription check ([bf64f3a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bf64f3a7ab76273479c7f94212b925b068cc741b))
* include seveies and models in build ([baf164d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/baf164dc6ca2d503cec1e6a050eaaa6416c9e76f))
* inline AudioWorklet as blob URL to fix ASAR module loading failure ([87ae99f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/87ae99f49337b44a6d178dd90768831fc237d3f9))
* keep video tracks alive for loopback audio, remove invalid dispose call ([9ee0193](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9ee01935af4a1c0106398eacf547df25fd2fe63d))
* **linux:** clear stale hotkey registrations on startup ([3ece1de](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3ece1de515fb2eed84ac664e38ae06d36a55c00f))
* **linux:** fix transparent window flickering on Wayland and X11 ([#203](https://github.com/jrschumacher/cloudfree-openwhispr/issues/203)) ([1e3ed5d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1e3ed5d37e8348d9afeb5dfdacd7524c1253d2cf))
* **linux:** hide push-to-talk option and force tap-to-talk mode ([2338f22](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2338f22d11d4b3561f59e28c1f5837bbc665fb2e))
* **linux:** improve X11 paste reliability by capturing target window ID upfront and using windowactivate --sync, add xdotool type fallback for terminals ([9e6b532](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9e6b532591e173cf55471fc6516e0a487b594867))
* **linux:** persistent clipboard ownership on Wayland — Ctrl+V works after transcription ([#221](https://github.com/jrschumacher/cloudfree-openwhispr/issues/221)) ([0e2a70a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0e2a70a49db35d4d6065a97d9b5d20f287aa5f9a))
* **linux:** prevent dictation panel from appearing in KDE taskbar ([da6be9f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/da6be9f9a7b51edec984f3437eaebb911d3ef1bd))
* **linux:** prevent Python whisper from being used instead of whisper.cpp ([736b208](https://github.com/jrschumacher/cloudfree-openwhispr/commit/736b2083804af2131e1007ef23477a72376c5fb7))
* lower silence detection threshold to avoid rejecting valid speech ([79db315](https://github.com/jrschumacher/cloudfree-openwhispr/commit/79db315b046660ad5cad22f0c5957d934602ebfa))
* lower silence detection threshold to avoid rejecting valid speech ([71e3dea](https://github.com/jrschumacher/cloudfree-openwhispr/commit/71e3dea8164fda7a9ceb51efdf90d2af812709b9))
* **macos:** notify users when accessibility permissions are missing ([547cf22](https://github.com/jrschumacher/cloudfree-openwhispr/commit/547cf22b5f3efcf5e5e1edd9ff9175dd72b22e92))
* **macos:** resolve paste failure caused by wrong accessibility check and stale focus ([#313](https://github.com/jrschumacher/cloudfree-openwhispr/issues/313)) ([facd3f2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/facd3f29fc4a6f403a47c58214d18149546699ea))
* make agent panel fully opaque for better readability ([4566ddf](https://github.com/jrschumacher/cloudfree-openwhispr/commit/4566ddfc0b847254418e7dc0d69b1d41db6b2d9d))
* make sure custom endpoint uses own state ([94cf467](https://github.com/jrschumacher/cloudfree-openwhispr/commit/94cf4670ba97da0d59f8cc4a1713521b6c7bea80))
* media pause improvements and settings toggle bug ([2a8584d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2a8584d796109dc08fdcb09cfa62d80ebf1f610d))
* meeting detection permanently breaks after first interaction ([2348f59](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2348f59b09ec4b77ec9fdadeb93c9aeff8132453))
* meeting detection suppressed when no active calendar meeting ([96e7fb2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/96e7fb279da1a4e37507c00f5dd5dbab68795a4b))
* meeting flow data shape mismatches and race conditions ([0ccf12b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0ccf12b9a6993af6a3849c0edf3dce50d8b0de93))
* meeting notification window invisible due to Vite ESM timing race ([7268b04](https://github.com/jrschumacher/cloudfree-openwhispr/commit/7268b045762b4b6ac8006e9e3acb867dea3ee565))
* meeting recording UX — bottom widget shows recording state, remove top banner ([3f193dc](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3f193dc7b16f3fed8632b8a28e2101968edea9b6))
* **meeting:** support simultaneous system and mic audio ([8823a93](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8823a934dc95b97323dd49a198d388fcf5c2ca58))
* minimise to tray ([e3f6fab](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e3f6fab636bc2e1fc1217dbb7be674b2d9f3e729))
* **models:** reset isMountedRef on StrictMode remount in ReasoningModelSelector ([ab19f0a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ab19f0a2489600b110558b1f126120c921adaacc))
* move useEffect after reasoningProvider definition to fix settings page crash ([40e7046](https://github.com/jrschumacher/cloudfree-openwhispr/commit/40e7046882dabc0d84314a10f37d89146b5e5056))
* move ydotool setup to post-install scripts for deb/rpm ([34d6f89](https://github.com/jrschumacher/cloudfree-openwhispr/commit/34d6f89eb2298cf18cf66d8eefcc298d8a9bc7a7))
* neon auth build config ([53fbb7f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/53fbb7f55445de3f616910bdb60ede6c545722ca))
* newline issues ([ea61d24](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ea61d246e51a74db33fc7735a5bd2f87abd723c7))
* only suppress audio detection when calendar recording is active ([303ce82](https://github.com/jrschumacher/cloudfree-openwhispr/commit/303ce8267f30b1759dd9386f0bf53b97fa871e26))
* Open Google OAuth in system browser with deep link callback instead of navigating Electron window ([cb154c6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/cb154c6a0a8fd1de58afc99293d98df6f696003e))
* OpenAI Realtime streaming reliability — cold-start buffer, lifecycle guards, quiet empty-buffer errors ([ee4baed](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ee4baed26bf90b851b2bb778dfce57ef2395a719))
* pass --language auto to whisper.cpp for language auto-detection ([fc1336e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/fc1336ecf4dbc75878f63cef467a478d4eef9bc1)), closes [#260](https://github.com/jrschumacher/cloudfree-openwhispr/issues/260)
* pass custom system prompt to local and Anthropic BYOK reasoning ([0c83010](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0c83010f69c1f4805ae9f709f7918f1f90f7f2ac))
* pass email param in verification polling and stop on 401 ([87aaa58](https://github.com/jrschumacher/cloudfree-openwhispr/commit/87aaa582bcbb5ea8012806e0e541189863556e81))
* persist agent hotkey to .env and clean up IntegrationsView ([66664cb](https://github.com/jrschumacher/cloudfree-openwhispr/commit/66664cba56c2d087063898b39de0e3ee26afaac5))
* persist agent hotkey to .env file across restarts ([30f07b4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/30f07b4370f9cac2c037ea476bfa04184ac6e114))
* persist AI enhancement CTA dismissal across sessions ([baa3b88](https://github.com/jrschumacher/cloudfree-openwhispr/commit/baa3b88bf2420eea61022c969f5589cb7f100100))
* persist custom endpoint API keys to .env file ([3caf625](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3caf625261a7b0e5b5267e7ad6fc95732e3811ec))
* persist hotkey selection ([2e51983](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2e51983bfac57e3077488ce24b9152f84f5fa372))
* persist useLocalStorage defaults and align direct reads so useReasoningModel correctly defaults to enabled ([e5a92e9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e5a92e9d6d0f0c039b1d309d20dd8009b14c09b0))
* **persistence:** add file-based hotkey storage for reliable startup ([#181](https://github.com/jrschumacher/cloudfree-openwhispr/issues/181)) ([f0b0fea](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f0b0fea512fecd7aeb232f83741af243dc5ef7a7))
* portal-based tooltips and replace download with reveal in folder ([402fbf9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/402fbf910ff8749bd35d72aad725c324a0aacc68))
* prefer localStorage API keys over process.env to fix BYOK after upgrade ([#263](https://github.com/jrschumacher/cloudfree-openwhispr/issues/263)) ([96f6445](https://github.com/jrschumacher/cloudfree-openwhispr/commit/96f6445ba81262b28088855ed361c45341c5f836))
* prevent blank audio from pasting ([5bcd750](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5bcd750273bcc00fa470befab4b9482c6d203423))
* prevent Deepgram token expiry clock from resetting on re-warm cycles ([c6c1a69](https://github.com/jrschumacher/cloudfree-openwhispr/commit/c6c1a698d9faff51b0edc9a71b11c485d27612eb))
* prevent double-click on checkout and billing buttons ([78b175f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/78b175fd09e3528c8e2fb135e9b7fd803d415aaa))
* prevent dual taskbar entries on Windows/Linux ([0cd0aed](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0cd0aed44a8af5cfef9f73285e4d391627e2c376))
* privacy-hardened OpenWhispr fork with network guard and upstream sync ([#2](https://github.com/jrschumacher/cloudfree-openwhispr/issues/2)) ([9877e9a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9877e9af4badbc81081050617ef1223ad8abef84))
* **quality:** production readiness cleanup — i18n, types, dead code, and StrictMode bug ([b58e47c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b58e47c034e1850212973dbb7cfcb85cded486bd))
* quit and install ([d9f9b03](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d9f9b0366ebd6db280c050fdc775ee73568b5a5f))
* raw transcript now stores original STT text, retry supports cloud ([b4bf390](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b4bf39045c3b1be02dfa0220450fe39d8f2687c1))
* realtime streaming warmup, disconnect hang, and cloud session config ([e8480bf](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e8480bf3a9cec28d7afab2e9d2ab596290a984ce))
* **reasoning:** resolve empty output for Qwen3/GPT-OSS and custom endpoint misrouting ([18d800f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/18d800f4b8e2cffc808d73e50f32f82a53bb4cc4))
* reduce audio chunk segment duration to fit Vercel's payload limit ([d70a4bf](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d70a4bf4f6a1472ae56834e0fb52fcb20e2d045c))
* regenerate lockfile with full npm install for cross-platform deps ([11ebd24](https://github.com/jrschumacher/cloudfree-openwhispr/commit/11ebd24d63bdba5faeb376f75412674df9b43c43))
* regenerate lockfile with Node 22 for CI compatibility ([1e0ed7b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1e0ed7be468efbda6cb6deb283df32f874dc4358))
* regenerate lockfile with Node 22 for CI compatibility ([b613cde](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b613cde6b5828e7915405cb13bf7f50183ff6f81))
* regenerate lockfile with Node 22 npm for CI compatibility ([e68f35d](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e68f35d2c0302ce3fc9cb1d28e8cfe9eeb335c14))
* regenerate package-lock.json ([8bb17ec](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8bb17ec8a4ad65f05321bd2df22b4d69eb36818b))
* regenerate package-lock.json ([4bcdb88](https://github.com/jrschumacher/cloudfree-openwhispr/commit/4bcdb88bb44668f9445e3364e120629fa6f1bf12))
* regenerate package-lock.json ([#383](https://github.com/jrschumacher/cloudfree-openwhispr/issues/383)) ([6d954cd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/6d954cd2afabdd495fec2a8d8c3ad1184fe1e0ab))
* reject plus-addressed emails during authentication ([5f13300](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5f1330018e60dddaa67bb5916705d72dac71001c))
* remove dead code and unused imports from SettingsPage ([1ae6264](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1ae6264162e7274cd563fca8702f3413aa7885fe))
* remove deprecated Groq models (Maverick, Kimi K2 Instruct) ([ab1aebf](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ab1aebfe00f8ded68a7582716c977d57e1013b07))
* remove orphaned trialNote reference from free plan pricing ([849488b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/849488b53a16cdc33313b69c71881a54f05dabfb))
* remove redudannt ipc wait + doc update and version bump ([a9dcbbc](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a9dcbbc257ae429a321c5c4e3cf8f2ea7aac245c))
* remove unnecessary wl-copy timeout ([#347](https://github.com/jrschumacher/cloudfree-openwhispr/issues/347)) ([91928d4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/91928d4f9e06af72a77040a7e6b423eeff8541cb))
* rename actionPrompt to fullPrompt in all non-EN locale prompt files ([e794b33](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e794b3372114a8126998cba467a51f7cc0ed72af))
* replace broken ioreg mic detection with CoreAudio binary ([2caf34f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2caf34fe87343250d798859fb4e26c72b15fd1d3))
* replace CGEvent tap with NSEvent monitor to remove Input Monitoring requirement ([530ac26](https://github.com/jrschumacher/cloudfree-openwhispr/commit/530ac2615cdfa13f0ee117c47bb8e0217598db33))
* resolve FFmpeg path in unpacked ASAR for local whisper.cpp transcription ([3bae08f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3bae08f5998efe052bcf3e28c7f07d5268accbc6))
* resolve macOS hardened-runtime mic permission prompt via main-process IPC and unify API key cache invalidation with event-based AudioManager sync ([d11b9b7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d11b9b7042b9e950513654238053229b88446546))
* resolve quitAndInstall hang by removing close listeners that block window shutdown during updates ([27fcd48](https://github.com/jrschumacher/cloudfree-openwhispr/commit/27fcd48d3606cb016fa4b144d6cec1e8ff01073e))
* resolve whisper-server crash on Windows with non-ASCII usernames by pre-converting audio to WAV and routing temp files through ASCII-safe directory ([8fd8a83](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8fd8a83e77790a71eb83c1bd0f076c52692b4469))
* restore previous hotkey when new registration fails ([#220](https://github.com/jrschumacher/cloudfree-openwhispr/issues/220)) ([79c743e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/79c743efaa1c69950bf96bc5dc4aa59c9d9ac523))
* retry portal dialog when dismissed and remember denial ([09e14c5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/09e14c51a029716932ce9c3fdd0975c240c92d22))
* retry portal dialog when dismissed and remember denial ([198bec5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/198bec5e72bc2570344fb548867f52ae95e73d28))
* reuse existing archive on extraction retry and improve error handling ([94d38ee](https://github.com/jrschumacher/cloudfree-openwhispr/commit/94d38ee45860de879ffb5d080b8c36b829e5d98b))
* Route auth flows through API proxy for Electron compatibility with Neon Auth ([f5488bd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f5488bdd39346d5a86bf1b5adc82efaf8e2ae1fb))
* run separate workflows for mac ([e20133a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e20133ab71f4ff9a64d39255ac7568a6bb2401a0))
* search for llama-server libs from extract root to handle varying archive structures ([27d506a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/27d506a30cd5fcb2d79e3aa4317df4fb807c90fd))
* segment long audio for Parakeet to prevent empty transcriptions ([ebb9120](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ebb9120047b92d766b7c8541cdfbd19e0ba38f8b))
* send plain strings from dictation streaming IPC callbacks ([e1ccf75](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e1ccf75bc9595488dcce9f1b56b82229e397c5ab))
* send realtime session config after session created event ([d7966c3](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d7966c374dbad3422b3659086b03f215e7f23735))
* set cloudTranscriptionMode to BYOK during onboarding for non-signed-in users ([ece9a86](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ece9a8610049225a0e31503b249fcc8d691bfbf0))
* set cloudTranscriptionMode to BYOK during onboarding for non-signed-in users (local but remote) ([b2e52d9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b2e52d93a0ae28e0ad1f2b0fad87912eb8f3dc2a))
* set default agent name to OpenWhispr ([019f65e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/019f65e6df38a84efefcef3f6ac42d99b87a1122))
* set desktop name on Linux for Wayland portal permissions ([a6c59c2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a6c59c2bc59ffa0a2687fddd9055528300a00f68))
* set SUID bit on chrome-sandbox during deb/rpm install ([a14ccba](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a14ccba08f977609e32713c5bd3a4230bda033ef))
* set SUID bit on chrome-sandbox during Linux package install ([f72536b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f72536be9564484c9a8654a359a302038629156b))
* set SUID permissions on chrome-sandbox in deb post-install ([d65f036](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d65f03652b21ce8b77fa2b60ece9a9955c20c85e))
* show device name in mic settings and improve onboarding accessibility UX ([8ee5ece](https://github.com/jrschumacher/cloudfree-openwhispr/commit/8ee5eceb1671caba677b5dcf422726f45cf6090d))
* sidebar not extending full window height ([cf7480b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/cf7480bd773c50b6ef959d151acf8a61d3c3b2df))
* silent return on empty transcription instead of pasting fallback string ([e0b3f8e](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e0b3f8e02d89f5a8cff0ff9d94acedada40d011b))
* silent return on empty transcription instead of pasting fallback string ([e15e212](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e15e21262e036dda3af7afc5490ed8c637055853))
* small chinese translation issues ([b6583c9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b6583c9420efc46e615b892836f3f8305c53a3c2))
* state-aware media pause/resume, don't unpause already-paused media ([906d1bd](https://github.com/jrschumacher/cloudfree-openwhispr/commit/906d1bdd9dcf5c54feab384a646d75a3aea33e69))
* sticky date headers text overflow in history view ([#353](https://github.com/jrschumacher/cloudfree-openwhispr/issues/353)) ([92f1a7b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/92f1a7b67fa86dfba05aa5408684edcf952ad3ef))
* **streaming:** resume media playback after silence ([ea2b674](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ea2b67498ec13e0b4825f91981c1c8240eac1aa1))
* **streaming:** resume media playback after silence ([0e77bc9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0e77bc9dffa8f6785360d8d79a332fc60641c045))
* **style:** fill on voice recorder ([64447ac](https://github.com/jrschumacher/cloudfree-openwhispr/commit/64447acec2bbccefab63b25be9399fc3fd7215a3))
* **style:** provider button styling ([a4ec0f6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/a4ec0f677595a9e4450ddb3c3c7c01ff8abb0e51))
* **style:** update sccrollbar styling ([5e63f80](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5e63f806bcb3d5a4ff9af19373e76d25e3eb0caa))
* support local models in agent streaming and fix Metal OOM crash ([80aaf83](https://github.com/jrschumacher/cloudfree-openwhispr/commit/80aaf8327ec299fbece5c8cf5b6886f6eefed681))
* support modifier-only hotkeys on Windows via native keyboard hook ([#226](https://github.com/jrschumacher/cloudfree-openwhispr/issues/226)) ([81db129](https://github.com/jrschumacher/cloudfree-openwhispr/commit/81db129c6bb4eeffacfcf6b0c6d14d40a67f77b2))
* suppress meeting detection during hotkey dictation ([3d55ac1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3d55ac17047ad12e45aa740538a3923a0c5fae2b))
* surface checkout/billing errors with toast instead of silent failure ([11b1c68](https://github.com/jrschumacher/cloudfree-openwhispr/commit/11b1c686fda7ff86ce14cedb3a86410de53cc70f))
* sync package-lock.json with package.json ([e300e5f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e300e5f6ee849b80ea3640692e1747991d1854b3))
* sync React and React-DOM versions ([d7c488b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/d7c488bf5fd1257f3f42df9bf7ad7d2a3ca15c10))
* treat Custom Cloud as self-hosted, not third-party ([#384](https://github.com/jrschumacher/cloudfree-openwhispr/issues/384)) ([55ffeee](https://github.com/jrschumacher/cloudfree-openwhispr/commit/55ffeee6d5740b3899027673a071615f66bb0ba7))
* treat Fn hotkey as equivalent to GLOBE ([#338](https://github.com/jrschumacher/cloudfree-openwhispr/issues/338)) ([2f8dab4](https://github.com/jrschumacher/cloudfree-openwhispr/commit/2f8dab4be3396add6f2870137e1a8aac34505ee2))
* treat portal exit 0 with no token as failure on KDE Wayland ([ee176d1](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ee176d198e974d1605adf0dd4dcd1c5da2d99f4f))
* treat portal exit 0 with no token as failure on KDE Wayland ([f4003b2](https://github.com/jrschumacher/cloudfree-openwhispr/commit/f4003b2a4cd18474588866fa0ae61c7d28fe2fce))
* truncate custom dictionary prompt to respect Groq's 896-char limit ([5fb8d90](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5fb8d90ef5a8639d20c509af4dd6ac7098646745)), closes [#405](https://github.com/jrschumacher/cloudfree-openwhispr/issues/405)
* try xdotool on Wayland when XWayland is available ([3c812b6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/3c812b6d48336091c10ada992c7cbb7593644331))
* udpate lockfile ([1c4ddd5](https://github.com/jrschumacher/cloudfree-openwhispr/commit/1c4ddd54a87ae80cbacb60aa4a3f468e6727f56f))
* unify screen recording permission UX across all touchpoints ([b0257bc](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b0257bceb8d8183ceb790ce60b6903df407e13da))
* update checker ([e5adc0c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e5adc0c6b8d52f33c2ddb4f3d8d2d13680396382))
* update paste delay on windows ([290ca58](https://github.com/jrschumacher/cloudfree-openwhispr/commit/290ca58257dfa0e16c841c0cd9e9ebf32b758046))
* update pricing from $9 to $8/month across all locales ([e413240](https://github.com/jrschumacher/cloudfree-openwhispr/commit/e413240fe904853f7bfcd07a5aefedcf270b016c))
* **updater:** simplify Windows update install by using silent mode and removing redundant before-quit handling ([0cc1a16](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0cc1a16b20057873126c19a144ae04e7904adb1b))
* use correct readiness checks for local STT engines in retry ([4d4bf9f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/4d4bf9fe18bead806fbbb3fc7f103f4ad6cc6421))
* use cross-env for Windows compatibility in pack script ([#115](https://github.com/jrschumacher/cloudfree-openwhispr/issues/115)) ([bd14aa7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bd14aa7a77e842e7c17ae326957f58d26aeb5f21))
* use getModelProvider() consistently and remove redundant fallbacks ([632280c](https://github.com/jrschumacher/cloudfree-openwhispr/commit/632280cc2b90c769c5055b8b7ed96b180a18728a))
* use null instead of empty string for unset agentName ([ad7bed7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/ad7bed7300bcc40ef1eb3528ec9cbec73a064c79))
* use prper streaming backpressure ([18135af](https://github.com/jrschumacher/cloudfree-openwhispr/commit/18135af7393af4c800bec5a67619e676e18c74ac))
* use recursive search for binary in extracted zip archives ([433b01a](https://github.com/jrschumacher/cloudfree-openwhispr/commit/433b01a4f2610aa633082f3b1b0878d8eb8c9208))
* use tar instead of PowerShell Expand-Archive for zip extraction on Windows ([6e9583f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/6e9583f240dcbb93e67b16d65d9139c6ec867112))
* use unzipper instead of tar for Windows key listener extraction ([#273](https://github.com/jrschumacher/cloudfree-openwhispr/issues/273)) ([68c037b](https://github.com/jrschumacher/cloudfree-openwhispr/commit/68c037b455626e8b9f3dfaef0f2e70b621ccc31e))
* wait for transcript before closing WebSocket on disconnect ([9bc26ba](https://github.com/jrschumacher/cloudfree-openwhispr/commit/9bc26ba113a699c2279455a4e0ede42af2f35477))
* wildcard origin ([948a1c6](https://github.com/jrschumacher/cloudfree-openwhispr/commit/948a1c601f6042d55e1ca13ec55df617574453cf))
* Windows GSMTC state-aware media pause/resume ([bf93c0f](https://github.com/jrschumacher/cloudfree-openwhispr/commit/bf93c0f57d89f8fe2a273b71111f33b6a1654c19))
* **windows:** stabilize native hotkeys and recorder clicks ([98c59da](https://github.com/jrschumacher/cloudfree-openwhispr/commit/98c59daa6aee3ea466aa568ba3dff3e6d89a9719))
* **windows:** use relative paths in sherpa-onnx tar extraction ([#284](https://github.com/jrschumacher/cloudfree-openwhispr/issues/284)) ([5481f31](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5481f318dc7787c3e36fe4d349508e20f8c47058))
* **windows:** use safe directory names in download script to avoid PowerShell Expand-Archive failure with bracket characters ([0274cc9](https://github.com/jrschumacher/cloudfree-openwhispr/commit/0274cc9730caff5bdd4a3fd989ef714c28285308))
* wl-copy timing issue ([5bf93aa](https://github.com/jrschumacher/cloudfree-openwhispr/commit/5bf93aa5466f55dba86ea3e02f5fa6b54644a228))
* write transcript to note content so it's visible and enhanceable ([19a9fc7](https://github.com/jrschumacher/cloudfree-openwhispr/commit/19a9fc7f6e9cba977e32d7d8fb9dd6e3acd580f7))


### Performance Improvements

* parallelize WebSocket and audio capture, buffer early audio ([b89af23](https://github.com/jrschumacher/cloudfree-openwhispr/commit/b89af23306d59962db1a40fa0af6a3a05ce1b95b))

## [Unreleased]

## [1.6.3] - 2026-03-12

### Changed

- **System Audio Permission Clarity**: Renamed "Screen Recording" to "System Audio" across all permission prompts, onboarding, and settings — makes it clear that OpenWhispr captures other participants' audio, not your screen
- **Improved Permission Copy**: Microphone permission now reads "Captures your voice for transcription"; System Audio reads "Captures other participants' audio from calls and meetings. We never record your screen."
- **Electron 39**: Upgraded from Electron 36 to 39, which uses the CoreAudio Tap API by default on macOS 14.2+ — eliminates the purple "screen recording" indicator, the "Your screen is being observed" lock screen message, and the misleading "Screen & System Audio Recording" permission prompt. Users now see "System Audio Recording Only" instead
- **NSAudioCaptureUsageDescription**: Added the new macOS 14.2+ audio capture usage description to Info.plist, enabling the separate system audio permission dialog
- **better-sqlite3 12**: Upgraded from v11 to v12 for Electron 39 V8 compatibility
- **Localized in all 10 languages**: All permission copy changes translated across en, pt, de, es, fr, it, ru, ja, zh-CN, zh-TW

### Added

- **Hyprland Wayland Support**: Native global shortcut support for Hyprland using `hyprctl` keybindings + D-Bus, matching the existing GNOME Wayland approach (#416)

### Fixed

- **Soft Voice Recognition**: Enabled Auto Gain Control (AGC) for dictation microphone input to automatically boost quiet speech — previously disabled, now matches meeting mode behavior
- **OpenAI Realtime VAD Sensitivity**: Lowered voice activity detection threshold from 0.5 to 0.3 (both client and API) so soft-spoken audio is no longer missed
- **Speech Onset Clipping**: Increased VAD prefix padding from 300ms to 500ms to capture the quiet beginning of soft speech that was previously cut off
- **Wayland Clipboard Paste**: Fixed `wl-copy` failing silently due to 1ms `spawnSync` timeout killing the fork before it completed — increased to 50ms (#416)
- **Streaming Media Resume**: Fixed media staying paused after recording silence with "Pause media on dictation" enabled — streaming path now fires the completion callback even when no speech is detected (#429)

## [1.6.2] - 2026-03-11

### Added

- **System Audio for Notes**: Mix system audio (via getDisplayMedia loopback) with microphone input for note recordings, enabling capture of meeting audio, YouTube lectures, and other system sounds
- **Event-Driven Meeting Detection**: Replaced polling-based meeting detection with native OS event APIs (CoreAudio on macOS, WASAPI on Windows, pactl on Linux) — reduces background CPU from 5–9% to near-zero (#404)
- **Notes Onboarding**: Added screen recording permission step to the notes onboarding wizard (macOS) so users can grant permission before their first recording

### Changed

- **Auto-Enable System Audio**: System audio is now automatically enabled when screen recording permission is granted — removed the separate toggle button for a simpler recording experience
- **Deferred Transcript Display**: Recording transcript is no longer shown live during notes dictation; it appears after recording stops, matching the meeting notes flow for a cleaner experience

### Fixed

- **Windows Hotkey Stability**: Track modifier state in native keyboard hook so modifier-only shortcuts (e.g. Control+Super) are detected reliably on Windows 11; keep floating recorder interactive; prefer compiling current key-listener source over downloaded binaries
- **macOS Accessibility Permission Prompt**: Detect missing accessibility trust after startup and notify users with auto-opened Privacy settings and toast guidance — fixes silent Globe key failures on fresh installs
- **Realtime Streaming Warmup**: Fix warmup gating so initial audio is no longer silently dropped; skip redundant session config in cloud mode; handle empty-buffer commit on disconnect gracefully
- **Custom Dictionary Prompt Truncation**: Truncate custom dictionary to respect Groq's 896-char limit, preventing 400 errors on large dictionaries (#405)
- **Parakeet bzip2 on Windows 10**: Add JS fallback for bzip2 extraction when native tar fails (#406)
- **Business Plan Past-Due Check**: Include business plan in past-due subscription check

### Removed

- Removed the Monitor toggle button from the dictation widget (system audio mode is now automatic)

## [1.6.1] - 2026-03-08

### Added

- **WebSocket Streaming for BYOK Dictation**: OpenAI Realtime API streaming now works for standard dictation mode (not just meetings), enabling real-time transcription for Bring Your Own Key users
- **Unified Streaming Path**: Extended OpenAI Realtime WebSocket streaming to normal dictation, sharing the same streaming infrastructure as meeting transcription

### Fixed

- **Transcript Loss on Disconnect**: Commit audio buffer before closing WebSocket and wait for final transcript before closing, preventing lost transcriptions during disconnects
- **Dictation IPC Callbacks**: Send plain strings from streaming IPC callbacks instead of objects, fixing downstream consumers
- **Accessibility Permission Detection (macOS)**: Fix onboarding flow not detecting macOS accessibility permission correctly (#394)
- **Custom Cloud Provider Classification**: Treat Custom Cloud endpoints as self-hosted rather than third-party (#384)
- **Blocking `execSync` in Meeting Detection**: Replaced synchronous process detection with async alternative to prevent UI freezes on Windows
- **BYOK Onboarding Override**: Guard BYOK override for signed-in users and fix missing deps during onboarding (#397)
- **Windows Media Pause Toggle**: Check audio state before sending media key on Windows (#402)
- **Linux Wayland Portal Permissions**: Set desktop name on Linux for Wayland portal permissions (#389)
- **Chrome Sandbox Permissions (Linux)**: Set SUID bit on chrome-sandbox during deb/rpm install

### Changed

- Eliminated duplication and fixed style inconsistencies in dictation streaming helpers
- Cleaned up meeting detection code after the Windows input fix

## [1.6.0] - 2026-03-06

### Added

- **Agent Mode**: Glassmorphism chat overlay with real-time AI streaming — resizable window (8 edge/corner handles), dedicated hotkey, conversation history stored in SQLite, customizable system prompt, and support for all cloud/local AI providers
- **Google Calendar Integration**: Connect multiple Google accounts via OAuth 2.0 (PKCE), view upcoming meetings in the sidebar, and receive notifications when meetings are detected
- **Meeting Recording & Live Transcription**: Automatic meeting detection via process monitoring (Zoom, Teams, FaceTime) and sustained audio activity, with live transcription powered by OpenAI Realtime API over WebSocket
- **Cloud Notes with Sync**: Local-first note storage with FTS5 full-text search, folder organization, cloud sync, and semantic search — all notes are instantly searchable across title, content, and enhanced content
- **Audio Retention & Retry**: Transcription audio is now saved locally with configurable retention (default 30 days), enabling playback from history and one-click retry of failed transcriptions through the full pipeline
- **Cmd+K Command Search**: Global command palette to search across notes, transcripts, and folders with real-time results, keyboard navigation, and type-grouped display
- **Auto-Pause Media Playback**: Automatically pauses media (Spotify, Apple Music, etc.) during dictation and resumes afterward — uses MediaRemote framework on macOS, GSMTC on Windows, and MPRIS2 on Linux
- **Screen Recording Permission Flow (macOS)**: Optional onboarding step and in-app prompts for screen recording permission, required for meeting audio capture on macOS
- **Configurable Recorder Position**: Choose where the voice recorder panel appears on screen (top, bottom, center)
- **Auto-Paste Toggle**: New toggle in clipboard settings to enable/disable automatic pasting after transcription
- **Prompt Architecture Overhaul**: Centralized prompt definitions in `src/config/prompts.ts` with customizable agent system prompts
- **Dynamic Agent Window**: Agent overlay starts at full screen height with drag-to-resize support, persisted window bounds across sessions
- **Save Failed Transcriptions**: Failed transcriptions are now saved with their audio for later retry instead of being lost
- **Cloud Backup Toggle**: Unified cloud backup into a single toggle for simpler settings

### Changed

- **Removed Input Monitoring Requirement (macOS)**: Replaced CGEvent tap with NSEvent monitor for Globe/Fn key detection, eliminating the need for Input Monitoring privacy permission
- **Unified Screen Recording Permission UX**: Consolidated screen recording permission prompts across onboarding, meetings, and integrations into a consistent experience

### Fixed

- **Agent Panel Readability**: Made agent panel fully opaque for better text readability
- **Local Model Streaming**: Fixed local model support in agent streaming and resolved Metal OOM crash on macOS
- **Mic Auto-Gain**: Enabled microphone auto-gain and skip silent system audio chunks during meeting recording
- **Meeting Audio**: Fixed simultaneous system and mic audio capture for meetings
- **KDE Wayland Paste**: Fixed portal exit code 0 with no token being treated as success on KDE Wayland
- **Meeting Detection**: Suppressed false meeting detection when no active calendar meeting exists
- **OpenAI Realtime Session**: Fixed session configuration timing — now sends config after session created event with pcm16 format and VAD
- **Agent Hotkey Persistence**: Agent hotkey now properly persists to `.env` file across restarts
- **Sidebar Height**: Fixed sidebar not extending full window height
- **Empty Transcription Handling**: Silent return on empty transcription instead of pasting fallback string
- **Command Search Styling**: Fixed input styling, note type icons, sidebar spacing, and added deleted_at column support
- **Onboarding Accessibility UX**: Show device name in mic settings and improve accessibility permission guidance
- **Orphaned Trial Note**: Removed orphaned trialNote reference from free plan pricing
- **Portal-Based Tooltips**: Fixed tooltip positioning and replaced download action with reveal-in-folder
- **State-Aware Media Pause**: Don't unpause media that was already paused before dictation started
- **WebSocket Audio Buffering**: Parallelized WebSocket connection and audio capture, buffer early audio to prevent data loss at meeting start
- **Video Track Loopback**: Keep video tracks alive for loopback audio capture, remove invalid dispose call

## [1.5.5] - 2026-03-01

### Added

- **Mode-Aware File Size Validation**: Upload UI now enforces file size limits per transcription mode — local is unlimited, BYOK and Cloud free are capped at 25 MB, Cloud pro at 500 MB — with contextual messaging and CTA buttons (Create Account, Upgrade, Switch to Cloud)
- **Large File Chunking**: Files over 25 MB are automatically split via FFmpeg and transcribed in parallel with per-chunk progress reporting
- **Gemma 3 Local Models**: Added Gemma 3 (1B, 4B, 12B, 27B) to the local model registry with provider icon
- **Groq Model Updates**: Added new Groq models and removed deprecated ones (Maverick, Kimi K2 Instruct)
- **Notes Editor Formatting Shortcuts**: Cmd+B (bold), Cmd+I (italic), Cmd+E (code) keyboard shortcuts in the notes editor
- **Linux Wayland Paste Improvements**: Added ydotool support and improved wl-copy reliability for Wayland paste
- **Granular Build Scripts**: Added individual build target scripts for more flexible CI/CD

### Fixed

- **Fn/Globe Hotkey**: Fn key now correctly treated as equivalent to Globe key on macOS
- **GPU Activation**: Fixed GPU activation flow and Vulkan fallback behavior
- **Groq i18n**: Updated Groq model descriptions and added missing translations across all locales

## [1.5.4] - 2026-02-25

### Added

- **Auto-Learn Correction Monitoring**: Detects user edits after paste and automatically updates the custom dictionary with learned corrections; native text monitor binaries for macOS (AXObserver with PID-based AX targeting), Windows, and Linux (with download-first strategy and CI workflow for prebuilt binaries); undo button on auto-learned dictionary toast; dictionary settings UI with translations across all locales
- **Config-Driven STT Routing**: STT mode (batch vs streaming) now driven by `/api/stt-config` per context (dictation vs notes); streaming provider adapter map supports Deepgram and AssemblyAI, replacing hardcoded Deepgram IPC calls with a generic interface
- **Live Toggle in Notes**: "Live" toggle in NoteEditor lets users override between streaming and batch transcription for notes

### Fixed

- **STT Metadata Forwarding**: Forward complete STT metadata (`sttWordCount`, `sttLanguage`, actual Deepgram model, audio bytes, `stt_processing_ms`) and client end-to-end latency (`client_total_ms`) to API logging
- **BYOK Transcription Logging**: Fixed BYOK reasoning incorrectly suppressing transcribe logs

## [1.5.3] - 2026-02-24

### Added

- **Unified GPU Banners**: Replaced dual CUDA/Vulkan banners on the home screen with a single GPU acceleration banner; added GPU banners to Transcription Settings and AI Text Enhancement Settings
- **GpuStatusBadge Redesign**: Auto-retry flow (download → activating → GPU active) with 15s timeout, replacing confusing "CPU Only" and "Re-detect GPU" states; swapped hardcoded hex colors for `bg-success`/`bg-warning` design tokens
- **Streaming Usage Tracking**: Wired up the previously-uncalled `/api/streaming-usage` endpoint so Deepgram streaming transcriptions report word counts to the server
- **Cloud API Telemetry**: Forward STT metadata (`sttProvider`, `sttModel`, processing time, audio duration/size/format) and `clientVersion`/`clientType`/`appVersion` to all cloud API requests
- **Internationalization**: Added 15 missing i18n keys (`app.mic.*`, `app.commandMenu.*`, `app.toasts.*`, `app.oauth.*`, `notes.enhance.title`) across all 10 locale files

### Fixed

- **Windows Blank Screen**: Fixed blank screen on return from sleep/minimize by adding `render-process-gone` handler, `isCrashed()` health checks on show/tray/second-instance paths, `backgroundColor` and `backgroundThrottling` to window config, and `disable-gpu-compositing` for win32
- **IPC Echo Loop**: Broke infinite IPC bounce in floating icon auto-hide toggle by guarding the setter with an early return when the value hasn't changed
- **GPU Banner Navigation**: GPU banner "Enable GPU" button now navigates to the correct `"intelligence"` settings section instead of invalid `"reasoning"` ID
- **AI CTA Deep Link**: Replaced legacy `"aiModels"` alias with canonical `"intelligence"` section ID in the AI enhancement CTA button
- **Custom Endpoint Routing** (#311): Moved `reasoningProvider === "custom"` check to the top of `getModelProvider()` so custom endpoint models are never misrouted through built-in providers; custom models now show a neutral Globe icon
- **KDE Wayland Terminal Detection**: Detect Konsole via `kdotool` (fast path) or KWin `supportInformation` via `qdbus` (zero-install fallback) so terminals receive `Ctrl+Shift+V` instead of `Ctrl+V`
- **RAM Leak on Provider Switch**: Whisper, Parakeet, and llama-server processes now stop when switching to cloud providers, freeing loaded models from RAM
- **Streaming Usage Session Refresh**: Wrapped `cloudStreamingUsage` in `withSessionRefresh` so expired sessions auto-refresh instead of silently dropping word counts
- **Duplicate Transcription Logs**: Skip telemetry logging in streaming-usage and transcribe endpoints when reasoning is enabled (the `/api/reason` endpoint already creates the combined row)
- **Usage Cache Invalidation**: `useUsage` hook now listens for `usage-changed` events to invalidate its cache and refetch immediately after transcription
- **macOS Binary Architecture**: Added Mach-O header verification to globe-listener and fast-paste build scripts; force rebuild when architecture-specific hash file is missing; runtime architecture check before spawning binary
- **Globe Key Listener Resilience**: Auto-restart globe key listener on unexpected exit code 0 (sleep/wake invalidation); reset restart counter after sustained uptime; only treat "Failed to create event tap" as fatal
- **Parakeet Long Recordings**: Lowered max segment duration from 30s to 15s for more reliable chunked transcription; downgraded reasoning failure log from error to warn

## [1.5.2] - 2026-02-24

### Fixed

- **Reasoning Output**: Resolved empty output for Qwen3/GPT-OSS models by raising local inference minimum tokens from 100 to 512; fixed custom endpoint models misrouting by checking `reasoningProvider` setting before name heuristics
- **Google OAuth**: Added `newUserCallbackURL` to desktop Google OAuth flow for proper new user registration
- **Linux KDE Taskbar**: Prevented dictation panel from appearing in KDE taskbar
- **Intel Mac CI Builds**: Fixed binary architecture mismatch by installing x64 ffmpeg-static binary and preventing prebuild hooks from deleting x64 binaries on arm64 CI runners (#196)

## [1.5.1] - 2026-02-23

### Added

- **GPU-Accelerated Local Inference**: Vulkan (Windows/Linux) and Metal (macOS) support for llama-server with automatic CPU fallback and GPU status badge in the reasoning model selector
- **CUDA GPU Acceleration for Whisper**: NVIDIA GPU acceleration for local Whisper transcription with automatic GPU detection, upgrade banner for existing users, and shared download progress UI
- **On-Demand Vulkan Download**: Vulkan llama-server binary downloads on-demand when the user opts in, saving 40-46MB from the app installer

### Changed

- **Vulkan Llama-Server Architecture**: Switched from bundling the Vulkan binary to on-demand download into userData, mirroring the Whisper CUDA download pattern

### Fixed

- **macOS Paste Failure**: Replaced osascript-based accessibility check with Electron's native `isTrustedAccessibilityClient()` and fixed focus transfer using hide()+showInactive() instead of blur() on NSPanel (#313)
- **Windows Sherpa-onnx Extraction**: Fixed tar extraction failing on Windows due to GNU tar interpreting drive letter colons as remote host separators — now uses relative paths (#284)
- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update

## [1.5.0] - 2026-02-23

### Added

- **Notes System**: Full-featured note-taking built into the control panel
  - Create, edit, and organize notes with a rich Markdown editor
  - Organize notes into custom folders with a default Personal folder
  - Upload audio files for transcription directly into notes
  - Real-time dictation widget for transcribing directly into a note
  - Drag-and-drop to reorder notes and move between folders
  - Guided onboarding flow for first-time notes users
- **AI Actions on Notes**: Apply AI-powered actions to note content
  - Action picker with customizable processing prompts
  - Action manager dialog for creating and editing action templates
  - Processing overlay with live progress feedback
- **Sidebar Navigation**: Redesigned control panel with persistent sidebar
  - New `ControlPanelSidebar` replaces the old tab-based layout
  - Dedicated views for History, Notes, Dictionary, and Settings
  - Collapsible sidebar for more content space
- **Referral Program**: Invite friends to earn free Pro months
  - Referral dashboard with invite tracking and status badges
  - Email invitation flow
  - Animated spectrogram share card with unique referral code
- **New AI Models**: Added Claude 4.6 (Opus), Gemini 3 Flash, and Gemini 3.1 Pro to the model registry
- **Settings Store**: Migrated settings state management to Zustand store for better performance and shared access across components
- **Note Store & Action Store**: New Zustand stores for notes and AI action state

### Changed

- **Control Panel Architecture**: Extracted History, Dictionary, and Settings into standalone views, reducing ControlPanel complexity
- **Settings Refactor**: Extracted bulk of `useSettings` hook logic into `settingsStore.ts` for cleaner separation of concerns
- **UI Polish**: Updated numerous components with improved dark mode support, consistent spacing, and refined typography
- **Locale Updates**: Extended all 10 language files with notes, referral, and sidebar translation keys

### Fixed

- **macOS Auto-Update Architecture**: Detect Rosetta translation via `sysctl.proc_translated` so Apple Silicon users stuck on an x64 build from older releases self-heal to the native arm64 build on next update
- **Linux GTK Crash**: Force GTK3 on Linux startup to avoid GTK symbol crash on systems with GTK4 installed (#291)
- **CI Pipeline**: Added Windows paste binary and key listener download steps to the build workflow (#298)
- **Buy Me a Coffee**: Updated funding link username

## [1.4.11] - 2026-02-13

### Added

- **Japanese Locale**: Full Japanese UI and prompt translations
- **Windows Paste Terminal Detection**: Added kitty to the Windows fast paste binary's terminal class list

### Changed

- **Windows Push-to-Talk Refactor**: Moved PTT state management (hold timing, recording tracking, cooldown) from main process into `windowManager` for cleaner separation and consistency with macOS PTT patterns
- **Audio Recording Reentrancy Guards**: Added lock refs to `useAudioRecording` start/stop to prevent concurrent calls from rapid key presses
- **Synchronous Activation Mode**: `getActivationMode()` is now synchronous (reads from cache), removing unnecessary async overhead in all PTT and hotkey handlers
- **Default Agent Name**: Set default agent name to OpenWhispr

### Fixed

- **Hide vs Minimize**: Dictation panel now consistently hides (rather than minimizing on Windows/Linux) for uniform cross-platform behavior
- **Minimized Window Restore**: Dictation panel restores from minimized state before showing, preventing invisible panel on Windows

## [1.4.10] - 2026-02-13

### Added

- **Deepgram Streaming Liveness Check**: Detects unresponsive warm connections within 2.5s and transparently reconnects with audio replay
- **Batch Transcription Fallback**: If streaming produces no text, automatically falls back to batch transcription via OpenWhispr Cloud
- **Full Locale Codes**: Pass full locale codes (e.g. en-US, zh-CN) to Deepgram instead of stripping to base codes, preserving dialect precision

### Fixed

- **Deepgram Token Expiry**: Fixed token expiry clock resetting on every re-warm cycle, which prevented detection of expired tokens and caused persistent 401 errors
- **Deepgram 401 Recovery**: Invalidate cached tokens on authentication failures so subsequent attempts fetch fresh tokens instead of retrying stale ones

## [1.4.9] - 2026-02-12

### Fixed

- **Deepgram Nova-3 Language Fallback**: Automatically fall back to Nova-2 for languages not yet supported by Nova-3 (e.g., Chinese, Thai), preventing 400 Bad Request errors. Also switches from `keyterm` to `keywords` parameter when using Nova-2.

## [1.4.8] - 2026-02-12

### Added
- **Referral Program**: Invite friends to earn free Pro months with referral dashboard, email invitations, invite tracking with status badges, and animated spectrogram share card with unique referral code
- **Notes System**: Added sidebar navigation with notes system and dictionary view for organizing transcriptions
- **Folder Organization**: Notes can be organized into custom folders with a default Personal folder, folder management UI, and folder-aware note filtering. Upload flow now includes folder selection
- **Internationalization v1**: Full desktop localization across auth, settings, hooks, and UI with centralized renderer locale resources (#258)
- **Chinese Language Split**: Split Chinese into Simplified (zh-CN) and Traditional (zh-TW) with tailored AI instructions and one-time migration for existing users (#267)
- **Russian Interface Language**: Added Russian to interface language options
- **Deepgram Token Refresh & Keyterms**: Proactive token rotation for warm connections before expiry and keyterms pass-through for improved transcription accuracy

### Fixed

- **macOS Non-English Keyboard Paste**: Fixed paste not working on non-English keyboard layouts (Russian, Ukrainian, etc.) by using physical key code instead of character-based keystroke in AppleScript fallback
- **Whisper Language Auto-Detection**: Pass `--language auto` to whisper.cpp explicitly so non-English audio isn't forced to English (#260)
- **Model Download Pipeline**: Inline redirect handling, deferred write stream creation, indeterminate progress bar for unknown sizes, and Parakeet ONNX file validation after extraction
- **Sherpa-onnx Shared Libraries**: Always overwrite shared libraries during download to prevent stale architecture-mismatched binaries, with `--force` support
- **Chinese Translation Fixes**: Minor translation corrections for Chinese interface strings
- **Neon Auth Build Config**: Fixed auth build configuration

## [1.4.7] - 2026-02-11

### Added

- **Deepgram Streaming Transcription**: Migrated real-time streaming transcription from AssemblyAI to Deepgram for improved reliability and accuracy (#249)

### Fixed

- **BYOK After Upgrade**: Prefer localStorage API keys over process.env so Bring Your Own Key mode works correctly after upgrading (#263)
- **PTT Double-Fire Prevention**: Applied post-stop cooldown and press-identity checks to both macOS and Windows push-to-talk handlers
- **Archive Extraction Retry**: Reuse existing archive on extraction retry with improved error handling
- **Email Verification Polling**: Pass email param in verification polling and stop on 401 responses
- **Auth Build Bundling**: Added @neondatabase/auth packages to rollup externals for correct production bundling (#256)
- **Neon Auth Build Config**: Fixed Vite build configuration for Neon Auth packages (#266)

### Changed

- **Build System**: Bumped Node version in build files

## [1.4.6] - 2026-02-10

### Added

- **Robust Model Downloads**: Hardened download pipeline with stall detection, disk space checks, and file validation for more reliable model installs
- **Prompt Handling Improvements**: Improved agent name resolution, prompt studio enhancements, and smarter prompt context assembly
- **Past-Due Subscription Handling**: Users with past-due subscriptions now see clear messaging and recovery options

### Fixed

- **Parakeet Long Audio**: Fixed empty transcriptions for long audio by segmenting input before sending to Parakeet
- **Plus-Addressed Emails**: Reject plus-addressed emails (e.g., user+tag@example.com) during authentication
- **Double-Click Prevention**: Prevent duplicate requests when double-clicking checkout and billing buttons
- **Auth Initialization Race**: Await init-user before completing auth flow and fix missing user dependency

### Changed

- **Startup Performance**: Preload lazy chunks during auth initialization for faster page transitions
- **Code Cleanup**: Removed excess comments and simplified window management logic

## [1.4.5] - 2026-02-09

### Added

- **Dictation Sound Effects Toggle**: New setting to enable/disable dictation audio cues with refined tones (warmer, softer frequencies, gentler attack, distinct start/stop)
- **Toast Notification Redesign**: Redesigned toast notifications as dark HUD surfaces for a more polished look
- **Floating Icon Auto-Hide**: New setting to auto-hide the floating dictation icon
- **Loading Screen Redesign**: Branded loading screen with logo and spinner
- **Discord Support Link**: Added Discord link to the support menu
- **Auth-Aware Routing**: Returning signed-out users now see a re-authentication screen instead of a broken state

### Fixed

- **Dropdown Dark Mode**: Fixed dropdown styling in dark mode
- **Toast Dark Mode**: Fixed toast colouring in dark mode
- **Globe Key Persistence**: Globe key now persists to .env and dictation key syncs to localStorage
- **Globe Listener Cross-Compilation**: Cross-compiled globe listener for x64

### Changed

- **Startup Performance**: Deferred non-critical manager initialization after window creation, lazy-loaded ControlPanel/OnboardingFlow/SettingsModal, converted env file writes to async, extracted SettingsProvider context, and split Radix/lucide into separate vendor chunks
- **Scrollbar Styling**: Subtle transparent-track scrollbar with thinner floating thumb

## [1.4.4] - 2026-02-08

### Fixed

- **AI Enhancement CTA Persistence**: Dismissing the "Enable AI Enhancement" banner now persists to localStorage so it stays hidden across sessions

### Changed

- **Code Cleanup**: Removed excess comments and section dividers in ControlPanel

## [1.4.3] - 2026-02-08

### Added

- **Mistral Voxtral Transcription**: Added Mistral as a cloud transcription provider with Voxtral Mini model and custom dictionary support via context_bias
- **TypeScript Compilation**: Added TypeScript as an explicit dev dependency with project-level `tsconfig.json`

### Fixed

- **Linux Wayland Clipboard**: Persistent clipboard ownership on Wayland so Ctrl+V works reliably after transcription
- **Linux Window Flickering**: Fixed transparent window flickering on Wayland and X11 compositors
- **Windows Modifier-Only Hotkeys**: Support modifier-only hotkeys on Windows via native keyboard hook
- **Update Installation**: Resolved quitAndInstall hang by removing close listeners that block window shutdown during updates
- **Custom System Prompts**: Pass custom system prompt to local and Anthropic BYOK reasoning
- **Audio Cue Audibility**: Improved dictation start/stop audio cue volume
- **Language Selector**: Fixed dropdown positioning and sizing inside settings modal
- **Type Safety**: Tightened Electron IPC callback return types, model picker styles, toast variant types, and event handler signatures across the codebase

### Changed

- **Code Cleanup**: Removed excess comments, section dividers, and redundant JSDoc across components, hooks, and utilities

## [1.4.2] - 2026-02-07

### Fixed

- **AssemblyAI Streaming Reliability**: Fixed real-time WebSocket going silent after idle periods by adding keep-alive pings, readyState validation, re-warm recovery, and connection death handling

## [1.4.1] - 2026-02-07

### Added

- **Runtime .env Configuration**: Environment variables now reload at runtime without requiring app restart
- **Settings Retention on Pro**: Pro subscribers retain their settings when managing their subscription

### Fixed

- **macOS Microphone Permission**: Resolved hardened-runtime mic permission prompt by routing through main-process IPC and unifying API key cache invalidation with event-based AudioManager sync
- **AudioWorklet ASAR Loading**: Inlined AudioWorklet as blob URL to fix module loading failure in packaged ASAR builds
- **Google OAuth Flow**: OAuth now opens in the system browser with deep link callback instead of navigating the Electron window
- **Auth Security Hardening**: Safe JSON parsing, guarded URL constructor, and fixed error information leaks in auth code
- **Deep Link Focus**: Control panel now correctly receives focus when opened via deep link
- **Neon Auth Electron Compatibility**: Routed auth flows through API proxy and fixed Origin header rejection for desktop app
- **Billing Error Visibility**: Checkout and billing errors now surface as toast notifications instead of failing silently
- **Hotkey Persistence**: Added file-based hotkey storage for reliable startup persistence (#181)
- **Email Verification**: Disabled Neon Auth email verification step for smoother onboarding

### Changed

- **Build Optimization**: Binary dependencies are now cached during build for faster CI
- **UI Polish**: Fixed scrollbar styling, provider button styling, and voice recorder icon fill

## [1.4.0] - 2026-02-06

### Added

- **OpenWhispr Cloud**: Cloud-native transcription service — sign in and transcribe without managing API keys
  - Google OAuth and email/password authentication via Neon Auth
  - Email verification flow with polling and resend support
  - Password reset via email magic links
- **Subscription & Billing**: Free and Pro plans with Stripe-powered payments
  - Free plan with rolling weekly word limits (2,000 words/week)
  - Pro plan with unlimited transcriptions
  - 7-day free trial for new accounts with countdown display
  - In-app upgrade prompts when approaching or reaching usage limits
  - Stripe billing portal access for Pro subscribers
- **Usage Tracking**: Real-time usage display with progress bar, color-coded thresholds, and next billing date
- **Account Section in Settings**: Profile display, plan status badge, usage bar, billing management, and sign out
- **Upgrade Prompt Dialog**: When usage limit is reached, offers three paths — upgrade to Pro, bring your own key, or switch to local
- **Cancel Processing Button**: Cancel ongoing transcription processing mid-flight
- **Dynamic Window Resizing**: Window automatically resizes based on command menu and toast visibility
- **Dark Mode Icon Inversion**: Monochrome provider icons now automatically invert in dark mode for better visibility

### Changed

- **Onboarding Redesign**: Auth-first onboarding flow
  - Signed-in users get a streamlined 3-step flow (Welcome → Setup → Activation)
  - Non-signed-in users get a 4-step flow with transcription mode selection
  - Permissions merged into Setup step for signed-in users
- **Transcription Mode Architecture**: Unified mode selection across OpenWhispr Cloud, Bring Your Own Key (BYOK), and Local
  - Signed-in users default to OpenWhispr Cloud
  - Non-signed-in users choose between BYOK and Local
- **Design System Overhaul**: Complete refactor of styling to use design tokens throughout the codebase
  - Button component now uses `text-foreground`, `bg-muted`, `border-border` instead of hardcoded hex values
  - Removed hardcoded classes and inline styles across components
  - Improved button and badge consistency
- **Settings UI Redesign**: Overhauled all settings pages with unified panel system, redesigned sidebar, and extracted permissions section
- **Dark Mode Polish**: Premium button styling, glass morphism toasts, and streamlined visuals
- **App Channel Isolation**: Development, staging, and production channels now use isolated user data directories

### Fixed

- **Light Mode UI Visibility**: Fixed multiple UI elements that were invisible or hard to see in light mode:
  - Settings gear icon in permission cards now uses `text-foreground`
  - Troubleshoot button uses proper foreground color
  - Reset button in developer settings now correctly shows destructive color
  - Settings and Help icons in the toolbar are now properly visible
  - Check for Updates button now renders correctly in light mode
- **Provider Tab Flashing**: Resolved TranscriptionModelPicker tab flashing by extracting ModeToggle component and syncing internal state with props
- **Local Reasoning Model Persistence**: Fixed local reasoning model selection not persisting correctly
- **Parakeet Model Status**: Added dedicated IPC channel for Parakeet model status checks
- **Groq Qwen3 Models**: Removed thinking tokens from Qwen3 models on Groq provider
- **OAuth Session Grace Period**: Automatic session refresh with exponential backoff retry during initial OAuth establishment

## [1.3.3] - 2026-01-28

### Added

- **ONNX Warm-up Inference**: Parakeet server now runs warm-up inference on start to eliminate first-request latency from JIT compilation
- **Startup Preferences Sync**: Renderer startup preferences are now synced to `.env` for server pre-warming on restart

### Changed

- **macOS Tray Behavior**: Hide to tray on macOS for consistent cross-platform behavior

### Fixed

- **macOS Launch Crash**: Added `disable-library-validation` entitlement to resolve macOS launch crash (#120)
- **Reasoning Model Default**: Fixed `useReasoningModel` not correctly defaulting to enabled by persisting useLocalStorage defaults and aligning direct reads
- **Windows Non-ASCII Usernames**: Resolved whisper-server crash on Windows with non-ASCII usernames by pre-converting audio to WAV and routing temp files through ASCII-safe directory
- **Windows Paths with Spaces**: Fixed temp directory fallback to also detect paths with spaces on Windows

## [1.3.2] - 2026-01-27

### Changed

- **Linux Paste Tools**: Prefer xdotool over ydotool for better compatibility

### Fixed

- **Windows Zip Extraction**: Use tar instead of PowerShell Expand-Archive for zip extraction on Windows to avoid issues with special characters

## [1.3.1] - 2026-01-27

### Changed

- **Download System Refactor**: Consolidated model download logic into shared utilities with resume support, retry logic, abort signals, and improved installing state UI
- **Throttled Progress Display**: Whisper model download progress updates are now throttled for smoother UI

## [1.3.0] - 2026-01-26

### Added

- **NVIDIA Parakeet Support**: Fast local transcription via sherpa-onnx runtime with INT8 quantized models
  - `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB
- **Windows Push-to-Talk**: Native Windows key listener with low-level keyboard hook for true push-to-talk functionality
  - Supports compound hotkeys like `Ctrl+Shift+F11` or `CommandOrControl+Space`
  - Prebuilt binary automatically downloaded from GitHub releases
  - Fallback to tap mode if binary unavailable
- **Custom Dictionary**: Improve transcription accuracy for specific words, names, and technical terms
  - Add custom words through Settings → Custom Dictionary
  - Words are passed as hints to Whisper for better recognition
  - Works with both local and cloud transcription
- **GitHub Actions Workflow**: Automated CI workflow to build and release Windows key listener binary
- **Shared Download Utilities**: New `scripts/lib/download-utils.js` module with reusable download, extraction, and GitHub release fetching functions

### Changed

- **Download Scripts Refactored**: All download scripts now use shared utilities for consistency
- **GitHub API Authentication**: Download scripts support `GITHUB_TOKEN` to avoid API rate limits in CI
- **Debug Logging Cleanup**: Extracted common window loading code and cleaned up debug logging

### Fixed

- **GNOME Wayland Hotkey Improvements**: Improved hotkey handling on GNOME Wayland
- **Hotkey Persistence**: Fixed hotkey selection not persisting correctly
- **Custom Endpoint API Keys**: Fixed custom endpoint API keys not persisting to `.env` file
- **Custom Endpoint State**: Fixed custom endpoint using shared state instead of its own
- **Linux Stale Hotkey Registrations**: Clear stale hotkey registrations on startup on Linux
- **Wayland XWayland Paste**: Try xdotool on Wayland when XWayland is available
- **llama-server Libraries**: Bundle llama-server shared libraries and search from extract root for varying archive structures
- **STT/Reasoning Debug Logging**: Added missing debug logging for STT and reasoning pipelines

## [1.2.16] - 2026-01-24

### Fixed

- **App Startup Hang**: Fixed app initialization timing issues with Electron 36+
- **Manager Initialization**: Deferred manager initialization until after `app.whenReady()` to prevent hangs
- **Debug Logger Initialization**: Deferred debugLogger file initialization until `app.whenReady()`
- **Config Bundling**: Fixed missing config files in production builds
- **whisper.cpp Binary Version**: Updated whisper.cpp release names and bumped binary version

## [1.2.15] - 2026-01-22

### Added

- **ydotool Fallback for Linux**: Added ydotool as additional fallback option for clipboard paste operations on Linux systems

### Changed

- **Unified Prompt System**: Refactored to single intelligent prompt system for improved consistency and maintainability
- **whisper.cpp Remote**: Refactored remote whisper.cpp integration for better reliability

## [1.2.14] - 2026-01-22

### Added

- **Troubleshooting Mode**: New debug logging section in settings with toggle for detailed diagnostic logs, log file path display, and direct folder access for easier support
- **Custom Transcription Endpoint**: Support for custom OpenAI-compatible transcription endpoints with configurable base URLs
- **Enhanced Clipboard Debugging**: Detailed clipboard operation logging for diagnosing paste issues across platforms

### Changed

- **API Key Management**: Consolidated and refactored API key persistence with improved .env file handling and recovery mechanisms
- **Local Network Detection**: Refactored URL detection into reusable utility for better code organization
- **Electron Builder**: Updated to latest version for improved build performance

### Fixed

- **Windows/Linux Taskbar**: Prevented dual taskbar entries on Windows and Linux by properly configuring window behavior
- **Single Instance Lock**: Enforced single instance lock with cleaner window state checks
- **Model Provider Consistency**: Removed redundant fallbacks and ensured consistent use of getModelProvider()
- **Cross-env Support**: Fixed Windows compatibility in pack script using cross-env
- **Linux X11 Paste**: Improved paste reliability by capturing target window ID upfront with windowactivate --sync, added xdotool type fallback for terminals
- **Tray Minimize**: Fixed minimize to tray functionality

## [1.2.12] - 2026-01-20

### Added

- **LLM Download Cancellation**: Added ability to cancel in-progress local LLM model downloads with throttled progress updates to prevent UI flashing

### Changed

- **Gemini Model Updates**: Updated Gemini models to latest versions
- **Linux Wayland Improvements**: Improved Wayland paste detection with GNOME-specific handling and XWayland fallback support
- **whisper.cpp CUDA Support**: Updated whisper.cpp download script to include CUDA-enabled binaries

### Fixed

- **Windows Paste Delay**: Adjusted paste delay timing on Windows for more reliable text insertion
- **Blank Audio Prevention**: Fixed issue where blank/silent audio recordings would paste empty text
- **Newline Handling**: Fixed newline formatting issues in transcribed text

## [1.2.11] - 2026-01-18

### Fixed

- **ASAR Path Resolution**: Fixed path resolution issues for bundled resources in packaged builds
- **Update Checker**: Fixed auto-update checker initialization
- **Build Includes**: Ensured services and models are properly included in production builds
- **OS Module Import**: Fixed OS module import ordering

## [1.2.10] - 2026-01-17

### Fixed

- **Streaming Backpressure**: Fixed proper streaming backpressure handling in audio processing
- **Quit and Install**: Fixed update installation on app quit

## [1.2.9] - 2026-01-17

### Fixed

- **Path Resolution**: Improved path resolution for better cross-platform compatibility

## [1.2.8] - 2026-01-16

### Added

- **Microphone Input Selection**: Choose your preferred microphone input device in settings, with built-in mic preference to prevent Bluetooth audio interruptions
- **Push to Talk Mode**: New recording mode option alongside the existing toggle mode
- **Hotkey Listening Mode**: Prevents conflicts when capturing new hotkeys by temporarily disabling the global hotkey
- **Hotkey Fallback System**: Automatic fallback with user notifications when preferred hotkey is unavailable
- **Cross-Platform Accessibility Settings**: Quick access to system accessibility settings on macOS

### Changed

- **Streamlined Onboarding**: Removed redundant "How it Works" section, success dialogs, and manual save buttons for a smoother setup experience
- **Improved Select Styling**: Enhanced dropdown select component appearance

### Fixed

- **FFmpeg Availability Types**: Corrected type definitions and optimized whisper-cpp download process
- **Whisper Models Path**: Fixed model storage path resolution
- **Better Path Resolution**: Improved error handling for file paths
- **Open Mic Settings**: Fixed system settings link for microphone configuration

## [1.2.7] - 2026-01-13

### Added

- **Whisper Server HTTP Mode**: Added persistent whisper-server for faster repeated transcriptions with automatic CLI fallback
- **Pipeline Timing Instrumentation**: Added detailed timing logs for each stage of the transcription pipeline
- **Whisper Server Pre-warming**: Server pre-warms on startup for faster first transcription

### Changed

- **Windows Clipboard**: Reduced clipboard delays for faster text pasting on Windows

### Fixed

- **Windows Update Install**: Simplified Windows update installation by using silent mode and removing redundant before-quit handling
- **Mac Build Workflows**: Fixed CI/CD to run separate workflows for Mac builds
- **Mac DMG Build Race Condition**: Fixed release workflow DMG build failure caused by concurrent arm64/x64 builds mounting same volume
- **Windows Download Script**: Fixed PowerShell Expand-Archive failure with bracket characters in directory names

## [1.2.6] - 2026-01-13

### Changed

- **Settings Layout**: Moved settings navigation to left side on Windows and Linux for improved consistency

### Fixed

- **Linux Whisper Detection**: Fixed issue where Python-based Whisper could be used instead of whisper.cpp on Linux systems

## [1.2.5] - 2026-01-13

### Added

- **Model Validation**: Added validation when deleting or loading Whisper models to ensure model integrity
- **Download Cancellation**: Added ability to cancel in-progress model downloads in whisper pickers
- **Windows Paste Performance**: Added nircmd for faster text pasting on Windows

### Fixed

- **EventEmitter Memory Leak**: Fixed memory leak caused by duplicate listener registration in useUpdater hook across ControlPanel and SettingsPage components
- **FFmpeg Path Resolution**: Fixed FFmpeg path resolution in unpacked ASAR for local whisper.cpp transcription

### Changed

- **UI Cleanup**: Removed redundant UI elements for a cleaner interface

## [1.2.4] - 2026-01-13

### Changed

- **whisper.cpp Packaging**: Moved whisper.cpp binaries from ASAR to extraResources for improved reliability and faster startup

### Fixed

- **Package Lock Sync**: Fixed package-lock.json synchronization with package.json dependencies

## [1.2.3] - 2026-01-13

### Added

- **Extended Hotkey Support**: Added numpad keys, media keys, and additional special keys (Pause, ScrollLock, PrintScreen, NumLock) for hotkey selection
- **Improved Hotkey Error Messages**: Registration failures now include helpful suggestions for alternative hotkeys

### Changed

- **Linux Paste Tools**: Only show paste tools installation prompt on Linux when tools are not available

### Fixed

- **Hotkey Debugging**: Added comprehensive debug logging to hotkey manager for troubleshooting registration issues

## [1.2.2] - 2026-01-13

### Fixed

- **React Version Mismatch**: Fixed blank screen caused by incompatible React and React-DOM versions in package-lock.json

## [1.2.1] - 2026-01-13

### Fixed

- **Blank Screen on Upgrade**: Fixed white screen issue for users upgrading from older versions with different onboarding step counts. The onboarding step index is now properly clamped to valid range.

## [1.2.0] - 2026-01-13

### Added

- **Delete All Whisper Models**: New option to delete all downloaded Whisper models at once
- **Model Deletion Confirmation**: Added confirmation dialog when deleting models in settings

### Changed

- **Migrated to whisper.cpp**: Replaced Python-based Whisper with native whisper.cpp for faster, more reliable transcription
  - No longer requires Python installation
  - WebM-to-WAV audio conversion built-in
  - Significantly improved startup and transcription speed
- **Streamlined Onboarding**: Simplified setup flow with fewer steps now that Python is not required
- **Download Cancellation**: Added ability to cancel in-progress model downloads
- **CI/CD Updates**: Updated build and release workflows

### Fixed

- **IPC Handler**: Fixed broken IPC handler for model operations
- **Logging**: Standardized logging across the application
- **React Hook Dependencies**: Improved React hook dependency arrays for better performance
- **Button Styling**: Fixed button styling consistency across the application

### Removed

- **Python Dependency**: Removed Python requirement and all related installation code
- **whisper_bridge.py**: Removed Python-based Whisper bridge in favor of native whisper.cpp

## [1.1.2] - 2026-01-12

### Added

- **Linux Package Dependencies**: Recommended xdotool, wtype, and python3 packages for Linux users

### Fixed

- **Python Installation Race Condition**: Fixed race condition in Python installation check that could cause installation to fail or hang

## [1.1.1] - 2026-01-12

### Added

- **Cross-Platform Paste Tools Detection**: Onboarding now detects and guides users through installing paste tools on Linux and Windows with auto-grant accessibility

### Changed

- **Qwen Model Compatibility**: Disabled thinking mode for Qwen models on Groq to prevent compatibility issues
- **Model Registry Refactor**: disableThinking flag now uses the centralized model registry
- **Consolidated ColorScheme Types**: Removed redundant default exports and cleaned up inline font styles
- **Provider Icons**: Use static imports for provider icons to fix Vite bundling issues

### Fixed

- **Recording Cancellation**: Restored cancel recording functionality that was accidentally removed
- **Model Downloads**: Implemented atomic downloads with temp file pattern and robust cleanup handling for cross-platform reliability
- **Incomplete Download Prevention**: Model file size validation now prevents incomplete downloads from showing as complete
- **Windows PowerShell Performance**: Optimized paste startup time on Windows

## [1.1.0] - 2026-01-10

### Added

- **Compound Hotkey Support**: Use multi-key combinations like `Cmd+Shift+K` or `Ctrl+Alt+D` for dictation
- **Groq API Integration**: Ultra-fast AI inference with Groq's cloud API
- **Auto-Update UI**: Download progress bars and install button in settings
- **Recording Cancellation**: Cancel an in-progress recording without transcribing
- **Release Notes Viewer**: Markdown-rendered release notes in settings

### Changed

- **Major Hotkey Refactor**: Complete rewrite of hotkey selection with improved reliability and validation
- **Consolidated Model Registry**: Single source of truth for all AI models (`modelRegistryData.json`)
- **Unified Model Picker**: Reusable component for both transcription and reasoning model selection
- **Improved Latency Logging**: Numbered stage logs for recording, transcription, reasoning, and paste timing
- **Reduced Paste Delay**: Lowered from 100ms to 50ms for faster text insertion
- **Code Quality**: Added ESLint, Prettier for JS/TS, and Ruff for Python

### Fixed

- **Windows 11 Compatibility**: Fixed PATH separator, cache directories, and process termination
- **Python Virtual Environment**: Fixed race condition and added Arch Linux venv support
- **Microphone Detection**: Improved onboarding flow for missing inputs with deep-linking to system settings
- **Recording State Alignment**: Recording now aligns to MediaRecorder's actual start/stop events
- **Caching Optimizations**: Cached accessibility, paste tool, and FFmpeg checks to reduce process spawns
- **Window Titles**: Electron window titles now set correctly after page load

## [1.0.15] - 2026-01-05

### Added

- Button to fully quit OpenWhispr processes from the application
- Linux terminal detection with automatic paste key switching (Ctrl+Shift+V for terminals)

### Changed

- Standardized logging on log levels with renderer IPC and `.env` refresh for consistent debug output

### Fixed

- Use `kdotool` for Wayland terminal detection, improving clipboard paste reliability
- Increased delay before restoring clipboard to avoid race conditions during paste operations
- Persist OpenAI key before onboarding test to prevent key loss during setup
- Windows Python discovery now correctly handles output parsing
- Keep FFmpeg debug schema as boolean type
- Fixed OpenWhispr documentation paths
- Windows: Resolved issue #16 with WAV validation, registry-based Python detection, and normalized FFmpeg paths

## [1.0.13] - 2025-12-24

### Added

- Enhanced Linux support with Wayland compatibility, multiple package formats (AppImage, deb, rpm, Flatpak), and native window controls
- Auto-detect existing Python during onboarding and gate the installer with a recheck option
- "Use Existing Python" skip flow to onboarding with confirmation dialog

### Changed

- Reuse audio manager and stabilize dictation toggle callback to fix recording latency
- Add cleanup functions to IPC listeners to prevent memory leaks
- Make Flatpak opt-in for local builds only

### Fixed

- Optimized transcription pipeline with caching, batched reads, and non-blocking operations for improved performance
- Reference error in settings page
- Removed redundant audio listener causing unnecessary processing
- Added IPC listener cleanup to prevent memory leaks
- Performance improvements: removed duplicate useEffect, fixed blur causing re-renders

### CI/CD

- Add caching for Electron and Flatpak downloads
- Add Flatpak runtime installation to workflow
- Add Linux packaging dependencies to GitHub Actions workflow

## [1.0.12] - 2025-11-13

### Added

- Added `scripts/complete-uninstall.sh` plus a new TROUBLESHOOTING guide so you can collect arch diagnostics, clean caches, and reset permissions before reinstalling stubborn builds.
- Control Panel history now auto-refreshes through a shared store and IPC events, so new, deleted, or cleared transcripts sync instantly without a manual refresh.
- Distribution artifacts now include both Apple Silicon and Intel macOS DMG/ZIP outputs, and the README documents Debian/Ubuntu packaging along with optional `xdotool` support.

### Changed

- The onboarding flow now validates dictation hotkeys before letting you continue, remembers whether cloud auth was skipped, and only persists sanitized API keys once supplied.
- History entries normalize timestamps and no longer run the removed legacy text cleanup helper, so the UI shows the exact Whisper output that was saved.

### Fixed

- Local Whisper now finds Python on Windows more reliably by scanning typical install paths, honoring `OPENWHISPR_PYTHON`, and surfacing actionable ENOENT guidance.
- Whisper installs automatically retry pip operations that hit PEP‑668, TOML, or permission errors, sanitizing the output and falling back to `--user` + legacy resolver when needed.

## [1.0.11] - 2025-10-13

### Added

- Settings, onboarding, and the AI model selector now accept OpenAI-compatible custom base URLs for both transcription and reasoning providers, complete with validation and reset helpers.
- Windows now gets full tray behavior: closing the control panel hides it to the tray, left-click reopens it, and the UI adds a native close button.

### Changed

- ReasoningService sends both `input` and `messages` payloads and automatically falls back between `/responses` and `/chat/completions` so older OpenAI-compatible endpoints keep working.

### Fixed

- Successful endpoint detection is cached per base URL, so the app remembers whether to call `/responses` or `/chat/completions` instead of retrying the wrong path forever.
- Custom endpoint fields now enforce HTTPS (with localhost as the lone exception) across the UI and services, preventing API keys from ever leaving over plain HTTP.

## [1.0.10] - 2025-10-07

### Added

- Added a `compile:globe` build step that emits a macOS Globe listener binary into `resources/bin` before every dev, pack, or dist command so the hotkey ships with all builds.

### Fixed

- Globe key failures now raise a macOS dialog, verify the bundled binary is executable, and kill/restart the listener cleanly so the shortcut survives packaging.

## [1.0.9] - 2025-10-07

### Changed

- Simplified the release workflow by removing the bespoke GitHub release job and letting electron-builder upload draft releases directly.

## [1.0.8] - 2025-10-03

### Fixed

- Globe/Fn hotkey reliability improved by showing the dictation panel before toggling, making focus optional, and surfacing listener spawn errors instead of failing silently.

## [1.0.7] - 2025-10-03

### Added

- Settings update controls now show download progress bars, install countdowns, and clearer messaging while fetching or installing new builds.

### Changed

- Auto-update internals now track listeners, cache the last release metadata, and keep auto-download/auto-install disabled until the user explicitly triggers an update, eliminating the previous memory leaks.

### Fixed

- `Install & Restart` now emits `before-quit`, enables `autoInstallOnAppQuit`, logs progress, and calls `quitAndInstall(false, true)` so updates actually apply when quitting or pressing the button.

## [1.0.6] - 2025-09-11

### Added

- **Dictation Panel Command Menu**: Clicking the floating panel reveals quick actions, including a one-click "Hide this for now" option.
- **macOS Globe Key Support**: Added a lightweight Swift listener so the Globe/Fn key can toggle dictation across the system.
- **Globe Key Selection UI**: Settings and onboarding keyboards now include a dedicated Globe key option.
- **Hotkey Validation**: Settings and onboarding now verify shortcut registration immediately, alerting users when a key can’t be bound.
- **Model Cache Cleanup**: Added an in-app command (and installer/uninstaller hooks) to delete all cached Whisper models.
- **Tray Controls**: macOS tray menu gained quick actions to show or hide the dictation panel.

### Changed

- **Dictation Overlay Placement**: Window now anchors to the active workspace's bottom-right corner with a safety margin, preventing it from sliding off-screen on multi-monitor setups.
- **Dictation Overlay Canvas**: Enlarged the floating window so tooltips, menus, and error states render without being clipped while keeping click-through behaviour outside interactive elements.
- **Keyboard UX**: Virtual keyboard hides macOS-exclusive keys on Windows/Linux and standardises hotkey labels.

### Fixed

- **macOS Window Lifecycle**: Ensured the dictation panel keeps the app visible in Dock and Command-Tab while retaining floating behaviour across spaces.
- **Control Panel Stability**: Reworked close/minimize handling so the panel stays interactive when switching apps and reopens cleanly without spawning duplicate windows.
- **Always-On-Top Enforcement**: Centralised the logic that reapplies floating window levels, eliminating redundant timers and focus quirks.
- **Menu Labelling**: macOS application menu items now display the correct OpenWhispr casing instead of "open-whispr".
- **Non-mac Hotkey Guard**: Prevented the mac-only Globe shortcut from being saved on Windows/Linux.

## [1.0.5] - 2025-09-10

### Fixed

- **Build System**: Fixed native module signing conflicts on macOS
  - Added `npmRebuild: true` to force rebuild of native modules during packaging
  - Added `buildDependenciesFromSource: true` to compile native dependencies from source
  - Added `better-sqlite3` to `asarUnpack` array to properly unpack SQLite3 native module
  - Resolves "different Team IDs" error when launching notarized macOS apps
- **CI/CD Pipeline**: Fixed automated release workflow issues
  - Removed automatic version update step from release workflow (version should be set before tagging)
  - Added `contents: write` permission to allow workflow to create GitHub releases
  - Fixes "Resource not accessible by integration" error during releases

### Technical Details

- This is a maintenance release focusing on build reliability and deployment infrastructure
- No feature changes or user-facing functionality updates
- All changes related to packaging, signing, and automated release processes

## [1.0.4] - 2025-09-09

### Added

- **Multi-Provider AI Support**: Integrated three major AI providers for text processing
  - OpenAI: Complete model suite including:
    - GPT-5 Series (Nano/Mini/Full) - Latest generation with deep reasoning
    - GPT-4.1 Series (Nano/Mini/Full) - Enhanced coding, 1M token context, June 2024 knowledge
    - o-series (o3/o3-pro/o4-mini) - Advanced reasoning models with extended thinking time
    - GPT-4o/4o-mini - Multimodal models with vision support
  - Anthropic: Claude Opus 4.1, Sonnet 4, and 3.5 variants for frontier intelligence
  - Google: Gemini 2.5 Pro/Flash/Flash-Lite and 2.0 Flash for advanced processing
- **OpenAI Responses API Integration**: Migrated from Chat Completions to the new Responses API
  - Simplified request format with `input` array instead of `messages`
  - New response parsing for `output` items with typed content
  - Automatic handling of model-specific requirements
  - Better support for GPT-5 and o-series reasoning models
- **Enhanced Reasoning Service**: Complete TypeScript rewrite with provider abstraction
  - Automatic provider detection based on selected model
  - Secure API key caching with TTL
  - Unified retry strategies across all providers
  - Provider-specific token optimization (up to 8192 for Gemini)
- **Comprehensive Debug Logging**: Enhanced reasoning pipeline with stage-by-stage logging
  - Provider selection and routing logs
  - API key retrieval and validation logs
  - Request/response details for all providers
  - Error tracking with full stack traces
- **Improved Settings UI**: Comprehensive API key management for all providers
  - Color-coded provider sections (OpenAI=green, Anthropic=purple, Gemini=blue)
  - Inline API key validation and secure storage
  - Provider-specific model selection with descriptions

### Changed

- **Default AI Model**: Updated from GPT-3.5 Turbo to GPT-4o Mini for cost-efficient multimodal support
- **Model Updates**: Refreshed all AI models to their latest 2025 versions
  - OpenAI: Added GPT-5 family (released August 2025), migrated to Responses API
  - Anthropic: Updated to Claude Opus 4.1 and Sonnet 4, fixed model naming
  - Gemini: Added latest 2.5 series models, increased token limits
- **ReasoningService**: Migrated from JavaScript to TypeScript for better type safety
- **API Endpoint Updates**:
  - OpenAI: Migrated from `/v1/chat/completions` to `/v1/responses`
  - Request format simplified for better performance
  - Response parsing updated for new output structure
- **Model Configuration Improvements**:
  - Fixed Anthropic model names (using hyphens instead of dots)
  - Increased Gemini 2.5 Pro token limits (2000 minimum)
  - Removed temperature parameter for GPT-5 and o-series models
- **Documentation**: Updated CLAUDE.md, README.md with comprehensive provider information

### Fixed

- **API Key Persistence**: All provider keys now properly save to `.env` file
  - Added `saveAllKeysToEnvFile()` method for consistent persistence
  - Keys reload automatically on app restart
  - Fixed Gemini and Anthropic key storage issues
- **CORS Issues**: Anthropic API calls now route through IPC handler
  - Avoids browser CORS restrictions in renderer process
  - Proper error handling in main process
- **Empty Response Handling**: Fixed "No text transcribed" error when AI returns empty
  - Falls back to original text when API returns nothing
  - Properly handles edge cases in response parsing
- **Parameter Compatibility**: Fixed OpenAI API parameter errors
  - GPT-5 models use simplified parameters (no max_tokens)
  - o-series models configured without temperature
  - Older models retain full parameter support

### Technical Improvements

- Added Gemini API integration with proper authentication flow
- Implemented SecureCache utility for API key management
- Enhanced IPC handlers for multi-provider support
- Updated environment manager with Gemini key storage
- Improved error handling with provider-specific messages
- Added comprehensive retry logic with exponential backoff
- Enhanced error messages with detailed logging
- Better fallback strategies for API failures
- Improved response validation and parsing
- Centralized API configuration in constants file
- Unified debugging system across all providers

## [1.0.3] - 2024-12-20

### Added

- **Local AI Models**: Integration with community models for complete privacy
  - Support for Llama, Mistral, and other open-source models
  - Local model management UI with download progress
  - Automatic model validation and testing
- **Enhanced Security**: Improved API key storage and management
  - System keychain integration where available
  - Encrypted localStorage fallback
  - Automatic key rotation support

### Fixed

- Resolved issues with Whisper model downloads on slow connections
- Fixed clipboard pasting reliability on Windows 11
- Improved error messages for better debugging
- Fixed memory leaks in long-running sessions

### Changed

- Optimized audio processing pipeline for 30% faster transcription
- Reduced app bundle size by 15MB through dependency optimization
- Improved startup time by lazy-loading heavy components

## [1.0.2] - 2024-12-19

### Added

- **Automatic Python Installation**: The app now detects and offers to install Python automatically
  - macOS: Uses Homebrew if available, falls back to official installer
  - Windows: Downloads and installs official Python with proper PATH configuration
  - Linux: Uses system package manager (apt, yum, or pacman)
- **Enhanced Developer Experience**:
  - Added MIT LICENSE file
  - Improved documentation for personal vs distribution builds
  - Added FAQ section to README
  - Added security information section
  - Clearer prerequisites and setup instructions
  - Added comprehensive CLAUDE.md technical reference
- **Dock Icon Support**: App now appears in the dock with activity indicator
  - Changed LSUIElement from true to false in electron-builder.json
  - App shows in dock on macOS with the standard dot indicator when running

### Changed

- Updated supported language count from 90+ to 58 (actual count in codebase)
- Improved README structure for better open source experience

## [1.0.1] - 2024-XX-XX

### Added

- **Agent Naming System**: Personalize your AI assistant with a custom name for more natural interactions
  - Name your agent during onboarding (step 6 of 8)
  - Address your agent directly: "Hey [AgentName], make this more professional"
  - Update agent name anytime through settings
  - Smart AI processing distinguishes between commands and regular dictation
  - Clean output automatically removes agent name references
- **Draggable Interface**: Click and drag the dictation panel to any position on screen
- **Dynamic Hotkey Display**: Tooltip shows your actual hotkey setting instead of generic text
- **Flexible Hotkey System**: Fixed hardcoded hotkey limitation - now fully respects user settings

### Changed

- **[BREAKING]** Removed click-to-record functionality to prevent conflicts with dragging
- **UI Behavior**: Recording is now exclusively controlled via hotkey (no accidental triggering)
- **Tooltip Text**: Shows "Press {your-hotkey} to speak" with actual configured hotkey
- **Cursor Styles**: Changed to grab/grabbing cursors to indicate draggable interface

### Fixed

- **Hotkey Bug**: Fixed issue where hotkey setting was stored but not actually used by global shortcut
- **Documentation**: Updated all docs to reflect current UI behavior and hotkey system
- **User Experience**: Eliminated confusion between drag and click actions

### Technical Details

- **Agent Naming Implementation**:
  - Added centralized agent name utility (`src/utils/agentName.ts`)
  - Enhanced onboarding flow with agent naming step
  - Updated ReasoningService with context-aware AI processing
  - Added agent name settings section with comprehensive UI
  - Implemented smart prompt generation for agent-addressed vs regular text
- Added IPC handlers for dynamic hotkey updates (`update-hotkey`)
- Implemented window-level dragging using screen cursor tracking
- Added real-time hotkey loading from localStorage in main dictation component
- Updated WindowManager to support runtime hotkey changes
- Added proper drag state management with smooth 60fps window positioning
- **Code Organization**: Extracted functionality into dedicated managers and React hooks:
  - HotkeyManager, DragManager, AudioManager, MenuManager, DevServerManager
  - useAudioRecording, useWindowDrag, useHotkey React hooks
  - WindowConfig utility for centralized window configuration
  - Reduced WindowManager from 465 to 190 lines through composition pattern

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of OpenWhispr (formerly OpenWispr)
- Desktop dictation application using OpenAI Whisper
- Local and cloud-based speech-to-text transcription
- Real-time audio recording and processing
- Automatic text pasting via accessibility features
- SQLite database for transcription history
- macOS tray icon integration
- Global hotkey support (backtick key)
- Control panel for settings and configuration
- Local Whisper model management
- OpenAI API integration
- Cross-platform support (macOS, Windows, Linux)

### Features

- **Speech-to-Text**: Convert voice to text using OpenAI Whisper
- **Dual Processing**: Choose between local processing (private) or cloud processing (fast)
- **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large)
- **Transcription History**: View, copy, and delete past transcriptions
- **Accessibility Integration**: Automatic text pasting with proper permission handling
- **API Key Management**: Secure storage and management of OpenAI API keys
- **Real-time UI**: Live feedback during recording and processing
- **Global Hotkey**: Quick access via customizable keyboard shortcut
- **Database Storage**: Persistent storage of transcriptions with SQLite
- **Permission Management**: Streamlined macOS accessibility permission setup

### Technical Stack

- **Frontend**: React 19, Vite, TailwindCSS, Shadcn/UI components
- **Backend**: Electron 36, Node.js
- **Database**: better-sqlite3 for local storage
- **AI Processing**: OpenAI Whisper (local and API)
- **Build System**: Electron Builder for cross-platform packaging

### Security

- Local-first approach with optional cloud processing
- Secure API key storage and management
- Sandboxed renderer processes with context isolation
- Proper clipboard and accessibility permission handling
