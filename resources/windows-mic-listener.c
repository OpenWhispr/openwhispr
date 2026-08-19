/**
 * Windows Microphone Listener
 *
 * Monitors every active WASAPI capture endpoint and emits process-scoped
 * MIC_START/MIC_STOP transitions. PID exclusions are deliberately handled by
 * the JavaScript caller so its live process set can change without restarting
 * this helper. Sessions that cannot be attributed to a single process are
 * reported under pid 0; on an unrecoverable coverage gap the helper announces
 * "CAPABILITY AGGREGATE" and keeps emitting best-effort transitions instead
 * of exiting.
 *
 * Compile with: cl /O2 windows-mic-listener.c /Fe:windows-mic-listener.exe ole32.lib oleaut32.lib user32.lib
 * Or with MinGW: gcc -O2 windows-mic-listener.c -o windows-mic-listener.exe -lole32 -loleaut32 -luser32
 */

/* Single source of truth for the release tag (windows-mic-listener-v<version>).
 * The publisher workflow tags the release from it and the download script pins
 * to it, so build jobs can never silently pick up a binary built from older
 * source. Bump it on any protocol or behavior change. */
#define MIC_LISTENER_VERSION "1.1.0"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

typedef unsigned long MicPid;
typedef void *(*MicAllocate)(size_t size, void *context);
typedef void (*MicDeallocate)(void *memory, void *context);
typedef void (*MicTransition)(MicPid pid, bool active, void *context);

typedef struct MicPidActivity {
    MicPid pid;
    unsigned long activeSessions;
    struct MicPidActivity *next;
} MicPidActivity;

typedef struct MicPidRegistry {
    MicPidActivity *head;
    MicAllocate allocate;
    MicDeallocate deallocate;
    MicTransition transition;
    void *context;
} MicPidRegistry;

typedef struct MicSessionState {
    MicPid pid;
    bool active;
} MicSessionState;

typedef struct MicCoverageSetup {
    bool endpointNotificationsRegistered;
    bool endpointsReconciled;
    bool lifetimeMonitoringReady;
} MicCoverageSetup;

static bool MicCoverageSetupIsReady(
    const MicCoverageSetup *setup,
    bool coverageHealthy,
    bool running)
{
    return setup->endpointNotificationsRegistered &&
        setup->endpointsReconciled &&
        setup->lifetimeMonitoringReady &&
        coverageHealthy &&
        running;
}

static bool MicProcessIdentityIsReliable(long result, MicPid pid)
{
    return result == 0 && pid > 0;
}

#define MIC_SESSION_STATE_ACTIVE 1u
#define MIC_SESSION_STATE_EXPIRED 2u

typedef bool (*MicApplySessionState)(void *session, bool active);
typedef bool (*MicQueueSessionCleanup)(void *session);

static bool MicHandleSessionStateChange(
    unsigned int state,
    void *session,
    MicApplySessionState applyState,
    MicQueueSessionCleanup queueCleanup)
{
    if (!applyState(session, state == MIC_SESSION_STATE_ACTIVE)) {
        return false;
    }
    return state != MIC_SESSION_STATE_EXPIRED || queueCleanup(session);
}

static void *MicDefaultAllocate(size_t size, void *context)
{
    (void)context;
    return calloc(1, size);
}

static void MicDefaultDeallocate(void *memory, void *context)
{
    (void)context;
    free(memory);
}

static void MicPidRegistryInitialize(
    MicPidRegistry *registry,
    MicAllocate allocate,
    MicDeallocate deallocate,
    MicTransition transition,
    void *context)
{
    registry->head = NULL;
    registry->allocate = allocate ? allocate : MicDefaultAllocate;
    registry->deallocate = deallocate ? deallocate : MicDefaultDeallocate;
    registry->transition = transition;
    registry->context = context;
}

static bool MicPidRegistrySetSession(
    MicPidRegistry *registry,
    MicPid pid,
    bool active)
{
    MicPidActivity *activity = registry->head;
    MicPidActivity *previous = NULL;

    while (activity && activity->pid != pid) {
        previous = activity;
        activity = activity->next;
    }

    if (active) {
        if (!activity) {
            activity = (MicPidActivity *)registry->allocate(
                sizeof(MicPidActivity), registry->context);
            if (!activity) {
                return false;
            }
            activity->pid = pid;
            activity->activeSessions = 0;
            activity->next = registry->head;
            registry->head = activity;
        }

        activity->activeSessions++;
        if (activity->activeSessions == 1 && registry->transition) {
            registry->transition(pid, true, registry->context);
        }
        return true;
    }

    if (!activity || activity->activeSessions == 0) {
        return true;
    }

    activity->activeSessions--;
    if (activity->activeSessions == 0) {
        if (registry->transition) {
            registry->transition(pid, false, registry->context);
        }
        if (previous) {
            previous->next = activity->next;
        } else {
            registry->head = activity->next;
        }
        registry->deallocate(activity, registry->context);
    }
    return true;
}

static bool MicSessionSetActive(
    MicPidRegistry *registry,
    MicSessionState *session,
    bool active)
{
    if (session->active == active) {
        return true;
    }
    if (!MicPidRegistrySetSession(registry, session->pid, active)) {
        return false;
    }
    session->active = active;
    return true;
}

static void MicPidRegistryDestroy(MicPidRegistry *registry)
{
    MicPidActivity *activity = registry->head;
    while (activity) {
        MicPidActivity *next = activity->next;
        registry->deallocate(activity, registry->context);
        activity = next;
    }
    registry->head = NULL;
}

#ifdef MIC_LISTENER_STATE_TEST

#include <assert.h>
#include <string.h>

typedef struct TestContext {
    MicPid pids[8];
    bool states[8];
    size_t transitionCount;
    bool failAllocation;
} TestContext;

