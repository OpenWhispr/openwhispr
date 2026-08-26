/**
 * Windows System Audio Helper
 *
 * Captures system audio for meeting transcription via WASAPI.
 *
 * Two capture modes:
 *   endpoint-loopback (default):
 *     Captures from the default render endpoint after mixing. Hears all
 *     applications including those using WASAPI exclusive mode (MS Teams,
 *     Zoom, etc.). Captures from the default output device only.
 *
 *   process-loopback (Windows 10 2004+):
 *     Captures via VAD\Process_Loopback in EXCLUDE mode against
 *     OpenWhispr's own process tree. Hears every application on every
 *     render endpoint, but cannot capture exclusive-mode streams.
 *
 * Commands:
 *   windows-system-audio-helper.exe probe
 *     Prints a JSON capability object to stdout and exits.
 *   windows-system-audio-helper.exe start [--mode endpoint-loopback|process-loopback]
 *                                          [--exclude-pid N] [--sample-rate N]
 *     Streams raw PCM (mono, 16-bit signed little-endian, --sample-rate Hz,
 *     default 24000) to stdout. Emits line-delimited JSON events to stderr:
 *       {"type":"start"} once capture is running,
 *       {"type":"warning","code":...,"message":...} for recoverable issues,
 *       {"type":"error","code":...,"message":...} before exiting with code 2.
 *     Exits when stdin closes (parent death), on Ctrl+C/SIGTERM, or on a
 *     fatal capture error. Injects silence while no application renders
 *     audio so the output timeline stays continuous.
 *
 * Compile with: cl /O2 windows-system-audio-helper.c /Fe:windows-system-audio-helper.exe ole32.lib mmdevapi.lib
 * Or with MinGW: gcc -O2 windows-system-audio-helper.c -o windows-system-audio-helper.exe -lole32 -lmmdevapi
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define CINTERFACE

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <fcntl.h>
#include <io.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The SDK declares these WASAPI IIDs via MIDL_INTERFACE for C++ __uuidof
 * only — no import library defines them and <initguid.h> skips them in C —
 * so they must be defined in-source to link.  MinGW headers already provide
 * these GUIDs, so skip on MinGW. */
#ifndef __MINGW32__
DEFINE_GUID(IID_IAudioClient,
    0x1cb9ad4c, 0xdbfa, 0x4c32, 0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2);
DEFINE_GUID(IID_IAudioCaptureClient,
    0xc8adbd64, 0xe71e, 0x48a0, 0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17);
DEFINE_GUID(IID_IActivateAudioInterfaceCompletionHandler,
    0x41d949ab, 0x9862, 0x444a, 0x80, 0xf6, 0xc2, 0x61, 0x33, 0x4d, 0xa5, 0xeb);
#endif

#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define HAVE_ACTIVATION_PARAMS_HEADER 1
#endif
#endif

#ifndef HAVE_ACTIVATION_PARAMS_HEADER
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

