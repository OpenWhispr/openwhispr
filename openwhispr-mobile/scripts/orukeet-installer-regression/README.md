# Orukeet installer actor regression

On macOS with Swift installed, from `openwhispr-mobile` run:

```sh
python3 scripts/check-orukeet-installer.py --mutation-check --output /tmp/orukeet-installer.json
```

The runner compiles the application's actual `OrukeetInstaller.swift` against a
controlled `OrukeetCoreML` test double. It exercises concurrent availability
checks during OS recovery, install admission, successful and failed cleanup,
caller cancellation, deletion while a cancelled compiler is still unwinding,
concurrent deletion, staging removal, retained backup exclusion and reinstall.
An invalid existing installation is also replaced in a single pass.

The mutation run removes the recovery admission guards. The same tests must then
reject the implementation (or time out while an availability query improperly
waits for recovery). Test fixtures, modules and executables live in one temporary
directory and are removed even when the mutated child times out.

This verifies application actor lifecycle behavior. It does not test actual
Core ML inference, the iPhone runtime or SDK archive verification. The SDK's
separate tests and simulator run cover those behaviors; physical-device memory,
latency and diarization remain app acceptance checks.
