.PHONY: dev kill

dev:
	NODE_USE_SYSTEM_CA=1 npm run dev

kill:
	@pkill -TERM -f '^node $(CURDIR)/node_modules/.bin/(concurrently|vite|cross-env)( |$$)' 2>/dev/null || true
	@pkill -TERM -f '^$(CURDIR)/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron $(CURDIR)( |$$)' 2>/dev/null || true
	@pkill -TERM -f '^$(CURDIR)/resources/bin/(qdrant|sherpa-onnx|macos-).*( |$$)' 2>/dev/null || true
	@echo "OpenWhispr stopped"