typedef enum {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef enum {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    } DUMMYUNIONNAME;
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

DEFINE_GUID(HELPER_IID_IAgileObject,
    0x94ea2b94, 0xe9cc, 0x49e0, 0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90);

#define DEFAULT_SAMPLE_RATE 24000
#define CAPTURE_CHANNELS 2
#define BYTES_PER_SAMPLE 2
#define ACTIVATION_TIMEOUT_MS 4000
#define CAPTURE_WAIT_TIMEOUT_MS 100
/* Fill silence once the emitted timeline lags the wall clock by this much. */
#define SILENCE_GAP_THRESHOLD_MS 100
/* Beyond this the clock jumped (system sleep/resume); rebase instead of
 * flooding the pipe with hours of silence. */
#define SILENCE_GAP_MAX_MS 5000
#define SILENCE_FILL_CHUNK_FRAMES 2400
#define BUFFER_DURATION_HNS 200000 /* 20 ms, matches the Microsoft sample */

static volatile LONG g_running = TRUE;

/* ========================================================================
 * JSON events on stderr (all message content is static or numeric, so no
 * string escaping is required)
 * ======================================================================== */

static void emit_event(const char *type, const char *code, const char *format, ...)
{
    fprintf(stderr, "{\"type\":\"%s\"", type);
    if (code) {
        fprintf(stderr, ",\"code\":\"%s\"", code);
    }
    if (format) {
        va_list args;
        va_start(args, format);
        fputs(",\"message\":\"", stderr);
        vfprintf(stderr, format, args);
        fputs("\"", stderr);
        va_end(args);
    }
    fputs("}\n", stderr);
    fflush(stderr);
}

static void emit_probe_result(BOOL ok, const char *error, HRESULT hr,
                               BOOL supportsEndpoint, BOOL supportsProcess)
{
    if (ok) {
        printf("{\"ok\":true,\"supportsSystemAudio\":true,\"supportsNativeCapture\":true,"
               "\"supportsEndpointLoopback\":%s,\"supportsProcessLoopback\":%s,"
               "\"source\":\"wasapi-endpoint-loopback\"}\n",
               supportsEndpoint ? "true" : "false",
               supportsProcess ? "true" : "false");
    } else {
        printf("{\"ok\":false,\"supportsSystemAudio\":false,\"supportsNativeCapture\":false,"
               "\"supportsEndpointLoopback\":false,\"supportsProcessLoopback\":false,"
               "\"source\":\"wasapi-endpoint-loopback\",\"error\":\"%s (hr=0x%08lx)\"}\n",
               error, (unsigned long)hr);
    }
    fflush(stdout);
}

/* ========================================================================
 * IActivateAudioInterfaceCompletionHandler implementation
 * ======================================================================== */

/* Heap-allocated and refcounted: ActivateAudioInterfaceAsync holds its own
 * reference, so a completion that arrives after our wait timed out still
 * finds a live object and a valid event handle. */
typedef struct {
    IActivateAudioInterfaceCompletionHandlerVtbl *lpVtbl;
    LONG refCount;
    HANDLE completedEvent;
} CompletionHandler;

static HRESULT STDMETHODCALLTYPE CH_QueryInterface(
    IActivateAudioInterfaceCompletionHandler *This, REFIID riid, void **ppvObject)
{
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &HELPER_IID_IAgileObject) ||
        IsEqualIID(riid, &IID_IActivateAudioInterfaceCompletionHandler)) {
        *ppvObject = This;
        This->lpVtbl->AddRef(This);
        return S_OK;
    }
    *ppvObject = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE CH_AddRef(IActivateAudioInterfaceCompletionHandler *This)
{
    CompletionHandler *self = (CompletionHandler *)This;
    return InterlockedIncrement(&self->refCount);
}

static ULONG STDMETHODCALLTYPE CH_Release(IActivateAudioInterfaceCompletionHandler *This)
{
    CompletionHandler *self = (CompletionHandler *)This;
    LONG count = InterlockedDecrement(&self->refCount);
    if (count == 0) {
        CloseHandle(self->completedEvent);
        free(self);
    }
    return count;
}

static HRESULT STDMETHODCALLTYPE CH_ActivateCompleted(
    IActivateAudioInterfaceCompletionHandler *This,
    IActivateAudioInterfaceAsyncOperation *activateOperation)
{
    CompletionHandler *self = (CompletionHandler *)This;
    (void)activateOperation;
    SetEvent(self->completedEvent);
    return S_OK;
}

static IActivateAudioInterfaceCompletionHandlerVtbl g_completionHandlerVtbl = {
    CH_QueryInterface,
    CH_AddRef,
    CH_Release,
    CH_ActivateCompleted,
};

static CompletionHandler *create_completion_handler(void)
{
    CompletionHandler *handler = (CompletionHandler *)calloc(1, sizeof(CompletionHandler));
    if (!handler) {
        return NULL;
    }

    handler->lpVtbl = &g_completionHandlerVtbl;
    handler->refCount = 1;
    handler->completedEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!handler->completedEvent) {
        free(handler);
        return NULL;
    }
    return handler;
}

/* ========================================================================
 * Process-loopback activation
 * ======================================================================== */

