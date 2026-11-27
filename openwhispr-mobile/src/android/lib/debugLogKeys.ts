/**
 * Keys whose string values may be written to the debug log: identifiers, codes and names, never
 * user content. A string under any other key is written as `<n chars>`. Keep this list in step with
 * `DebugLogFormat.KEYS` in the android-dictation module; `debugLog.test.ts` compares the two.
 */
export const DEBUG_LOG_KEYS: ReadonlySet<string> = new Set([
  'accepted', 'action', 'attempt', 'audio_ms', 'background', 'battery', 'buffer', 'bytes', 'cap', 'card',
  'category', 'chars', 'checksum', 'class', 'cleared', 'close_code', 'cloud', 'code', 'cold', 'count',
  'dict_accepted', 'dict_refused', 'dict_sent', 'dict_total', 'dropped', 'duration_ms', 'enabled', 'error',
  'ext', 'failed', 'fatal', 'field', 'found', 'from', 'has_context', 'has_react', 'hash', 'held_ms',
  'in_chars', 'init_state', 'job', 'keyboard', 'kind', 'lang', 'level', 'local', 'method',
  'mime', 'mode', 'model', 'module', 'ms', 'n', 'new_mode', 'new_model', 'new_provider', 'new_tier',
  'offline', 'ok', 'old_mode', 'old_model', 'old_provider', 'old_tier', 'out_chars', 'outcome', 'owner',
  'parked', 'peak', 'percent', 'pkg', 'placement', 'plan', 'provider', 'pulled', 'pushed', 'rate',
  'ready', 'reason', 'recovered', 'req', 'requester', 'result', 'retry', 'revision', 'route', 'run',
  'saved', 'scope', 'seconds', 'segments', 'service', 'signed_in', 'since_ms',
  'size', 'source', 'source_lang', 'state', 'status', 'streaming', 'surface', 'table',
  'target_lang', 'task', 'to', 'tone', 'tool', 'type', 'visible', 'wait_ms', 'why', 
]);
