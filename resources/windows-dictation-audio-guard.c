/**
 * Windows Dictation Audio Guard
 *
 * Two independent jobs for Windows dictation, driven by OpenWhispr's main process:
 *
 * 1. Duck: while a dictation records, lower every other app's playback to a
 *    percentage of its current volume (per-app render session volume, the same
 *    control as the Volume Mixer), then put it back. OpenWhispr's own process
 *    tree is never touched, and a volume the user changed meanwhile is left as
 *    the user set it.
 *
 * 2. Call mic gate: forward the real microphone into a virtual audio device that
 *    call apps use as their microphone (VB-CABLE: this helper plays into "CABLE
 *    Input", Discord/Meet/Zoom pick "CABLE Output"). While a dictation records,
 *    the forwarded stream carries silence, so calls never hear the dictation
 *    while OpenWhispr keeps recording the real microphone.
 *    Why a virtual device: Windows has no per-app capture mute. A capture
 *    session's ISimpleAudioVolume mute is shared by every client of the endpoint
 *    (muting one app's session silences all of them, OpenWhispr included), and
 *    an exclusive-mode stream preempts the other apps' streams, which do not
 *    recover on their own.
 *
 * Protocol: one command per line on stdin; replies on stdout, one line each.
 *   LIST                           -> DEVICE <capture|render> <isDefault 0|1> <id>\t<name> ... LISTED
 *   DUCK <percent 0-99> <rootPid>  -> DUCKED <sessions>
 *   UNDUCK                         -> UNDUCKED <restored>
 *   FORWARD <sourceId|default> <targetId> -> FORWARDING | ERROR forward-<reason>
 *   UNFORWARD                      -> UNFORWARDED
 *   GATE <1|0>                     -> GATED <1|0>     (1 = calls hear silence)
 *   QUIT
 * Unsolicited lines: READY <version>, FORWARD_LOST <hresult> (the forward stopped,
 * e.g. a device was unplugged; the caller decides whether to start it again).
 * On stdin EOF, QUIT, console close, or exit of the --parent <pid> process, every
 * ducked volume is restored and the forward stops before the helper exits.
 *
 * Compile with: cl /O2 windows-dictation-audio-guard.c /Fe:windows-dictation-audio-guard.exe ole32.lib
 * Or with MinGW: gcc -O2 windows-dictation-audio-guard.c -o windows-dictation-audio-guard.exe -lole32
 */

#define AUDIO_GUARD_VERSION "1.0.0"

#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS /* sscanf on a bounded, NUL-terminated line */
#endif

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- Pure decisions (unit-tested with AUDIO_GUARD_STATE_TEST) ---- */

#define AUDIO_GUARD_VOLUME_EPSILON 0.005f

/* A ducked session is put back only while it still holds the volume this helper
 * set; any other value means the user (or the app) changed it since. */
static bool AudioGuardShouldRestoreVolume(float current, float applied)
{
    float delta = current - applied;
    if (delta < 0) delta = -delta;
    return delta <= AUDIO_GUARD_VOLUME_EPSILON;
}

static float AudioGuardDuckedVolume(float original, int percent)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    return original * ((float)percent / 100.0f);
}

static bool AudioGuardParseDuck(const char *line, int *percent, unsigned long *root)
{
    char extra;
    int p;
    unsigned long r;
    if (sscanf(line, "DUCK %d %lu %c", &p, &r, &extra) != 2) return false;
    if (p < 0 || p > 99 || r == 0) return false;
    *percent = p;
    *root = r;
    return true;
}

static bool AudioGuardParseGate(const char *line, int *gated)
{
    char extra;
    int g;
    if (sscanf(line, "GATE %d %c", &g, &extra) != 1) return false;
    if (g != 0 && g != 1) return false;
    *gated = g;
    return true;
}

/* Splits "FORWARD <source> <target>" into two whitespace-free tokens. */
static bool AudioGuardParseForward(const char *line, char *source, char *target, size_t capacity)
{
    char fmt[48];
    char extra;
    if (capacity < 2 || capacity > 4096) return false;
    snprintf(fmt, sizeof(fmt), "FORWARD %%%us %%%us %%c", (unsigned)(capacity - 1), (unsigned)(capacity - 1));
    return sscanf(line, fmt, source, target, &extra) == 2;
}