static HRESULT activate_process_loopback(
    DWORD excludePid, UINT32 sampleRate, IAudioClient **outClient, const char **outErrorCode)
{
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams;
    PROPVARIANT activateParams;
    CompletionHandler *handler;
    IActivateAudioInterfaceAsyncOperation *asyncOp = NULL;
    IUnknown *audioClientUnknown = NULL;
    IAudioClient *audioClient = NULL;
    WAVEFORMATEX format;
    HRESULT hr;
    HRESULT activateResult = E_FAIL;

    *outClient = NULL;
    *outErrorCode = "activation_failed";

    ZeroMemory(&activationParams, sizeof(activationParams));
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = excludePid;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PropVariantInit(&activateParams);
    activateParams.vt = VT_BLOB;
    activateParams.blob.cbSize = sizeof(activationParams);
    activateParams.blob.pBlobData = (BYTE *)&activationParams;

    handler = create_completion_handler();
    if (!handler) {
        return E_OUTOFMEMORY;
    }

    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IID_IAudioClient,
        &activateParams,
        (IActivateAudioInterfaceCompletionHandler *)handler,
        &asyncOp);

    if (SUCCEEDED(hr)) {
        /* The completion callback can fail to arrive in the field (Chromium
         * bounds this same wait), so never wait unbounded. */
        if (WaitForSingleObject(handler->completedEvent, ACTIVATION_TIMEOUT_MS) != WAIT_OBJECT_0) {
            hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
            *outErrorCode = "activation_timeout";
        } else {
            hr = IActivateAudioInterfaceAsyncOperation_GetActivateResult(
                asyncOp, &activateResult, &audioClientUnknown);
            if (SUCCEEDED(hr)) {
                hr = activateResult;
            }
        }
    }

    if (asyncOp) {
        IActivateAudioInterfaceAsyncOperation_Release(asyncOp);
    }
    CH_Release((IActivateAudioInterfaceCompletionHandler *)handler);

    if (FAILED(hr)) {
        if (audioClientUnknown) {
            IUnknown_Release(audioClientUnknown);
        }
        return hr;
    }

    hr = IUnknown_QueryInterface(audioClientUnknown, &IID_IAudioClient, (void **)&audioClient);
    IUnknown_Release(audioClientUnknown);
    if (FAILED(hr)) {
        return hr;
    }

    /* The process-loopback virtual device has no mix format; we pick the
     * format and AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM makes the engine
     * resample into it. Stereo is the field-proven choice; we downmix. */
    ZeroMemory(&format, sizeof(format));
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = CAPTURE_CHANNELS;
    format.nSamplesPerSec = sampleRate;
    format.wBitsPerSample = BYTES_PER_SAMPLE * 8;
    format.nBlockAlign = CAPTURE_CHANNELS * BYTES_PER_SAMPLE;
    format.nAvgBytesPerSec = sampleRate * format.nBlockAlign;

    hr = IAudioClient_Initialize(
        audioClient,
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        BUFFER_DURATION_HNS,
        0,
        &format,
        NULL);

    if (FAILED(hr)) {
        IAudioClient_Release(audioClient);
        *outErrorCode = "initialize_failed";
        return hr;
    }

    *outClient = audioClient;
    return S_OK;
}

/* ========================================================================
 * Endpoint-loopback activation (captures from default render device)
 * ======================================================================== */

static HRESULT activate_endpoint_loopback(
    UINT32 sampleRate, IAudioClient **outClient, const char **outErrorCode)
{
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDevice *device = NULL;
    IAudioClient *audioClient = NULL;
    WAVEFORMATEX targetFormat;
    HRESULT hr;

    *outClient = NULL;
    *outErrorCode = "activation_failed";

    hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &IID_IMMDeviceEnumerator, (void **)&enumerator);
    if (FAILED(hr)) {
        *outErrorCode = "enumerator_failed";
        return hr;
    }

    hr = IMMDeviceEnumerator_GetDefaultAudioEndpoint(
        enumerator, eRender, eConsole, &device);
    IMMDeviceEnumerator_Release(enumerator);
    if (FAILED(hr)) {
        *outErrorCode = "no_default_device";
        return hr;
    }

    hr = IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&audioClient);
    IMMDevice_Release(device);
    if (FAILED(hr)) {
        *outErrorCode = "client_activate_failed";
        return hr;
    }

    /* Build target format (stereo, target sample rate). AUTOCONVERTPCM
     * resamples from the device's native mix format if needed. */
    ZeroMemory(&targetFormat, sizeof(targetFormat));
    targetFormat.wFormatTag = WAVE_FORMAT_PCM;
    targetFormat.nChannels = CAPTURE_CHANNELS;
    targetFormat.nSamplesPerSec = sampleRate;
    targetFormat.wBitsPerSample = BYTES_PER_SAMPLE * 8;
    targetFormat.nBlockAlign = CAPTURE_CHANNELS * BYTES_PER_SAMPLE;
    targetFormat.nAvgBytesPerSec = sampleRate * targetFormat.nBlockAlign;

    hr = IAudioClient_Initialize(
        audioClient,
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        BUFFER_DURATION_HNS,
        0,
        &targetFormat,
        NULL);

    if (FAILED(hr)) {
        IAudioClient_Release(audioClient);
        *outErrorCode = "initialize_failed";
        return hr;
    }

    *outClient = audioClient;
    return S_OK;
}