static void *TestAllocate(size_t size, void *context)
{
    TestContext *testContext = (TestContext *)context;
    if (testContext->failAllocation) {
        return NULL;
    }
    return calloc(1, size);
}

static void TestDeallocate(void *memory, void *context)
{
    (void)context;
    free(memory);
}

static void RecordTransition(MicPid pid, bool active, void *context)
{
    TestContext *testContext = (TestContext *)context;
    assert(testContext->transitionCount < 8);
    testContext->pids[testContext->transitionCount] = pid;
    testContext->states[testContext->transitionCount] = active;
    testContext->transitionCount++;
}

static void TestStateTransitions(void)
{
    TestContext context;
    MicPidRegistry registry;
    MicSessionState first = { 42, false };
    MicSessionState second = { 42, false };
    MicSessionState systemSession = { 0, false };
    MicSessionState failedSetup = { 77, false };

    memset(&context, 0, sizeof(context));
    MicPidRegistryInitialize(
        &registry, TestAllocate, TestDeallocate, RecordTransition, &context);

    assert(MicSessionSetActive(&registry, &first, true));
    assert(MicSessionSetActive(&registry, &first, true));
    assert(MicSessionSetActive(&registry, &second, true));
    assert(context.transitionCount == 1);
    assert(context.pids[0] == 42 && context.states[0]);

    assert(MicSessionSetActive(&registry, &first, false));
    assert(MicSessionSetActive(&registry, &first, false));
    assert(context.transitionCount == 1);
    assert(MicSessionSetActive(&registry, &second, false));
    assert(context.transitionCount == 2);
    assert(context.pids[1] == 42 && !context.states[1]);

    /* Unattributable sessions (pid 0) refcount and emit like any other pid so
     * the JS caller can treat them as external captures. */
    assert(MicSessionSetActive(&registry, &systemSession, true));
    assert(context.transitionCount == 3);
    assert(context.pids[2] == 0 && context.states[2]);
    assert(MicSessionSetActive(&registry, &systemSession, false));
    assert(context.transitionCount == 4);
    assert(context.pids[3] == 0 && !context.states[3]);

    context.failAllocation = true;
    assert(!MicSessionSetActive(&registry, &failedSetup, true));
    assert(!failedSetup.active);
    assert(context.transitionCount == 4);

    MicPidRegistryDestroy(&registry);
    puts("native state tests passed");
}

static void TestProcessOwnership(void)
{
    assert(MicProcessIdentityIsReliable(0, 42));
    assert(!MicProcessIdentityIsReliable(0, 0));
    assert(!MicProcessIdentityIsReliable(1, 42));
    assert(!MicProcessIdentityIsReliable(0x0889000dL, 42));
    puts("invalid process ownership rejected");
}

typedef struct TestSessionLifecycle {
    unsigned long references;
    unsigned long ownerReferences;
    bool linked;
    bool registered;
    bool controlOwned;
    bool instanceIdOwned;
} TestSessionLifecycle;

static void TestReleaseLinkedSession(TestSessionLifecycle *session)
{
    assert(session->linked);
    assert(session->references > 0);
    session->linked = false;
    session->registered = false;
    session->controlOwned = false;
    session->references--;
}

static void TestReleasePostedCallback(TestSessionLifecycle *session)
{
    assert(session->references == 1);
    session->references--;
    session->instanceIdOwned = false;
    assert(session->ownerReferences == 1);
    session->ownerReferences--;
}

static void TestSessionLifecycleRelease(void)
{
    TestSessionLifecycle session = { 2, 1, true, true, true, true };

    TestReleaseLinkedSession(&session);
    assert(session.references == 1);
    assert(!session.linked);
    assert(!session.registered);
    assert(!session.controlOwned);
    assert(session.instanceIdOwned);
    assert(session.ownerReferences == 1);

    TestReleasePostedCallback(&session);
    assert(session.references == 0);
    assert(!session.instanceIdOwned);
    assert(session.ownerReferences == 0);
    puts("session lifecycle fully released");
}

static void TestCoverageGate(void)
{
    MicCoverageSetup setup = { false, false, false };

    assert(!MicCoverageSetupIsReady(&setup, true, true));
    setup.endpointNotificationsRegistered = true;
    setup.endpointsReconciled = true;
    setup.lifetimeMonitoringReady = true;
    assert(MicCoverageSetupIsReady(&setup, true, true));
    assert(!MicCoverageSetupIsReady(&setup, false, true));
    assert(!MicCoverageSetupIsReady(&setup, true, false));
    puts("unhealthy setup rejected");
}

typedef struct TestStateCallbackContext {
    bool active;
    bool cleanupPosted;
    unsigned long cleanupCount;
} TestStateCallbackContext;

static bool TestApplyState(void *context, bool active)
{
    ((TestStateCallbackContext *)context)->active = active;
    return true;
}

static bool TestQueueCleanup(void *context)
{
    TestStateCallbackContext *state = (TestStateCallbackContext *)context;
    if (!state->cleanupPosted) {
        state->cleanupPosted = true;
        state->cleanupCount++;
    }
    return true;
}

static void TestExpiredStateCallback(void)
{
    TestStateCallbackContext context = { false, false, 0 };

    assert(MicHandleSessionStateChange(
        MIC_SESSION_STATE_ACTIVE, &context, TestApplyState, TestQueueCleanup));
    assert(context.active);
    assert(context.cleanupCount == 0);

    assert(MicHandleSessionStateChange(
        MIC_SESSION_STATE_EXPIRED, &context, TestApplyState, TestQueueCleanup));
    assert(!context.active);
    assert(context.cleanupCount == 1);

    assert(MicHandleSessionStateChange(
        MIC_SESSION_STATE_EXPIRED, &context, TestApplyState, TestQueueCleanup));
    assert(context.cleanupCount == 1);
    puts("expired state queued cleanup once");
}