/* Frames of a captured packet to queue on the virtual device. The queue is kept
 * under maxQueued frames so the call path never builds latency: when the two
 * device clocks drift apart, the excess is dropped rather than delayed. */
static unsigned AudioGuardFramesToQueue(unsigned captured, unsigned padding, unsigned bufferFrames,
    unsigned maxQueued)
{
    unsigned limit = maxQueued < bufferFrames ? maxQueued : bufferFrames;
    if (padding >= limit) return 0;
    unsigned room = limit - padding;
    return captured < room ? captured : room;
}

#ifdef AUDIO_GUARD_STATE_TEST

#include <assert.h>

int main(void)
{
    int p, g;
    unsigned long r;
    char a[64], b[64];
    assert(AudioGuardParseDuck("DUCK 10 4242", &p, &r) && p == 10 && r == 4242);
    assert(AudioGuardParseDuck("DUCK 0 7\n", &p, &r) && p == 0);
    assert(!AudioGuardParseDuck("DUCK 100 7", &p, &r));
    assert(!AudioGuardParseDuck("DUCK -1 7", &p, &r));
    assert(!AudioGuardParseDuck("DUCK 10 0", &p, &r));
    assert(!AudioGuardParseDuck("DUCK 10 7 x", &p, &r));
    assert(AudioGuardParseGate("GATE 1", &g) && g == 1);
    assert(AudioGuardParseGate("GATE 0\n", &g) && g == 0);
    assert(!AudioGuardParseGate("GATE 2", &g));
    assert(!AudioGuardParseGate("GATE", &g));
    assert(AudioGuardParseForward("FORWARD default {0.0.0.00000000}.{abc}\n", a, b, sizeof(a)) &&
        strcmp(a, "default") == 0 && strcmp(b, "{0.0.0.00000000}.{abc}") == 0);
    assert(!AudioGuardParseForward("FORWARD default", a, b, sizeof(a)));
    assert(!AudioGuardParseForward("FORWARD a b c", a, b, sizeof(a)));
    assert(AudioGuardDuckedVolume(0.8f, 10) > 0.079f && AudioGuardDuckedVolume(0.8f, 10) < 0.081f);
    assert(AudioGuardDuckedVolume(0.5f, 150) == 0.5f);
    assert(AudioGuardShouldRestoreVolume(0.08f, 0.0801f));
    assert(!AudioGuardShouldRestoreVolume(0.5f, 0.08f));
    assert(AudioGuardFramesToQueue(480, 0, 4800, 1920) == 480);
    assert(AudioGuardFramesToQueue(480, 1700, 4800, 1920) == 220);
    assert(AudioGuardFramesToQueue(480, 1920, 4800, 1920) == 0);
    assert(AudioGuardFramesToQueue(480, 100, 400, 1920) == 300);
    puts("audio guard state tests passed");
    return 0;
}

#else

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define CINTERFACE
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <tlhelp32.h>

/* The SDK exposes these interface IDs via C++ __uuidof, so C builds define
 * them here rather than depending on compiler-specific UUID extensions. */
DEFINE_GUID(CLSID_MMDeviceEnumerator,
    0xbcde0395, 0xe52f, 0x467c, 0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e);
DEFINE_GUID(IID_IMMDeviceEnumerator,
    0xa95664d2, 0x9614, 0x4f35, 0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6);
DEFINE_GUID(IID_IAudioSessionManager2,
    0x77aa99a0, 0x1bd6, 0x484f, 0x8b, 0xc7, 0x2c, 0x65, 0x4c, 0x9a, 0x9b, 0x6f);
DEFINE_GUID(IID_IAudioSessionControl2,
    0xbfb7ff88, 0x7239, 0x4fc9, 0x8f, 0xa2, 0x07, 0xc9, 0x50, 0xbe, 0x9c, 0x6d);
DEFINE_GUID(IID_ISimpleAudioVolume,
    0x87ce5498, 0x68d6, 0x44e5, 0x92, 0x15, 0x6d, 0xa4, 0x7e, 0xf8, 0x83, 0xd8);
DEFINE_GUID(IID_IAudioClient,
    0x1cb9ad4c, 0xdbfa, 0x4c32, 0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2);
