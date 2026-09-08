## Phase 3 review addendum

- Wake-word commands now open the assistant panel. The wake-word address is stripped before the command is shown there; highlighted selections continue to use the in-place dictation-agent edit path.
- `shouldUseStreaming` no longer lets the managed `batch` bootstrap downgrade BYOK realtime models.
- The pill window is content-protected while the assistant panel is open, so the panel never appears in screen shares.
- Legacy `CHAT_AGENT_KEY` values are adopted as `VOICE_AGENT_KEY` when `VOICE_AGENT_KEY` is unset, preserving existing voice-assistant hotkey configuration.
- BYOK Anthropic chat requests opt in to direct browser access with the `anthropic-dangerous-direct-browser-access: true` header; the dictation path continues through IPC.