int main(int argc, char *argv[])
{
    if (argc != 2) return 2;
    if (strcmp(argv[1], "state") == 0) {
        TestStateTransitions();
    } else if (strcmp(argv[1], "ownership") == 0) {
        TestProcessOwnership();
    } else if (strcmp(argv[1], "lifecycle") == 0) {
        TestSessionLifecycleRelease();
    } else if (strcmp(argv[1], "expired-state") == 0) {
        TestExpiredStateCallback();
    } else if (strcmp(argv[1], "coverage") == 0) {
        TestCoverageGate();
    } else {
        return 2;
    }
    return 0;
}

#else

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define CINTERFACE
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif

#ifdef _MSC_VER
#pragma comment(lib, "user32.lib")
#endif

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <string.h>
#include <wchar.h>

/* The SDK exposes these interface IDs via C++ __uuidof, so C builds define
 * them here rather than depending on compiler-specific UUID extensions. */
DEFINE_GUID(CLSID_MMDeviceEnumerator,
    0xbcde0395, 0xe52f, 0x467c, 0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e);
DEFINE_GUID(IID_IMMDeviceEnumerator,
    0xa95664d2, 0x9614, 0x4f35, 0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6);
DEFINE_GUID(IID_IMMNotificationClient,
    0x7991eec9, 0x7e89, 0x4d85, 0x83, 0x90, 0x6c, 0x70, 0x3c, 0xec, 0x60, 0xc0);
DEFINE_GUID(IID_IAudioSessionManager2,
    0x77aa99a0, 0x1bd6, 0x484f, 0x8b, 0xc7, 0x2c, 0x65, 0x4c, 0x9a, 0x9b, 0x6f);
DEFINE_GUID(IID_IAudioSessionControl2,
    0xbfb7ff88, 0x7239, 0x4fc9, 0x8f, 0xa2, 0x07, 0xc9, 0x50, 0xbe, 0x9c, 0x6d);
DEFINE_GUID(IID_IAudioSessionEvents,
    0x24918acc, 0x64b3, 0x37c1, 0x8c, 0xa9, 0x74, 0xa6, 0x6e, 0x99, 0x57, 0xa8);
DEFINE_GUID(IID_IAudioSessionNotification,
    0x641dd20b, 0x4d41, 0x49cc, 0xab, 0xa3, 0x17, 0x4b, 0x94, 0x77, 0xbb, 0x08);

#define WM_REFRESH_ENDPOINTS (WM_APP + 1)
#define WM_SESSION_CREATED (WM_APP + 2)
#define WM_SESSION_DISCONNECTED (WM_APP + 3)

typedef struct DeviceMonitor DeviceMonitor;
typedef struct SessionEvents SessionEvents;
typedef struct SessionNotification SessionNotification;
typedef struct EndpointNotification EndpointNotification;

struct SessionEvents {
    IAudioSessionEventsVtbl *lpVtbl;
    LONG refCount;
    MicSessionState activity;
    IAudioSessionControl *control;
    DeviceMonitor *owner;
    LPWSTR instanceId;
    LONG cleanupPosted;
    BOOL linked;
    BOOL registered;
    SessionEvents *next;
};

struct SessionNotification {
    IAudioSessionNotificationVtbl *lpVtbl;
    LONG refCount;
    DeviceMonitor *owner;
};

struct DeviceMonitor {
    LONG refCount;
    BOOL active;
    unsigned long refreshGeneration;
    LPWSTR deviceId;
    IMMDevice *device;
    IAudioSessionManager2 *manager;
    SessionNotification *notification;
    BOOL notificationRegistered;
    SessionEvents *sessions;
    DeviceMonitor *next;
};

struct EndpointNotification {
    IMMNotificationClientVtbl *lpVtbl;
    LONG refCount;
};

typedef struct CreatedSessionMessage {
    DeviceMonitor *owner;
    IAudioSessionControl *control;
} CreatedSessionMessage;

static MicPidRegistry g_pidRegistry;
static SRWLOCK g_pidRegistryLock = SRWLOCK_INIT;
static DeviceMonitor *g_deviceMonitors = NULL;
static DWORD g_mainThreadId = 0;
static volatile LONG g_running = 1;
static volatile LONG g_coverageLost = 0;
static unsigned long g_refreshGeneration = 0;

static void ReportCoverageLost(const char *operation, HRESULT hr);
static BOOL RegisterSessionOnControl(
    DeviceMonitor *owner,
    IAudioSessionControl *sessionControl);
static void DeviceMonitorAddRef(DeviceMonitor *monitor);
static void DeviceMonitorRelease(DeviceMonitor *monitor);

static void EmitPidTransition(MicPid pid, bool active, void *context)
{
    (void)context;
    printf(active ? "MIC_START %lu\n" : "MIC_STOP %lu\n", pid);
    fflush(stdout);
}

static BOOL SetSessionActive(SessionEvents *session, BOOL active)
{
    bool updated;

    AcquireSRWLockExclusive(&g_pidRegistryLock);
    updated = MicSessionSetActive(
        &g_pidRegistry, &session->activity, active ? true : false);
    ReleaseSRWLockExclusive(&g_pidRegistryLock);

    if (!updated) {
        ReportCoverageLost("record session activity", E_OUTOFMEMORY);
        return FALSE;
    }
    return TRUE;
}

static bool ApplySessionState(void *session, bool active)
{
    return SetSessionActive(
        (SessionEvents *)session, active ? TRUE : FALSE) != FALSE;
}