DEFINE_GUID(IID_IAudioCaptureClient,
    0xc8adbd64, 0xe71e, 0x48a0, 0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17);
DEFINE_GUID(IID_IAudioRenderClient,
    0xf294acfc, 0x3146, 0x4483, 0xa7, 0xbf, 0xad, 0xdc, 0xa7, 0xc2, 0x60, 0xe2);

/* Marks this helper's own volume changes in session notifications. */
DEFINE_GUID(AUDIO_GUARD_EVENT_CONTEXT,
    0x5f1c2a7e, 0x3b4d, 0x4e8f, 0x9a, 0x61, 0x2d, 0x7c, 0x0e, 0x4b, 0x93, 0x15);

static const PROPERTYKEY AUDIO_GUARD_PKEY_FRIENDLY_NAME = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

#define REFTIMES_PER_MS 10000
#define MAX_DUCKED 256
#define MAX_TREE 512
#define MAX_ID 512

static CRITICAL_SECTION g_outputLock;
static CRITICAL_SECTION g_stateLock;

static void Reply(const char *fmt, ...)
{
    va_list args;
    EnterCriticalSection(&g_outputLock);
    va_start(args, fmt);
    vfprintf(stdout, fmt, args);
    va_end(args);
    fputc('\n', stdout);
    fflush(stdout);
    LeaveCriticalSection(&g_outputLock);
}

static IMMDeviceEnumerator *CreateEnumerator(void)
{
    IMMDeviceEnumerator *enumerator = NULL;
    if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator,
            (void **)&enumerator))) {
        return NULL;
    }
    return enumerator;
}

static void WideToUtf8(const wchar_t *wide, char *out, int capacity)
{
    out[0] = '\0';
    if (wide) WideCharToMultiByte(CP_UTF8, 0, wide, -1, out, capacity, NULL, NULL);
}

/* ---- LIST ---- */

static void ListFlow(IMMDeviceEnumerator *enumerator, EDataFlow flow, const char *label)
{
    IMMDeviceCollection *devices = NULL;
    IMMDevice *defaultDevice = NULL;
    LPWSTR defaultId = NULL;
    if (SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, flow, eConsole, &defaultDevice))) {
        IMMDevice_GetId(defaultDevice, &defaultId);
        IMMDevice_Release(defaultDevice);
    }
    if (SUCCEEDED(IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, flow, DEVICE_STATE_ACTIVE, &devices))) {
        UINT count = 0;
        IMMDeviceCollection_GetCount(devices, &count);
        for (UINT i = 0; i < count; i++) {
            IMMDevice *device = NULL;
            LPWSTR id = NULL;
            IPropertyStore *props = NULL;
            char idUtf8[MAX_ID] = "", nameUtf8[512] = "";
            if (FAILED(IMMDeviceCollection_Item(devices, i, &device))) continue;
            if (SUCCEEDED(IMMDevice_GetId(device, &id))) WideToUtf8(id, idUtf8, sizeof(idUtf8));
            if (SUCCEEDED(IMMDevice_OpenPropertyStore(device, STGM_READ, &props))) {
                PROPVARIANT value;
                PropVariantInit(&value);
                if (SUCCEEDED(IPropertyStore_GetValue(props, &AUDIO_GUARD_PKEY_FRIENDLY_NAME, &value)) &&
                    value.vt == VT_LPWSTR) {
                    WideToUtf8(value.pwszVal, nameUtf8, sizeof(nameUtf8));
                }
                PropVariantClear(&value);
                IPropertyStore_Release(props);
            }
            bool isDefault = id && defaultId && wcscmp(id, defaultId) == 0;
            if (idUtf8[0]) Reply("DEVICE %s %d %s\t%s", label, isDefault ? 1 : 0, idUtf8, nameUtf8);
            if (id) CoTaskMemFree(id);
            IMMDevice_Release(device);
        }
        IMMDeviceCollection_Release(devices);
    }
    if (defaultId) CoTaskMemFree(defaultId);
}