/* ========================================================================
 * Capture loop
 * ======================================================================== */

static BOOL write_pcm(const short *samples, size_t sampleCount)
{
    if (sampleCount == 0) {
        return TRUE;
    }
    if (fwrite(samples, sizeof(short), sampleCount, stdout) != sampleCount) {
        return FALSE;
    }
    return TRUE;
}

static BOOL write_silence(size_t frames)
{
    static const short zeros[SILENCE_FILL_CHUNK_FRAMES] = {0};

    while (frames > 0) {
        size_t batch = frames < SILENCE_FILL_CHUNK_FRAMES ? frames : SILENCE_FILL_CHUNK_FRAMES;
        if (!write_pcm(zeros, batch)) {
            return FALSE;
        }
        frames -= batch;
    }
    return TRUE;
}

static int run_capture(DWORD excludePid, UINT32 sampleRate, int mode_endpoint)
{
    IAudioClient *audioClient = NULL;
    IAudioCaptureClient *captureClient = NULL;
    HANDLE samplesReadyEvent = NULL;
    short *monoBuffer = NULL;
    size_t monoBufferFrames = 0;
    LARGE_INTEGER qpcFrequency;
    LARGE_INTEGER captureStart;
    UINT64 emittedFrames = 0;
    const char *errorCode = NULL;
    HRESULT hr;
    int exitCode = 0;

    if (mode_endpoint) {
        hr = activate_endpoint_loopback(sampleRate, &audioClient, &errorCode);
    } else {
        hr = activate_process_loopback(excludePid, sampleRate, &audioClient, &errorCode);
    }
    if (FAILED(hr)) {
        emit_event("error", errorCode, "Loopback activation failed (hr=0x%08lx)",
                   (unsigned long)hr);
        return 2;
    }

    samplesReadyEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!samplesReadyEvent ||
        FAILED(hr = IAudioClient_SetEventHandle(audioClient, samplesReadyEvent))) {
        emit_event("error", "initialize_failed", "Failed to attach capture event (hr=0x%08lx)",
                   (unsigned long)hr);
        IAudioClient_Release(audioClient);
        if (samplesReadyEvent) CloseHandle(samplesReadyEvent);
        return 2;
    }

    hr = IAudioClient_GetService(audioClient, &IID_IAudioCaptureClient, (void **)&captureClient);
    if (FAILED(hr)) {
        emit_event("error", "initialize_failed", "Failed to get capture client (hr=0x%08lx)",
                   (unsigned long)hr);
        IAudioClient_Release(audioClient);
        CloseHandle(samplesReadyEvent);
        return 2;
    }

    hr = IAudioClient_Start(audioClient);
    if (FAILED(hr)) {
        emit_event("error", "start_failed", "Failed to start capture (hr=0x%08lx)",
                   (unsigned long)hr);
        IAudioCaptureClient_Release(captureClient);
        IAudioClient_Release(audioClient);
        CloseHandle(samplesReadyEvent);
        return 2;
    }

    QueryPerformanceFrequency(&qpcFrequency);
    QueryPerformanceCounter(&captureStart);
    emit_event("start", NULL, NULL);

    while (InterlockedCompareExchange(&g_running, TRUE, TRUE)) {
        UINT32 packetFrames = 0;
        LARGE_INTEGER now;
        UINT64 targetFrames;
        UINT64 drainedFrames = 0;

        WaitForSingleObject(samplesReadyEvent, CAPTURE_WAIT_TIMEOUT_MS);

        /* The virtual device does no buffering of its own, so drain every
         * available packet per wakeup. */
        for (;;) {
            BYTE *data = NULL;
            UINT32 frames = 0;
            DWORD flags = 0;

            hr = IAudioCaptureClient_GetNextPacketSize(captureClient, &packetFrames);
            if (FAILED(hr) || packetFrames == 0) {
                break;
            }

            hr = IAudioCaptureClient_GetBuffer(captureClient, &data, &frames, &flags, NULL, NULL);
            if (FAILED(hr)) {
                break;
            }

            if (frames > 0) {
                if (frames > monoBufferFrames) {
                    short *grown = (short *)realloc(monoBuffer, frames * sizeof(short));
                    if (!grown) {
                        IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
                        hr = E_OUTOFMEMORY;
                        break;
                    }
                    monoBuffer = grown;
                    monoBufferFrames = frames;
                }

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    memset(monoBuffer, 0, frames * sizeof(short));
                } else {
                    const short *stereo = (const short *)data;
                    UINT32 i;
                    for (i = 0; i < frames; i++) {
                        monoBuffer[i] = (short)(((int)stereo[i * 2] + (int)stereo[i * 2 + 1]) / 2);
                    }
                }

                if (!write_pcm(monoBuffer, frames)) {
                    IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
                    emit_event("error", "stdout_write_failed",
                               "Failed to write captured audio to stdout");
                    exitCode = 2;
                    goto done;
                }
                emittedFrames += frames;
                drainedFrames += frames;
            }

            hr = IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
            if (FAILED(hr)) {
                break;
            }
        }

        if (FAILED(hr) && hr != AUDCLNT_S_BUFFER_EMPTY) {
            emit_event("error", "wasapi_capture_failed", "Capture read failed (hr=0x%08lx)",
                       (unsigned long)hr);
            exitCode = 2;
            goto done;
        }

        /* Process loopback delivers nothing while no excluded-mix audio is
         * rendering; keep the timeline continuous against the wall clock. */
        QueryPerformanceCounter(&now);
        targetFrames =
            (UINT64)((now.QuadPart - captureStart.QuadPart) * (LONGLONG)sampleRate /
                     qpcFrequency.QuadPart);
        if (targetFrames > emittedFrames) {
            UINT64 gapFrames = targetFrames - emittedFrames;
            if (gapFrames >= (UINT64)sampleRate * SILENCE_GAP_MAX_MS / 1000) {
                /* QPC keeps counting through system sleep; rebase the clock
                 * so resume does not flood the pipe with hours of silence. */
                captureStart.QuadPart =
                    now.QuadPart -
                    (LONGLONG)(emittedFrames * (UINT64)qpcFrequency.QuadPart / sampleRate);
                emit_event("warning", "timeline_rebased",
                           "Capture clock jumped; audio timeline rebased");
            } else if (gapFrames >= (UINT64)sampleRate * SILENCE_GAP_THRESHOLD_MS / 1000) {
                if (drainedFrames > 0) {
                    /* Audio is flowing, so the deficit is drift between the
                     * audio engine clock and QPC, not real silence. Rebase
                     * instead of splicing silence into continuous audio. */
                    captureStart.QuadPart =
                        now.QuadPart -
                        (LONGLONG)(emittedFrames * (UINT64)qpcFrequency.QuadPart / sampleRate);
                } else {
                    if (!write_silence((size_t)gapFrames)) {
                        emit_event("error", "stdout_write_failed",
                                   "Failed to write silence to stdout");
                        exitCode = 2;
                        goto done;
                    }
                    emittedFrames = targetFrames;
                }
            }
        }

        fflush(stdout);
    }