static bool QueueSessionCleanup(void *session)
{
    SessionEvents *events = (SessionEvents *)session;

    if (InterlockedCompareExchange(&events->cleanupPosted, 1, 0) == 0) {
        IAudioSessionEvents_AddRef((IAudioSessionEvents *)events);
        if (!PostThreadMessage(
                g_mainThreadId,
                WM_SESSION_DISCONNECTED,
                0,
                (LPARAM)events)) {
            IAudioSessionEvents_Release((IAudioSessionEvents *)events);
            ReportCoverageLost(
                "queue session cleanup", HRESULT_FROM_WIN32(GetLastError()));
            return false;
        }
    }
    return true;
}

static HRESULT STDMETHODCALLTYPE SE_QueryInterface(
    IAudioSessionEvents *This, REFIID riid, void **object)
{
    if (!object) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IAudioSessionEvents)) {
        *object = This;
        IAudioSessionEvents_AddRef(This);
        return S_OK;
    }
    *object = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE SE_AddRef(IAudioSessionEvents *This)
{
    return (ULONG)InterlockedIncrement(&((SessionEvents *)This)->refCount);
}

static ULONG STDMETHODCALLTYPE SE_Release(IAudioSessionEvents *This)
{
    SessionEvents *self = (SessionEvents *)This;
    LONG count = InterlockedDecrement(&self->refCount);
    if (count == 0) {
        DeviceMonitor *owner = self->owner;
        if (self->instanceId) CoTaskMemFree(self->instanceId);
        self->instanceId = NULL;
        self->owner = NULL;
        free(self);
        if (owner) DeviceMonitorRelease(owner);
    }
    return (ULONG)count;
}