static void ListDevices(void)
{
    IMMDeviceEnumerator *enumerator = CreateEnumerator();
    if (!enumerator) {
        Reply("ERROR enumerator");
        return;
    }
    ListFlow(enumerator, eCapture, "capture");
    ListFlow(enumerator, eRender, "render");
    IMMDeviceEnumerator_Release(enumerator);
    Reply("LISTED");
}

/* ---- DUCK ---- */

typedef struct DuckedSession {
    ISimpleAudioVolume *volume;
    float original;
    float applied;
} DuckedSession;

static DuckedSession g_ducked[MAX_DUCKED];
static size_t g_duckedCount = 0;

/* rootPid and every descendant, so Electron's audio utility process and its
 * renderers are spared along with the main process. */
static size_t CollectProcessTree(DWORD rootPid, DWORD *tree, size_t capacity)
{
    size_t count = 0;
    tree[count++] = rootPid;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return count;

    bool grew = true;
    while (grew && count < capacity) {
        grew = false;
        PROCESSENTRY32 entry;
        entry.dwSize = sizeof(entry);
        if (!Process32First(snapshot, &entry)) break;
        do {
            bool parentInTree = false, alreadyIn = false;
            for (size_t i = 0; i < count; i++) {
                if (tree[i] == entry.th32ParentProcessID) parentInTree = true;
                if (tree[i] == entry.th32ProcessID) alreadyIn = true;
            }
            if (parentInTree && !alreadyIn && entry.th32ProcessID != 0 && count < capacity) {
                tree[count++] = entry.th32ProcessID;
                grew = true;
            }
        } while (Process32Next(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return count;
}

static bool PidInTree(DWORD pid, const DWORD *tree, size_t count)
{
    for (size_t i = 0; i < count; i++) {
        if (tree[i] == pid) return true;
    }
    return false;
}

/* Caller holds g_stateLock. */
static size_t UnduckLocked(void)
{
    size_t restored = 0;
    for (size_t i = 0; i < g_duckedCount; i++) {
        DuckedSession *entry = &g_ducked[i];
        float current = 0.0f;
        if (SUCCEEDED(ISimpleAudioVolume_GetMasterVolume(entry->volume, &current)) &&
            AudioGuardShouldRestoreVolume(current, entry->applied) &&
            SUCCEEDED(ISimpleAudioVolume_SetMasterVolume(entry->volume, entry->original,
                &AUDIO_GUARD_EVENT_CONTEXT))) {
            restored++;
        }
        ISimpleAudioVolume_Release(entry->volume);
    }
    g_duckedCount = 0;
    return restored;
}

/* Caller holds g_stateLock. Lowers every foreign render session on every
 * active output device; returns how many it lowered. */
static size_t DuckLocked(int percent, DWORD rootPid)
{
    IMMDeviceEnumerator *enumerator = CreateEnumerator();
    IMMDeviceCollection *devices = NULL;
    if (!enumerator) return 0;
    if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(enumerator, eRender, DEVICE_STATE_ACTIVE, &devices))) {
        IMMDeviceEnumerator_Release(enumerator);
        return 0;
    }

    DWORD tree[MAX_TREE];
    size_t treeCount = CollectProcessTree(rootPid, tree, MAX_TREE);
    UINT deviceCount = 0;
    IMMDeviceCollection_GetCount(devices, &deviceCount);

    for (UINT d = 0; d < deviceCount; d++) {
        IMMDevice *device = NULL;
        IAudioSessionManager2 *manager = NULL;
        IAudioSessionEnumerator *sessions = NULL;
        if (FAILED(IMMDeviceCollection_Item(devices, d, &device))) continue;
        if (SUCCEEDED(IMMDevice_Activate(device, &IID_IAudioSessionManager2, CLSCTX_ALL, NULL,
                (void **)&manager)) &&
            SUCCEEDED(IAudioSessionManager2_GetSessionEnumerator(manager, &sessions))) {
            int sessionCount = 0;
            IAudioSessionEnumerator_GetCount(sessions, &sessionCount);
            for (int s = 0; s < sessionCount && g_duckedCount < MAX_DUCKED; s++) {
                IAudioSessionControl *control = NULL;
                IAudioSessionControl2 *control2 = NULL;
                ISimpleAudioVolume *volume = NULL;
                DWORD pid = 0;
                float original = 1.0f;
                if (FAILED(IAudioSessionEnumerator_GetSession(sessions, s, &control))) continue;
                if (SUCCEEDED(IAudioSessionControl_QueryInterface(control, &IID_IAudioSessionControl2,
                        (void **)&control2)) &&
                    IAudioSessionControl2_GetProcessId(control2, &pid) == S_OK && pid != 0 &&
                    !PidInTree(pid, tree, treeCount) &&
                    SUCCEEDED(IAudioSessionControl_QueryInterface(control, &IID_ISimpleAudioVolume,
                        (void **)&volume)) &&
                    SUCCEEDED(ISimpleAudioVolume_GetMasterVolume(volume, &original))) {
                    float target = AudioGuardDuckedVolume(original, percent);
                    if (target < original &&
                        SUCCEEDED(ISimpleAudioVolume_SetMasterVolume(volume, target, &AUDIO_GUARD_EVENT_CONTEXT))) {
                        g_ducked[g_duckedCount].volume = volume; /* kept until UNDUCK */
                        g_ducked[g_duckedCount].original = original;
                        g_ducked[g_duckedCount].applied = target;
                        g_duckedCount++;
                        volume = NULL;
                    }
                }
                if (volume) ISimpleAudioVolume_Release(volume);
                if (control2) IAudioSessionControl2_Release(control2);
                IAudioSessionControl_Release(control);
            }
        }
        if (sessions) IAudioSessionEnumerator_Release(sessions);
        if (manager) IAudioSessionManager2_Release(manager);
        IMMDevice_Release(device);
    }
    IMMDeviceCollection_Release(devices);
    IMMDeviceEnumerator_Release(enumerator);
    return g_duckedCount;
}

/* ---- FORWARD + GATE ---- */

typedef struct ForwardConfig {
    wchar_t source[MAX_ID]; /* empty = default console capture device */
    wchar_t target[MAX_ID];
} ForwardConfig;

static HANDLE g_forwardThread = NULL;
static HANDLE g_forwardStop = NULL;
static HANDLE g_forwardStarted = NULL;
static volatile LONG g_forwardStartResult = 0;
static volatile LONG g_gated = 0;
static ForwardConfig g_forwardConfig;

static HRESULT OpenDevice(IMMDeviceEnumerator *enumerator, const wchar_t *id, EDataFlow flow, IMMDevice **device)
{
    if (!id[0]) return IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, flow, eConsole, device);
    return IMMDeviceEnumerator_GetDevice(enumerator, id, device);
}