done:
    IAudioClient_Stop(audioClient);
    IAudioCaptureClient_Release(captureClient);
    IAudioClient_Release(audioClient);
    CloseHandle(samplesReadyEvent);
    free(monoBuffer);
    return exitCode;
}

/* ========================================================================
 * Probe
 * ======================================================================== */

static int run_probe(void)
{
    IAudioClient *endpointClient = NULL;
    IAudioClient *processClient = NULL;
    const char *errorCode = NULL;
    HRESULT hrEndpoint, hrProcess;

    hrEndpoint = activate_endpoint_loopback(DEFAULT_SAMPLE_RATE, &endpointClient, &errorCode);
    if (SUCCEEDED(hrEndpoint)) {
        IAudioClient_Release(endpointClient);
    }

    hrProcess = activate_process_loopback(GetCurrentProcessId(), DEFAULT_SAMPLE_RATE,
                                           &processClient, &errorCode);
    if (SUCCEEDED(hrProcess)) {
        IAudioClient_Release(processClient);
    }

    BOOL ok = SUCCEEDED(hrEndpoint) || SUCCEEDED(hrProcess);
    const char *error = SUCCEEDED(hrEndpoint) ? NULL : errorCode;
    emit_probe_result(ok, error, hrEndpoint, SUCCEEDED(hrEndpoint), SUCCEEDED(hrProcess));
    return 0;
}

