import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { InferenceSelection } from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
} from '@/services/providers/ProviderCredentials';
import type {
  RealtimeMeetingDeps,
  WebSocketLike,
} from '@/services/transcription/createRealtimeMeetingWs';
import { assemblyAiLiveSocket, assemblyAiStreamingToken } from './assemblyai';
import { deepgramLiveSocket } from './deepgram';
import { requestJson } from './http';

/** The providers whose keys can transcribe a meeting while people talk. */
export const LIVE_PROVIDERS = ['openai', 'deepgram', 'assemblyai'] as const;
export type LiveProviderId = (typeof LIVE_PROVIDERS)[number];

/** The model a key runs live meetings on. */
export const LIVE_MODEL: Record<LiveProviderId, string> = {
  openai: 'gpt-4o-transcribe',
  deepgram: 'nova-3',
  assemblyai: 'universal-streaming',
};

// The meeting transport streams 24 kHz PCM (live-pcm-streaming's default).
const SAMPLE_RATE = 24000;

export function isLiveProvider(id: string | undefined): id is LiveProviderId {
  return LIVE_PROVIDERS.includes(id as LiveProviderId);
}

/**
 * The key a live meeting runs on: one saved for meetings, unless On device is the default,
 * which keeps meetings on the phone.
 */
export function meetingKey(): (InferenceSelection & { providerId: LiveProviderId }) | null {
  if (useProcessingModeStore.getState().activeMode === 'private') return null;
  const selection = useConfigStore.getState().config?.inference?.meeting;
  return selection?.mode === 'providers' && isLiveProvider(selection.providerId)
    ? (selection as InferenceSelection & { providerId: LiveProviderId })
    : null;
}

async function keyFor(provider: LiveProviderId): Promise<string> {
  const credential = await getProviderCredential(await getProviderCredentialReference(provider));
  if (!credential) throw new Error(`Add your ${provider} key again in Settings → Processing.`);
  return credential.apiKey;
}

/** Mints an OpenAI Realtime client secret on the phone, configured as OpenWhispr's server does. */
async function openAiClientSecret(apiKey: string, model: string, language?: string) {
  const { value } = (await requestJson(
    'OpenAI',
    'https://api.openai.com/v1/realtime/client_secrets',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: SAMPLE_RATE },
              transcription: { model, ...(language && language !== 'auto' ? { language } : {}) },
              noise_reduction: { type: 'far_field' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.3,
                silence_duration_ms: 800,
                prefix_padding_ms: 500,
              },
            },
          },
        },
      }),
    },
  )) as { value: string };
  return value;
}

// The transport passes each leg's secret in its subprotocol; the adapters read it back from there.
const secretFrom = (protocols: string[]) =>
  protocols.find((item) => item.startsWith('openai-insecure-api-key.'))?.slice(24) ?? '';

/**
 * How a live meeting connects: with no key saved for meetings, OpenWhispr Cloud as before
 * (no deps). With one, every leg gets its secret from the user's key, and Deepgram or
 * AssemblyAI sockets stand in for OpenAI's.
 */
export function liveMeetingDeps(language?: string): RealtimeMeetingDeps {
  const selection = meetingKey();
  if (!selection) return {};
  const { providerId } = selection;
  const model = selection.modelId || LIVE_MODEL[providerId];
  if (providerId === 'openai')
    return {
      fetchClientSecret: async () => openAiClientSecret(await keyFor('openai'), model, language),
    };
  if (providerId === 'deepgram')
    return {
      fetchClientSecret: () => keyFor('deepgram'),
      wsFactory: (_url, protocols): WebSocketLike =>
        deepgramLiveSocket(secretFrom(protocols), SAMPLE_RATE, language),
    };
  return {
    fetchClientSecret: async () => assemblyAiStreamingToken(await keyFor('assemblyai')),
    wsFactory: (_url, protocols): WebSocketLike =>
      assemblyAiLiveSocket(secretFrom(protocols), SAMPLE_RATE),
  };
}
