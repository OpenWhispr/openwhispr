"use strict";

/**
 * The post-call pipeline reads its provider/model from NOTE_FORMATTING_PROVIDER
 * and NOTE_FORMATTING_MODEL. When either is empty it logs a warning and silently
 * skips every AI step, which is how a release once shipped generating no titles
 * and no notes. These helpers are pure and take the environment object so that
 * "is it configured" and "auto-configure it" are testable on their own.
 */

/** @param {Record<string, string|undefined>} env */
function isNoteFormattingConfigured(env) {
  return Boolean(env.NOTE_FORMATTING_PROVIDER && env.NOTE_FORMATTING_MODEL);
}

/**
 * Point noteFormatting at the bundled local model when nothing is configured.
 * Never overrides an existing choice — a user's configured remote endpoint wins.
 *
 * @param {object} deps
 * @param {Record<string, string|undefined>} deps.env
 * @param {string} deps.modelId
 * @param {(config: { provider: string, model: string }) => void} [deps.onConfigured]
 * @returns {boolean} true when the environment was changed
 */
function ensureNoteFormattingConfigured({ env, modelId, onConfigured }) {
  if (isNoteFormattingConfigured(env)) return false;
  if (!modelId) return false;

  env.NOTE_FORMATTING_PROVIDER = "local";
  env.NOTE_FORMATTING_MODEL = modelId;
  onConfigured?.({ provider: "local", model: modelId });
  return true;
}

module.exports = { isNoteFormattingConfigured, ensureNoteFormattingConfigured };