/* ========================================================================
 * Lifecycle
 * ======================================================================== */

static DWORD WINAPI stdin_monitor_thread(LPVOID param)
{
    HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
    char buffer[64];
    DWORD bytesRead;

    (void)param;
    while (ReadFile(stdinHandle, buffer, sizeof(buffer), &bytesRead, NULL) && bytesRead > 0) {
    }

    InterlockedExchange(&g_running, FALSE);
    return 0;
}

static BOOL WINAPI console_ctrl_handler(DWORD ctrlType)
{
    (void)ctrlType;
    InterlockedExchange(&g_running, FALSE);
    return TRUE;
}

int main(int argc, char *argv[])
{
    const char *command = argc > 1 ? argv[1] : NULL;
    DWORD excludePid = GetCurrentProcessId();
    UINT32 sampleRate = DEFAULT_SAMPLE_RATE;
    int mode_endpoint = 1; /* default to endpoint-loopback */
    HRESULT hr;
    int exitCode;
    int i;

    if (!command || (strcmp(command, "probe") != 0 && strcmp(command, "start") != 0)) {
        fprintf(stderr, "Usage: windows-system-audio-helper <probe|start> "
                        "[--mode endpoint-loopback|process-loopback] "
                        "[--exclude-pid N] [--sample-rate N]\n");
        return 1;
    }

    for (i = 2; i < argc - 1; i++) {
        if (strcmp(argv[i], "--exclude-pid") == 0) {
            excludePid = (DWORD)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--sample-rate") == 0) {
            sampleRate = (UINT32)strtoul(argv[++i], NULL, 10);
        } else if (strcmp(argv[i], "--mode") == 0) {
            i++;
            if (strcmp(argv[i], "process-loopback") == 0) {
                mode_endpoint = 0;
            } else if (strcmp(argv[i], "endpoint-loopback") == 0) {
                mode_endpoint = 1;
            } else {
                fprintf(stderr, "Unknown mode: %s\n", argv[i]);
                return 1;
            }
        }
    }
    if (excludePid == 0 || sampleRate == 0) {
        fprintf(stderr, "Invalid --exclude-pid or --sample-rate value\n");
        return 1;
    }

    hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        if (strcmp(command, "probe") == 0) {
            emit_probe_result(FALSE, "com_init_failed", hr, FALSE, FALSE);
            return 0;
        }
        emit_event("error", "com_init_failed", "COM initialization failed (hr=0x%08lx)",
                   (unsigned long)hr);
        return 2;
    }

    if (strcmp(command, "probe") == 0) {
        exitCode = run_probe();
    } else {
        _setmode(_fileno(stdout), _O_BINARY);
        SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
        HANDLE stdinThread = CreateThread(NULL, 0, stdin_monitor_thread, NULL, 0, NULL);
        if (stdinThread) {
            CloseHandle(stdinThread);
        } else {
            emit_event("warning", "stdin_monitor_failed", "Parent-death detection unavailable");
        }
        exitCode = run_capture(excludePid, sampleRate, mode_endpoint);
    }

    CoUninitialize();
    return exitCode;
}
