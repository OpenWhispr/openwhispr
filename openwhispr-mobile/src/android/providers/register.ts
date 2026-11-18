import { registerTranscriptionProvider } from '@/lib/mobileProviders';
import { assemblyAiProvider } from './assemblyai';
import { deepgramProvider } from './deepgram';

// Android's own transcription clients, for dictation and uploads on a Deepgram or AssemblyAI key.
registerTranscriptionProvider(deepgramProvider);
registerTranscriptionProvider(assemblyAiProvider);
