# Suggested Commands

## Development
```bash
npm run dev          # Start renderer (Vite) + main (Electron) concurrently; also runs compile:native + downloads qdrant/embedding-model first
npm run dev:renderer # Vite only (port auto-assigned)
npm run start        # Electron without Vite hot-reload
```

## Building
```bash
npm run build:win    # Windows installer (prebuild downloads all binaries)
npm run build:mac    # macOS (universal if no arch flag)
npm run build:linux  # Linux AppImage + deb
npm run pack         # Unsigned unpacked dir build (CSC_IDENTITY_AUTO_DISCOVERY=false)
```

## Testing & Quality
```bash
npm test                  # node --test "test/helpers/*.test.js" (only helpers tested)
npm run typecheck         # tsc --noEmit in src/
npm run quality-check     # format:check + typecheck
npm run lint              # eslint (root + src/)
npm run format            # eslint --fix + prettier --write
npm run i18n:check        # verify all translation keys present in all 9 language files
```

## Asset Downloads (run manually if missing)
```bash
npm run download:whisper-cpp        # current platform only
npm run download:whisper-cpp:all    # all platforms (needed for multi-platform packaging)
npm run download:qdrant             # Qdrant binary
npm run download:embedding-model    # all-MiniLM-L6-v2 ONNX model
npm run download:llama-server       # llama.cpp server
npm run download:sherpa-onnx        # Parakeet/sherpa runtime
```

## Native Compilation
```bash
npm run compile:native   # Compiles all native C/Swift sources (runs automatically in predev/prebuild)
```

## Notes
- `predev` and `prebuild` run `compile:native` + binary downloads automatically
- `GITHUB_TOKEN` env var increases GitHub API rate limits for download scripts
- Use `npm run pack` for quick local testing without code signing