static HRESULT STDMETHODCALLTYPE SE_OnDisplayNameChanged(
    IAudioSessionEvents *This, LPCWSTR name, LPCGUID context)
{
    (void)This; (void)name; (void)context;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnIconPathChanged(
    IAudioSessionEvents *This, LPCWSTR path, LPCGUID context)
{
    (void)This; (void)path; (void)context;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnSimpleVolumeChanged(
    IAudioSessionEvents *This, float volume, BOOL muted, LPCGUID context)
{
    (void)This; (void)volume; (void)muted; (void)context;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnChannelVolumeChanged(
    IAudioSessionEvents *This,
    DWORD channelCount,
    float volumes[],
    DWORD changedChannel,
    LPCGUID context)
{
    (void)This; (void)channelCount; (void)volumes;
    (void)changedChannel; (void)context;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnGroupingParamChanged(
    IAudioSessionEvents *This, LPCGUID grouping, LPCGUID context)
{
    (void)This; (void)grouping; (void)context;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnStateChanged(
    IAudioSessionEvents *This, AudioSessionState newState)
{
    MicHandleSessionStateChange(
        (unsigned int)newState,
        This,
        ApplySessionState,
        QueueSessionCleanup);
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE SE_OnSessionDisconnected(
    IAudioSessionEvents *This,
    AudioSessionDisconnectReason reason)
{
    (void)reason;

    MicHandleSessionStateChange(
        MIC_SESSION_STATE_EXPIRED,
        This,
        ApplySessionState,
        QueueSessionCleanup);
    return S_OK;
}

static IAudioSessionEventsVtbl g_sessionEventsVtbl = {
    SE_QueryInterface,
    SE_AddRef,
    SE_Release,
    SE_OnDisplayNameChanged,
    SE_OnIconPathChanged,
    SE_OnSimpleVolumeChanged,
    SE_OnChannelVolumeChanged,
    SE_OnGroupingParamChanged,
    SE_OnStateChanged,
    SE_OnSessionDisconnected
};

static SessionEvents *CreateSessionEvents(
    DeviceMonitor *owner,
    IAudioSessionControl *control,
    DWORD pid,
    LPWSTR instanceId)
{
    SessionEvents *events = (SessionEvents *)calloc(1, sizeof(SessionEvents));
    if (!events) return NULL;

    events->lpVtbl = &g_sessionEventsVtbl;
    events->refCount = 1;
    events->activity.pid = (MicPid)pid;
    events->activity.active = false;
    events->owner = owner;
    events->control = control;
    events->instanceId = instanceId;
    IAudioSessionControl_AddRef(control);
    DeviceMonitorAddRef(owner);
    return events;
}

static HRESULT STDMETHODCALLTYPE SN_QueryInterface(
    IAudioSessionNotification *This, REFIID riid, void **object)
{
    if (!object) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IAudioSessionNotification)) {
        *object = This;
        IAudioSessionNotification_AddRef(This);
        return S_OK;
    }
    *object = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE SN_AddRef(IAudioSessionNotification *This)
{
    return (ULONG)InterlockedIncrement(&((SessionNotification *)This)->refCount);
}

static ULONG STDMETHODCALLTYPE SN_Release(IAudioSessionNotification *This)
{
    SessionNotification *self = (SessionNotification *)This;
    LONG count = InterlockedDecrement(&self->refCount);
    if (count == 0) {
        DeviceMonitor *owner = self->owner;
        self->owner = NULL;
        free(self);
        if (owner) DeviceMonitorRelease(owner);
    }
    return (ULONG)count;
}

static HRESULT STDMETHODCALLTYPE SN_OnSessionCreated(
    IAudioSessionNotification *This, IAudioSessionControl *newSession)
{
    SessionNotification *self = (SessionNotification *)This;
    CreatedSessionMessage *message;

    if (!newSession) return E_POINTER;

    message = (CreatedSessionMessage *)calloc(1, sizeof(CreatedSessionMessage));
    if (!message) {
        ReportCoverageLost("allocate session notification", E_OUTOFMEMORY);
        return E_OUTOFMEMORY;
    }

    DeviceMonitorAddRef(self->owner);
    IAudioSessionControl_AddRef(newSession);
    message->owner = self->owner;
    message->control = newSession;
    if (!PostThreadMessage(
            g_mainThreadId, WM_SESSION_CREATED, 0, (LPARAM)message)) {
        HRESULT hr = HRESULT_FROM_WIN32(GetLastError());
        IAudioSessionControl_Release(newSession);
        DeviceMonitorRelease(self->owner);
        free(message);
        ReportCoverageLost("queue new session", hr);
        return hr;
    }
    return S_OK;
}

static IAudioSessionNotificationVtbl g_sessionNotificationVtbl = {
    SN_QueryInterface,
    SN_AddRef,
    SN_Release,
    SN_OnSessionCreated
};

static SessionNotification *CreateSessionNotification(DeviceMonitor *owner)
{
    SessionNotification *notification =
        (SessionNotification *)calloc(1, sizeof(SessionNotification));
    if (!notification) return NULL;
    notification->lpVtbl = &g_sessionNotificationVtbl;
    notification->refCount = 1;
    notification->owner = owner;
    DeviceMonitorAddRef(owner);
    return notification;
}

static void DeviceMonitorAddRef(DeviceMonitor *monitor)
{
    InterlockedIncrement(&monitor->refCount);
}

static void DeviceMonitorRelease(DeviceMonitor *monitor)
{
    if (InterlockedDecrement(&monitor->refCount) == 0) {
        free(monitor);
    }
}

static SessionEvents *FindSession(
    DeviceMonitor *owner,
    LPCWSTR instanceId)
{
    SessionEvents *session = owner->sessions;
    while (session) {
        if (session->instanceId && wcscmp(session->instanceId, instanceId) == 0) {
            return session;
        }
        session = session->next;
    }
    return NULL;
}

static void UnlinkSession(DeviceMonitor *owner, SessionEvents *target)
{
    SessionEvents **cursor = &owner->sessions;
    while (*cursor) {
        if (*cursor == target) {
            *cursor = target->next;
            target->next = NULL;
            target->linked = FALSE;
            return;
        }
        cursor = &(*cursor)->next;
    }
}

static void StopMonitoringSession(SessionEvents *events)
{
    if (events->registered && events->control) {
        IAudioSessionControl_UnregisterAudioSessionNotification(
            events->control, (IAudioSessionEvents *)events);
        events->registered = FALSE;
    }
    SetSessionActive(events, FALSE);
    if (events->control) {
        IAudioSessionControl_Release(events->control);
        events->control = NULL;
    }
}

static void ReleaseOwnedSession(SessionEvents *events)
{
    if (events->linked && events->owner) {
        UnlinkSession(events->owner, events);
    }
    StopMonitoringSession(events);
    IAudioSessionEvents_Release((IAudioSessionEvents *)events);
}

static BOOL RegisterSessionOnControl(
    DeviceMonitor *owner,
    IAudioSessionControl *sessionControl)
{
    IAudioSessionControl2 *control2 = NULL;
    LPWSTR instanceId = NULL;
    SessionEvents *events = NULL;
    AudioSessionState state;
    DWORD pid = 0;
    HRESULT hr;

    hr = IAudioSessionControl_QueryInterface(
        sessionControl, &IID_IAudioSessionControl2, (void **)&control2);
    if (FAILED(hr) || !control2) goto fail;

    hr = IAudioSessionControl2_GetProcessId(control2, &pid);
    if (!MicProcessIdentityIsReliable((long)hr, (MicPid)pid)) {
        /* Sessions that cannot be attributed (e.g. cross-process ones returning
         * AUDCLNT_S_NO_SINGLE_PROCESS) are reported under pid 0. The JS caller
         * can never exclude pid 0 as its own, so such a session counts as an
         * external capture — auto-end stays parked while it is active instead
         * of the helper giving up. */
        pid = 0;
    }

    hr = IAudioSessionControl2_GetSessionInstanceIdentifier(control2, &instanceId);
    if (FAILED(hr) || !instanceId) goto fail;

    if (FindSession(owner, instanceId)) {
        CoTaskMemFree(instanceId);
        IAudioSessionControl2_Release(control2);
        return TRUE;
    }

    events = CreateSessionEvents(owner, sessionControl, pid, instanceId);
    if (!events) {
        hr = E_OUTOFMEMORY;
        goto fail;
    }
    instanceId = NULL;
    events->next = owner->sessions;
    owner->sessions = events;
    events->linked = TRUE;

    hr = IAudioSessionControl_RegisterAudioSessionNotification(
        sessionControl, (IAudioSessionEvents *)events);
    if (FAILED(hr)) goto fail_registered;
    events->registered = TRUE;

    hr = IAudioSessionControl_GetState(sessionControl, &state);
    if (FAILED(hr)) goto fail_registered;
    if (!SetSessionActive(events, state == AudioSessionStateActive)) {
        hr = E_FAIL;
        goto fail_registered;
    }

    IAudioSessionControl2_Release(control2);
    return TRUE;

fail_registered:
    ReleaseOwnedSession(events);
fail:
    if (instanceId) CoTaskMemFree(instanceId);
    if (control2) IAudioSessionControl2_Release(control2);
    fprintf(stderr, "Error: Failed to register capture session (0x%08lx)\n",
        (unsigned long)hr);
    return FALSE;
}

static void CleanupDeviceMonitor(DeviceMonitor *monitor)
{
    SessionEvents *session;

    monitor->active = FALSE;
    if (monitor->notificationRegistered && monitor->manager) {
        IAudioSessionManager2_UnregisterSessionNotification(
            monitor->manager,
            (IAudioSessionNotification *)monitor->notification);
        monitor->notificationRegistered = FALSE;
    }

    while ((session = monitor->sessions) != NULL) {
        ReleaseOwnedSession(session);
    }

    if (monitor->notification) {
        IAudioSessionNotification_Release(
            (IAudioSessionNotification *)monitor->notification);
        monitor->notification = NULL;
    }
    if (monitor->manager) {
        IAudioSessionManager2_Release(monitor->manager);
        monitor->manager = NULL;
    }
    if (monitor->device) {
        IMMDevice_Release(monitor->device);
        monitor->device = NULL;
    }
    if (monitor->deviceId) {
        CoTaskMemFree(monitor->deviceId);
        monitor->deviceId = NULL;
    }
    DeviceMonitorRelease(monitor);
}

static DeviceMonitor *CreateDeviceMonitor(
    IMMDevice *device,
    LPWSTR deviceId,
    unsigned long refreshGeneration)
{
    DeviceMonitor *monitor = NULL;
    IAudioSessionEnumerator *sessionEnumerator = NULL;
    int sessionCount = 0;
    HRESULT hr;

    monitor = (DeviceMonitor *)calloc(1, sizeof(DeviceMonitor));
    if (!monitor) {
        hr = E_OUTOFMEMORY;
        goto fail;
    }
    monitor->refCount = 1;
    monitor->active = TRUE;
    monitor->refreshGeneration = refreshGeneration;
    monitor->device = device;
    monitor->deviceId = deviceId;

    hr = IMMDevice_Activate(
        device,
        &IID_IAudioSessionManager2,
        CLSCTX_ALL,
        NULL,
        (void **)&monitor->manager);
    if (FAILED(hr) || !monitor->manager) goto fail;

    monitor->notification = CreateSessionNotification(monitor);
    if (!monitor->notification) {
        hr = E_OUTOFMEMORY;
        goto fail;
    }
    hr = IAudioSessionManager2_RegisterSessionNotification(
        monitor->manager,
        (IAudioSessionNotification *)monitor->notification);
    if (FAILED(hr)) goto fail;
    monitor->notificationRegistered = TRUE;

    hr = IAudioSessionManager2_GetSessionEnumerator(
        monitor->manager, &sessionEnumerator);
    if (FAILED(hr) || !sessionEnumerator) goto fail;

    hr = IAudioSessionEnumerator_GetCount(sessionEnumerator, &sessionCount);
    if (FAILED(hr)) goto fail;

    for (int index = 0; index < sessionCount; index++) {
        IAudioSessionControl *sessionControl = NULL;
        hr = IAudioSessionEnumerator_GetSession(
            sessionEnumerator, index, &sessionControl);
        if (FAILED(hr) || !sessionControl) goto fail;

        if (!RegisterSessionOnControl(monitor, sessionControl)) {
            IAudioSessionControl_Release(sessionControl);
            hr = E_FAIL;
            goto fail;
        }
        IAudioSessionControl_Release(sessionControl);
    }

    IAudioSessionEnumerator_Release(sessionEnumerator);
    return monitor;

fail:
    if (sessionEnumerator) IAudioSessionEnumerator_Release(sessionEnumerator);
    if (monitor) {
        CleanupDeviceMonitor(monitor);
    } else {
        if (deviceId) CoTaskMemFree(deviceId);
        if (device) IMMDevice_Release(device);
    }
    fprintf(stderr, "Error: Failed to monitor capture endpoint (0x%08lx)\n",
        (unsigned long)hr);
    return NULL;
}

static DeviceMonitor *FindDeviceMonitor(LPCWSTR deviceId)
{
    DeviceMonitor *monitor = g_deviceMonitors;
    while (monitor) {
        if (monitor->deviceId && wcscmp(monitor->deviceId, deviceId) == 0) {
            return monitor;
        }
        monitor = monitor->next;
    }
    return NULL;
}

static BOOL RefreshDeviceMonitors(IMMDeviceEnumerator *enumerator)
{
    IMMDeviceCollection *collection = NULL;
    unsigned long generation = ++g_refreshGeneration;
    UINT deviceCount = 0;
    HRESULT hr;

    hr = IMMDeviceEnumerator_EnumAudioEndpoints(
        enumerator, eCapture, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr) || !collection) goto fail;

    hr = IMMDeviceCollection_GetCount(collection, &deviceCount);
    if (FAILED(hr)) goto fail;

    for (UINT index = 0; index < deviceCount; index++) {
        IMMDevice *device = NULL;
        LPWSTR deviceId = NULL;
        DeviceMonitor *monitor;

        hr = IMMDeviceCollection_Item(collection, index, &device);
        if (FAILED(hr) || !device) goto fail;

        hr = IMMDevice_GetId(device, &deviceId);
        if (FAILED(hr) || !deviceId) {
            IMMDevice_Release(device);
            goto fail;
        }

        monitor = FindDeviceMonitor(deviceId);
        if (monitor) {
            monitor->refreshGeneration = generation;
            CoTaskMemFree(deviceId);
            IMMDevice_Release(device);
            continue;
        }

        monitor = CreateDeviceMonitor(device, deviceId, generation);
        if (!monitor) {
            hr = E_FAIL;
            goto fail;
        }
        monitor->next = g_deviceMonitors;
        g_deviceMonitors = monitor;
    }

    {
        DeviceMonitor **cursor = &g_deviceMonitors;
        while (*cursor) {
            DeviceMonitor *monitor = *cursor;
            if (monitor->refreshGeneration != generation) {
                *cursor = monitor->next;
                monitor->next = NULL;
                CleanupDeviceMonitor(monitor);
            } else {
                cursor = &monitor->next;
            }
        }
    }

    IMMDeviceCollection_Release(collection);
    return TRUE;

fail:
    if (collection) IMMDeviceCollection_Release(collection);
    fprintf(stderr, "Error: Failed to refresh capture endpoints (0x%08lx)\n",
        (unsigned long)hr);
    return FALSE;
}

static void QueueEndpointRefresh(void)
{
    if (!PostThreadMessage(g_mainThreadId, WM_REFRESH_ENDPOINTS, 0, 0)) {
        ReportCoverageLost("queue endpoint refresh", HRESULT_FROM_WIN32(GetLastError()));
    }
}

static HRESULT STDMETHODCALLTYPE EN_QueryInterface(
    IMMNotificationClient *This, REFIID riid, void **object)
{
    if (!object) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &IID_IMMNotificationClient)) {
        *object = This;
        IMMNotificationClient_AddRef(This);
        return S_OK;
    }
    *object = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE EN_AddRef(IMMNotificationClient *This)
{
    return (ULONG)InterlockedIncrement(&((EndpointNotification *)This)->refCount);
}

static ULONG STDMETHODCALLTYPE EN_Release(IMMNotificationClient *This)
{
    EndpointNotification *self = (EndpointNotification *)This;
    LONG count = InterlockedDecrement(&self->refCount);
    if (count == 0) free(self);
    return (ULONG)count;
}

static HRESULT STDMETHODCALLTYPE EN_OnDeviceStateChanged(
    IMMNotificationClient *This, LPCWSTR deviceId, DWORD newState)
{
    (void)This; (void)deviceId; (void)newState;
    QueueEndpointRefresh();
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE EN_OnDeviceAdded(
    IMMNotificationClient *This, LPCWSTR deviceId)
{
    (void)This; (void)deviceId;
    QueueEndpointRefresh();
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE EN_OnDeviceRemoved(
    IMMNotificationClient *This, LPCWSTR deviceId)
{
    (void)This; (void)deviceId;
    QueueEndpointRefresh();
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE EN_OnDefaultDeviceChanged(
    IMMNotificationClient *This,
    EDataFlow flow,
    ERole role,
    LPCWSTR defaultDeviceId)
{
    (void)This; (void)flow; (void)role; (void)defaultDeviceId;
    QueueEndpointRefresh();
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE EN_OnPropertyValueChanged(
    IMMNotificationClient *This,
    LPCWSTR deviceId,
    const PROPERTYKEY key)
{
    (void)This; (void)deviceId; (void)key;
    QueueEndpointRefresh();
    return S_OK;
}

static IMMNotificationClientVtbl g_endpointNotificationVtbl = {
    EN_QueryInterface,
    EN_AddRef,
    EN_Release,
    EN_OnDeviceStateChanged,
    EN_OnDeviceAdded,
    EN_OnDeviceRemoved,
    EN_OnDefaultDeviceChanged,
    EN_OnPropertyValueChanged
};

static EndpointNotification *CreateEndpointNotification(void)
{
    EndpointNotification *notification =
        (EndpointNotification *)calloc(1, sizeof(EndpointNotification));
    if (!notification) return NULL;
    notification->lpVtbl = &g_endpointNotificationVtbl;
    notification->refCount = 1;
    return notification;
}

/* A coverage gap means per-PID data can no longer be trusted, but degraded
 * MIC_START/MIC_STOP reporting still beats exiting (the JS caller has no
 * respawn, and its polling fallback only knows a few process names). Announce
 * the one-way downgrade so the consumer stops treating the data as reliable,
 * and keep running. Setup-time losses still abort via MicCoverageSetupIsReady,
 * which gates the READY/CAPABILITY handshake on g_coverageLost. */
static void ReportCoverageLost(const char *operation, HRESULT hr)
{
    if (InterlockedCompareExchange(&g_coverageLost, 1, 0) == 0) {
        fprintf(stderr, "Warning: Lost microphone coverage while attempting to %s (0x%08lx)\n",
            operation, (unsigned long)hr);
        printf("CAPABILITY AGGREGATE\n");
        fflush(stdout);
    }
}

static void HandleCreatedSession(CreatedSessionMessage *message)
{
    if (message->owner->active &&
        !RegisterSessionOnControl(message->owner, message->control)) {
        ReportCoverageLost("monitor new capture session", E_FAIL);
    }
    IAudioSessionControl_Release(message->control);
    DeviceMonitorRelease(message->owner);
    free(message);
}

static void HandleDisconnectedSession(SessionEvents *session)
{
    if (session->linked) ReleaseOwnedSession(session);
    IAudioSessionEvents_Release((IAudioSessionEvents *)session);
}

static void DrainPendingMessages(void)
{
    MSG message;
    while (PeekMessage(&message, NULL, WM_APP, WM_APP + 3, PM_REMOVE)) {
        if (message.message == WM_SESSION_CREATED) {
            HandleCreatedSession((CreatedSessionMessage *)message.lParam);
        } else if (message.message == WM_SESSION_DISCONNECTED) {
            HandleDisconnectedSession((SessionEvents *)message.lParam);
        }
    }
}

static void CleanupAllDevices(void)
{
    DeviceMonitor *monitor = g_deviceMonitors;
    g_deviceMonitors = NULL;
    while (monitor) {
        DeviceMonitor *next = monitor->next;
        monitor->next = NULL;
        CleanupDeviceMonitor(monitor);
        monitor = next;
    }
}

BOOL WINAPI ConsoleHandler(DWORD signal)
{
    if (signal == CTRL_C_EVENT ||
        signal == CTRL_BREAK_EVENT ||
        signal == CTRL_CLOSE_EVENT) {
        InterlockedExchange(&g_running, 0);
        PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
        return TRUE;
    }
    return FALSE;
}

static DWORD WINAPI StdinMonitorThread(LPVOID parameter)
{
    char buffer[64];
    HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
    (void)parameter;

    while (InterlockedCompareExchange(&g_running, 1, 1)) {
        DWORD bytesRead = 0;
        BOOL read = ReadFile(
            stdinHandle, buffer, sizeof(buffer), &bytesRead, NULL);
        if (!read || bytesRead == 0) {
            InterlockedExchange(&g_running, 0);
            PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
            break;
        }
    }
    return 0;
}

int main(int argc, char *argv[])
{
    IMMDeviceEnumerator *enumerator = NULL;
    EndpointNotification *endpointNotification = NULL;
    BOOL endpointRegistered = FALSE;
    BOOL consoleHandlerRegistered = FALSE;
    BOOL comInitialized = FALSE;
    HANDLE stdinThread = NULL;
    MicCoverageSetup setup = { false, false, false };
    MSG message;
    HRESULT hr = E_FAIL;
    int exitCode = 1;
    (void)argc;
    (void)argv;

    g_mainThreadId = GetCurrentThreadId();
    PeekMessage(&message, NULL, WM_USER, WM_USER, PM_NOREMOVE);
    MicPidRegistryInitialize(
        &g_pidRegistry, NULL, NULL, EmitPidTransition, NULL);

    hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        fprintf(stderr, "Error: CoInitializeEx failed (0x%08lx)\n", (unsigned long)hr);
        goto cleanup;
    }
    comInitialized = TRUE;

    hr = CoCreateInstance(
        &CLSID_MMDeviceEnumerator,
        NULL,
        CLSCTX_ALL,
        &IID_IMMDeviceEnumerator,
        (void **)&enumerator);
    if (FAILED(hr) || !enumerator) {
        fprintf(stderr, "Error: Failed to create device enumerator (0x%08lx)\n",
            (unsigned long)hr);
        goto cleanup;
    }

    endpointNotification = CreateEndpointNotification();
    if (!endpointNotification) {
        hr = E_OUTOFMEMORY;
        fprintf(stderr, "Error: Failed to create endpoint notification\n");
        goto cleanup;
    }

    hr = IMMDeviceEnumerator_RegisterEndpointNotificationCallback(
        enumerator, (IMMNotificationClient *)endpointNotification);
    if (FAILED(hr)) {
        fprintf(stderr, "Error: Failed to register endpoint notification (0x%08lx)\n",
            (unsigned long)hr);
        goto cleanup;
    }
    endpointRegistered = TRUE;
    setup.endpointNotificationsRegistered = true;

    if (!RefreshDeviceMonitors(enumerator)) {
        hr = E_FAIL;
        goto cleanup;
    }
    setup.endpointsReconciled = true;

    if (!SetConsoleCtrlHandler(ConsoleHandler, TRUE)) {
        hr = HRESULT_FROM_WIN32(GetLastError());
        fprintf(stderr, "Error: Failed to register console handler (0x%08lx)\n",
            (unsigned long)hr);
        goto cleanup;
    }
    consoleHandlerRegistered = TRUE;

    stdinThread = CreateThread(NULL, 0, StdinMonitorThread, NULL, 0, NULL);
    if (!stdinThread) {
        hr = HRESULT_FROM_WIN32(GetLastError());
        fprintf(stderr, "Error: Failed to start stdin monitor (0x%08lx)\n",
            (unsigned long)hr);
        goto cleanup;
    }
    CloseHandle(stdinThread);
    stdinThread = NULL;
    setup.lifetimeMonitoringReady = true;

    if (!MicCoverageSetupIsReady(
            &setup,
            InterlockedCompareExchange(&g_coverageLost, 0, 0) == 0,
            InterlockedCompareExchange(&g_running, 1, 1) != 0)) {
        hr = E_UNEXPECTED;
        goto cleanup;
    }

    printf("READY\n");
    /* Distinct from READY (which pre-refcounting builds also print) so the JS
     * consumer only trusts per-PID data from binaries that actually provide it. */
    printf("CAPABILITY PID\n");
    fflush(stdout);
    exitCode = 0;

    while (InterlockedCompareExchange(&g_running, 1, 1)) {
        BOOL result = GetMessage(&message, NULL, 0, 0);
        if (result <= 0) break;

        if (message.message == WM_REFRESH_ENDPOINTS) {
            if (!RefreshDeviceMonitors(enumerator)) {
                ReportCoverageLost("refresh capture endpoints", E_FAIL);
            }
        } else if (message.message == WM_SESSION_CREATED) {
            HandleCreatedSession((CreatedSessionMessage *)message.lParam);
        } else if (message.message == WM_SESSION_DISCONNECTED) {
            HandleDisconnectedSession((SessionEvents *)message.lParam);
        } else {
            TranslateMessage(&message);
            DispatchMessage(&message);
        }
    }

    if (InterlockedCompareExchange(&g_coverageLost, 0, 0)) exitCode = 2;

cleanup:
    InterlockedExchange(&g_running, 0);
    if (endpointRegistered) {
        IMMDeviceEnumerator_UnregisterEndpointNotificationCallback(
            enumerator, (IMMNotificationClient *)endpointNotification);
    }
    DrainPendingMessages();
    CleanupAllDevices();
    DrainPendingMessages();
    if (endpointNotification) {
        IMMNotificationClient_Release(
            (IMMNotificationClient *)endpointNotification);
    }
    if (enumerator) IMMDeviceEnumerator_Release(enumerator);
    if (consoleHandlerRegistered) SetConsoleCtrlHandler(ConsoleHandler, FALSE);
    AcquireSRWLockExclusive(&g_pidRegistryLock);
    MicPidRegistryDestroy(&g_pidRegistry);
    ReleaseSRWLockExclusive(&g_pidRegistryLock);
    if (comInitialized) CoUninitialize();
    return exitCode;
}

#endif