static DWORD WINAPI ForwardThread(LPVOID param)
{
    (void)param;
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    IMMDeviceEnumerator *enumerator = NULL;
    IMMDevice *source = NULL, *target = NULL;
    IAudioClient *captureClient = NULL, *renderClient = NULL;
    IAudioCaptureClient *capture = NULL;
    IAudioRenderClient *render = NULL;
    WAVEFORMATEX *format = NULL;
    HANDLE captureEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
    bool started = false;
    UINT32 renderFrames = 0;

    if (SUCCEEDED(hr)) hr = (enumerator = CreateEnumerator()) ? S_OK : E_FAIL;
    if (SUCCEEDED(hr)) hr = OpenDevice(enumerator, g_forwardConfig.source, eCapture, &source);
    if (SUCCEEDED(hr)) hr = OpenDevice(enumerator, g_forwardConfig.target, eRender, &target);
    if (SUCCEEDED(hr)) hr = IMMDevice_Activate(source, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&captureClient);
    if (SUCCEEDED(hr)) hr = IAudioClient_GetMixFormat(captureClient, &format);
    if (SUCCEEDED(hr)) {
        hr = IAudioClient_Initialize(captureClient, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            20 * REFTIMES_PER_MS, 0, format, NULL);
    }
    if (SUCCEEDED(hr)) hr = IAudioClient_SetEventHandle(captureClient, captureEvent);
    if (SUCCEEDED(hr)) hr = IAudioClient_GetService(captureClient, &IID_IAudioCaptureClient, (void **)&capture);
    /* The virtual device converts from the microphone's format itself. */
    if (SUCCEEDED(hr)) hr = IMMDevice_Activate(target, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&renderClient);
    if (SUCCEEDED(hr)) {
        hr = IAudioClient_Initialize(renderClient, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            100 * REFTIMES_PER_MS, 0, format, NULL);
    }
    if (SUCCEEDED(hr)) hr = IAudioClient_GetBufferSize(renderClient, &renderFrames);
    if (SUCCEEDED(hr)) hr = IAudioClient_GetService(renderClient, &IID_IAudioRenderClient, (void **)&render);
    if (SUCCEEDED(hr)) {
        /* 10 ms of silence up front so the first packets never underrun. */
        UINT32 prefill = format->nSamplesPerSec / 100;
        BYTE *data = NULL;
        if (SUCCEEDED(IAudioRenderClient_GetBuffer(render, prefill, &data))) {
            IAudioRenderClient_ReleaseBuffer(render, prefill, AUDCLNT_BUFFERFLAGS_SILENT);
        }
        hr = IAudioClient_Start(renderClient);
    }
    if (SUCCEEDED(hr)) hr = IAudioClient_Start(captureClient);

    started = SUCCEEDED(hr);
    InterlockedExchange(&g_forwardStartResult, (LONG)hr);
    SetEvent(g_forwardStarted);

    /* Queue at most 40 ms on the virtual device: calls get the mic with the
     * least delay the shared engine allows. */
    unsigned maxQueued = started ? format->nSamplesPerSec / 25 : 0;
    HANDLE waits[2] = {g_forwardStop, captureEvent};
    while (started) {
        DWORD wait = WaitForMultipleObjects(2, waits, FALSE, 200);
        if (wait == WAIT_OBJECT_0) break;
        UINT32 packet = 0;
        hr = IAudioCaptureClient_GetNextPacketSize(capture, &packet);
        while (SUCCEEDED(hr) && packet > 0) {
            BYTE *in = NULL, *out = NULL;
            UINT32 frames = 0, padding = 0;
            DWORD flags = 0;
            hr = IAudioCaptureClient_GetBuffer(capture, &in, &frames, &flags, NULL, NULL);
            if (FAILED(hr)) break;
            hr = IAudioClient_GetCurrentPadding(renderClient, &padding);
            unsigned toQueue = SUCCEEDED(hr)
                ? AudioGuardFramesToQueue(frames, padding, renderFrames, maxQueued)
                : 0;
            if (toQueue > 0 && SUCCEEDED(IAudioRenderClient_GetBuffer(render, toQueue, &out))) {
                bool silent = InterlockedCompareExchange(&g_gated, 0, 0) != 0 ||
                    (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                if (!silent) memcpy(out, in, (size_t)toQueue * format->nBlockAlign);
                IAudioRenderClient_ReleaseBuffer(render, toQueue, silent ? AUDCLNT_BUFFERFLAGS_SILENT : 0);
            }
            IAudioCaptureClient_ReleaseBuffer(capture, frames);
            if (FAILED(hr)) break;
            hr = IAudioCaptureClient_GetNextPacketSize(capture, &packet);
        }
        if (FAILED(hr)) {
            Reply("FORWARD_LOST 0x%08lx", (unsigned long)hr);
            break;
        }
    }

    if (captureClient) IAudioClient_Stop(captureClient);
    if (renderClient) IAudioClient_Stop(renderClient);
    if (render) IAudioRenderClient_Release(render);
    if (capture) IAudioCaptureClient_Release(capture);
    if (renderClient) IAudioClient_Release(renderClient);
    if (captureClient) IAudioClient_Release(captureClient);
    if (format) CoTaskMemFree(format);
    if (target) IMMDevice_Release(target);
    if (source) IMMDevice_Release(source);
    if (enumerator) IMMDeviceEnumerator_Release(enumerator);
    CloseHandle(captureEvent);
    CoUninitialize();
    return 0;
}

/* Caller holds g_stateLock. */
static void StopForwardLocked(void)
{
    if (!g_forwardThread) return;
    SetEvent(g_forwardStop);
    WaitForSingleObject(g_forwardThread, 3000);
    CloseHandle(g_forwardThread);
    g_forwardThread = NULL;
}

/* Caller holds g_stateLock. */
static HRESULT StartForwardLocked(const char *source, const char *target)
{
    StopForwardLocked();
    memset(&g_forwardConfig, 0, sizeof(g_forwardConfig));
    if (strcmp(source, "default") != 0) {
        MultiByteToWideChar(CP_UTF8, 0, source, -1, g_forwardConfig.source, MAX_ID);
    }
    MultiByteToWideChar(CP_UTF8, 0, target, -1, g_forwardConfig.target, MAX_ID);
    if (!g_forwardConfig.target[0]) return E_INVALIDARG;

    ResetEvent(g_forwardStop);
    ResetEvent(g_forwardStarted);
    g_forwardThread = CreateThread(NULL, 0, ForwardThread, NULL, 0, NULL);
    if (!g_forwardThread) return E_FAIL;
    if (WaitForSingleObject(g_forwardStarted, 5000) != WAIT_OBJECT_0) {
        StopForwardLocked();
        return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    }
    HRESULT hr = (HRESULT)InterlockedCompareExchange(&g_forwardStartResult, 0, 0);
    if (FAILED(hr)) StopForwardLocked();
    return hr;
}

/* ---- Lifetime ---- */

static void ShutdownAndExit(int code)
{
    EnterCriticalSection(&g_stateLock);
    UnduckLocked();
    StopForwardLocked();
    LeaveCriticalSection(&g_stateLock);
    ExitProcess(code);
}

static DWORD WINAPI ParentWatch(LPVOID param)
{
    WaitForSingleObject((HANDLE)param, INFINITE);
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    ShutdownAndExit(0);
    return 0;
}

static BOOL WINAPI ConsoleHandler(DWORD signal)
{
    (void)signal;
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    ShutdownAndExit(0);
    return TRUE;
}

int main(int argc, char **argv)
{
    InitializeCriticalSection(&g_outputLock);
    InitializeCriticalSection(&g_stateLock);
    g_forwardStop = CreateEventW(NULL, TRUE, FALSE, NULL);
    g_forwardStarted = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) {
        Reply("ERROR com");
        return 1;
    }

    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], "--parent") == 0) {
            HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)strtoul(argv[i + 1], NULL, 10));
            if (parent) CreateThread(NULL, 0, ParentWatch, parent, 0, NULL);
        }
    }
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);
    Reply("READY " AUDIO_GUARD_VERSION);

    char line[2 * MAX_ID + 64];
    while (fgets(line, sizeof(line), stdin)) {
        int percent, gated;
        unsigned long root;
        char source[MAX_ID], target[MAX_ID];

        EnterCriticalSection(&g_stateLock);
        if (strncmp(line, "LIST", 4) == 0) {
            ListDevices();
        } else if (strncmp(line, "UNDUCK", 6) == 0) {
            Reply("UNDUCKED %lu", (unsigned long)UnduckLocked());
        } else if (strncmp(line, "DUCK", 4) == 0) {
            if (AudioGuardParseDuck(line, &percent, &root)) {
                UnduckLocked(); /* a repeated DUCK starts from the user's volumes */
                Reply("DUCKED %lu", (unsigned long)DuckLocked(percent, (DWORD)root));
            } else {
                Reply("ERROR bad-duck");
            }
        } else if (strncmp(line, "UNFORWARD", 9) == 0) {
            StopForwardLocked();
            Reply("UNFORWARDED");
        } else if (strncmp(line, "FORWARD", 7) == 0) {
            if (AudioGuardParseForward(line, source, target, sizeof(source))) {
                HRESULT hr = StartForwardLocked(source, target);
                if (SUCCEEDED(hr)) Reply("FORWARDING");
                else Reply("ERROR forward-0x%08lx", (unsigned long)hr);
            } else {
                Reply("ERROR bad-forward");
            }
        } else if (strncmp(line, "GATE", 4) == 0) {
            if (AudioGuardParseGate(line, &gated)) {
                InterlockedExchange(&g_gated, gated);
                Reply("GATED %d", gated);
            } else {
                Reply("ERROR bad-gate");
            }
        } else if (strncmp(line, "QUIT", 4) == 0) {
            LeaveCriticalSection(&g_stateLock);
            break;
        } else {
            Reply("ERROR unknown-command");
        }
        LeaveCriticalSection(&g_stateLock);
    }
    ShutdownAndExit(0);
    return 0;
}

#endif
