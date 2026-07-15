---
name: refactor-local-only-progress
description: Estado do refactor local-only do OpenWhispr — o que foi feito e o que falta
metadata:
  type: project
---

# Refactor Local-Only — Estado Atual (atualizado 2026-07-13)

## Objetivo
Remover toda dependência de cloud, login/auth e acesso externo do OpenWhispr para que rode 100% offline.

## O que foi feito (✅)

### src/lib/auth.ts — stub no-op
### src/hooks/useAuth.ts — stub: isSignedIn: true
### src/services/SyncService.ts — stub: canSync() = false
### src/services/*.ts (12 ficheiros) — throw new Error("cloud disabled")
### scripts/lib/download-utils.js — usa HF_TOKEN
### package.json — removido download:whisper-vad-model de predev/prestart

### main.js — COMPLETO ✅
Removido: DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL, DEFAULT_AUTH_BRIDGE_PORT, getOAuthProtocol, OAUTH_PROTOCOL, shouldRegisterProtocolWithAppArg, getDefaultHtmlHandler, restoreHtmlHandlerIfChanged, isOAuthSchemeRegistered, GoogleCalendarManager require, googleCalendarManager variable/usage, authBridgeServer, parseAuthBridgePort, AUTH_BRIDGE_*, app.on("open-url"), getOauthCookieName, applySessionTokenAndRefresh, handleOAuthDeepLink, handleUpgradeDeepLink, parseJsonBody, writeCorsHeaders, OAuth block in second-instance, limit-reached handler.
MeetingDetectionEngine agora recebe null como primeiro argumento (googleCalendarManager).

### src/helpers/ipcHandlers.js — COMPLETO ✅
Removido imports: tokenStore, AssemblyAiStreaming, DeepgramStreaming, CortiStreaming, OpenAIRealtimeStreaming, cortiAuth, tinfoilSecureClient, tinfoilCatalog, tinfoilTranscription.
STREAMING_CLIENT_BY_PROVIDER = {} (vazio), ALLOWED_MEETING_PROVIDERS = Set(["local"]).
Removidos handlers: get-corti-*, proxy-corti-transcription, get-tinfoil-*, proxy-tinfoil-transcription, auth-clear-session, auth-get-token, auth-set-token, cloud-transcribe, cloud-health-check, cloud-reason, cloud-agent-stream-*, cloud-usage, cloud-checkout, cloud-billing-portal, cloud-switch-plan, cloud-preview-switch, cloud-api-request, get-note-recording-config, transcribe-audio-file-cloud, get-referral-stats, send-referral-invite, get-referral-invites, get-oauth-protocol-registered, get-oauth-protocol, fetchStreamingToken, assemblyai-streaming-*, deepgram-streaming-*, corti-streaming-*, gcal-*, join-calendar-meeting, proxy-xai-transcription, proxy-mistral-transcription, process-anthropic-reasoning.
Removidos: _mintStoredCortiToken método, MISTRAL_TRANSCRIPTION_URL, XAI_STT_URL constantes, campos do construtor (googleCalendarManager, oauthProtocol*, assemblyAiStreaming, deepgramStreaming, cortiStreaming), googleCalendarManager no teardown.

### Ficheiros deletados (12) ✅
- src/helpers/assemblyAiStreaming.js
- src/helpers/deepgramStreaming.js
- src/helpers/cortiStreaming.js
- src/helpers/cortiAuth.js
- src/helpers/cortiTranscription.js
- src/helpers/openaiRealtimeStreaming.js
- src/helpers/tinfoilSecureClient.js
- src/helpers/tinfoilTranscription.js
- src/helpers/tinfoilCatalog.js
- src/helpers/googleCalendarManager.js
- src/helpers/googleCalendarOAuth.js
- src/helpers/tokenStore.js

## O que FALTA fazer

### Fase 8: Remover UI de workspace/billing/convites ❌
Componentes de UI que referenciam cloud/auth/billing. Ver src/components/ e src/pages/.

### Fase 9: Remover UI de auth (AuthenticationStep, EmailVerificationStep) ❌
Passos de autenticação no OnboardingFlow.tsx.

### Fase 10: Remover cloud inference providers ❌
Manter só local + lan. Ver src/services/ai/inferenceProviders/index.ts.
Remover: anthropic, enterprise, gemini, groq, openwhispr providers. Manter: local, lan.

### Fase 11: Remover enterprise config UI ❌
UI de configuração de enterprise providers nas Settings.

### Fase 12: Remover cloud transcription UI ❌
UI de opção cloud vs local na settings/onboarding.

### Fase 13: Remover hooks e componentes não usados ❌
Verificar o que ficou órfão após as fases anteriores.

### Fase 14: Limpar preload.js ❌
Remover IPC channels cloud que já não existem no main.

### Fase 15: Remover dependências npm não usadas ❌
Ver package.json — remover deps que eram só cloud (ex: @clerk/*, etc.)

### Fase especial: cloudApi.ts ❌
Ainda importado por OnboardingFlow.tsx. Remover o import e depois deletar o ficheiro.

## Como continuar numa nova sessão

1. Lê esta memória: refactor_local_only_progress
2. Continua com Fase 10 (cloud inference providers) — é a mais impactante na lógica
3. Depois Fases 8-9 (UI de auth/billing)
4. Depois 11-15 (limpeza final)
