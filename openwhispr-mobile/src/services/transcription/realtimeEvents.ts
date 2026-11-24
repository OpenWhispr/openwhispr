/**
 * Shared event handling for GPT-4o Realtime transcription. The realtime server
 * emits a stable event schema (delta / completed / speech_started / speech_stopped);
 * RealtimeMeetingWsService parses each message and feeds it through this reducer,
 * which accumulates partials and emits finalized utterances. The exported types
 * are the contract for the whole cloud-meeting path (hook, store, and UI).
 */

export interface RealtimeUtterance {
  itemId: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

export interface RealtimeCallbacks {
  /** Current in-progress caption text for the active utterance (streaming deltas). */
  onPartial?: (text: string, itemId: string) => void;
  /** A finalized utterance (one VAD turn) with its transcript + timing. */
  onUtterance?: (utterance: RealtimeUtterance) => void;
  /** Raw server event stream — used by the spike screen to log every event type. */
  onDebug?: (event: unknown) => void;
  onError?: (error: unknown) => void;
  onClose?: () => void;
  /** A reconnectable drop was detected; the service is re-establishing the leg (mic keeps running). */
  onReconnecting?: () => void;
  /** A replacement leg is live after a drop; capture resumed. */
  onReconnected?: () => void;
  /** The microphone stopped or resumed delivering audio. */
  onCaptureState?: (event: { capturing: boolean; reason: string }) => void;
}

export interface RealtimeSession {
  /** Stops the mic at once, lets the last turn finish (up to 3 s), then closes. */
  stop: () => Promise<void>;
  /** Ordered finalized utterances captured so far. */
  utterances: () => RealtimeUtterance[];
  /** Audio received from the mic, in ms. */
  capturedMs: () => number;
  /** Audio dropped while no socket could take it, in ms. */
  droppedMs: () => number;
}

// Loose shape of the events this reducer reads; each type carries only its subset.
interface RealtimeServerEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
}

export interface RealtimeEventReducer {
  /** Feed one already-parsed server event (from a data channel or a WebSocket). */
  handleEvent: (event: unknown) => void;
  /** Ordered finalized utterances captured so far. */
  utterances: () => RealtimeUtterance[];
  /** Items the server committed and has not yet transcribed. */
  pendingItemCount: () => number;
  /** Forget pending items whose id starts with `prefix` (a leg that closed won't finish them). */
  dropPendingItems: (prefix: string) => void;
}

export function createRealtimeEventReducer(callbacks: RealtimeCallbacks): RealtimeEventReducer {
  // Per-utterance state, keyed by the server's item_id.
  const partials = new Map<string, string>();
  const timing = new Map<string, { startMs: number | null; endMs: number | null }>();
  const finalized: RealtimeUtterance[] = [];
  // Committed turns still being transcribed; a closing leg waits for this to empty.
  const pending = new Set<string>();

  const handleEvent = (raw: unknown): void => {
    callbacks.onDebug?.(raw);
    const event = raw as RealtimeServerEvent;
    const itemId = event.item_id;

    switch (event.type) {
      case 'input_audio_buffer.speech_started': {
        if (!itemId) break;
        const t = timing.get(itemId) ?? { startMs: null, endMs: null };
        if (typeof event.audio_start_ms === 'number') t.startMs = event.audio_start_ms;
        timing.set(itemId, t);
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        if (!itemId) break;
        const t = timing.get(itemId) ?? { startMs: null, endMs: null };
        if (typeof event.audio_end_ms === 'number') t.endMs = event.audio_end_ms;
        timing.set(itemId, t);
        break;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        if (!itemId) break;
        const next = (partials.get(itemId) ?? '') + (event.delta ?? '');
        partials.set(itemId, next);
        callbacks.onPartial?.(next, itemId);
        break;
      }
      case 'input_audio_buffer.committed': {
        if (itemId) pending.add(itemId);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        if (itemId) pending.delete(itemId);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (!itemId) break;
        pending.delete(itemId);
        const t = timing.get(itemId) ?? { startMs: null, endMs: null };
        const utterance: RealtimeUtterance = {
          itemId,
          text: (event.transcript ?? '').trim(),
          startMs: t.startMs,
          endMs: t.endMs,
        };
        partials.delete(itemId);
        timing.delete(itemId);
        if (utterance.text) {
          finalized.push(utterance);
          callbacks.onUtterance?.(utterance);
        }
        break;
      }
      case 'error': {
        callbacks.onError?.(raw);
        break;
      }
      default:
        break;
    }
  };

  return {
    handleEvent,
    utterances: () => [...finalized],
    pendingItemCount: () => pending.size,
    dropPendingItems: (prefix: string): void => {
      for (const itemId of pending) {
        if (itemId.startsWith(prefix)) pending.delete(itemId);
      }
    },
  };
}
