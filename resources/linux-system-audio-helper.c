#define _GNU_SOURCE

#include <errno.h>
#include <glib.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifdef HAVE_PIPEWIRE
#include <glib-unix.h>
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#endif

#define TARGET_SAMPLE_RATE 24000
#define TARGET_CHANNELS 1
#define SINK_MEDIA_CLASS "Audio/Sink"
#define OWN_NODE_PREFIX "openwhispr"
#define SINK_NODE_LATENCY "480/48000"
#define MIX_TICK_MS 10
#define MIX_CHUNK_FRAMES 2400
#define SOURCE_RING_FRAMES TARGET_SAMPLE_RATE
#define SOURCE_PRIME_FRAMES (TARGET_SAMPLE_RATE * 60 / 1000)
#define SOURCE_MAX_FRAMES (TARGET_SAMPLE_RATE * 200 / 1000)
#define SOURCE_TRIM_FRAMES (TARGET_SAMPLE_RATE * 120 / 1000)
#define MAX_CATCHUP_FRAMES (TARGET_SAMPLE_RATE / 2)

typedef struct Helper Helper;

#ifdef HAVE_PIPEWIRE
typedef struct {
    Helper *app;
    uint32_t node_id;
    gchar *sink_name;
    struct pw_stream *stream;
    struct spa_hook stream_listener;
    float *ring;
    guint read_pos;
    guint fill;
    gboolean primed;
    gboolean format_ok;
} SinkSource;
#endif

struct Helper {
    GMainLoop *loop;
    int exit_code;
#ifdef HAVE_PIPEWIRE
    struct pw_thread_loop *pw_loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_registry *registry;
    struct spa_hook core_listener;
    struct spa_hook registry_listener;
    GPtrArray *sources;
    int sync_seq;
    gint started; /* atomic; set from the PipeWire thread, read by the mix timer */
    gboolean clock_running;
    gint64 clock_origin_us;
    guint64 frames_emitted;
    guint mix_source_id;
    float mix_buffer[MIX_CHUNK_FRAMES];
    int16_t out_buffer[MIX_CHUNK_FRAMES];
#endif
};

static void json_print_escaped(FILE *stream, const char *value)
{
    const unsigned char *ptr = (const unsigned char *)value;

    fputc('"', stream);
    for (; ptr && *ptr; ptr++) {
        switch (*ptr) {
            case '\\':
                fputs("\\\\", stream);
                break;
            case '"':
                fputs("\\\"", stream);
                break;
            case '\b':
                fputs("\\b", stream);
                break;
            case '\f':
                fputs("\\f", stream);
                break;
            case '\n':
                fputs("\\n", stream);
                break;
            case '\r':
                fputs("\\r", stream);
                break;
            case '\t':
                fputs("\\t", stream);
                break;
            default:
                if (*ptr < 0x20) {
                    fprintf(stream, "\\u%04x", *ptr);
                } else {
                    fputc(*ptr, stream);
                }
                break;
        }
    }
    fputc('"', stream);
}

static void json_append_escaped(GString *string, const char *value)
{
    const unsigned char *ptr = (const unsigned char *)value;

    g_string_append_c(string, '"');
    for (; ptr && *ptr; ptr++) {
        switch (*ptr) {
            case '\\':
                g_string_append(string, "\\\\");
                break;
            case '"':
                g_string_append(string, "\\\"");
                break;
            case '\b':
                g_string_append(string, "\\b");
                break;
            case '\f':
                g_string_append(string, "\\f");
                break;
            case '\n':
                g_string_append(string, "\\n");
                break;
            case '\r':
                g_string_append(string, "\\r");
                break;
            case '\t':
                g_string_append(string, "\\t");
                break;
            default:
                if (*ptr < 0x20) {
                    g_string_append_printf(string, "\\u%04x", *ptr);
                } else {
                    g_string_append_c(string, (gchar)*ptr);
                }
                break;
        }
    }
    g_string_append_c(string, '"');
}

static void emit_event(const char *type, const char *code, const char *message)
{
    GString *line = g_string_new("{\"type\":");
    json_append_escaped(line, type);

    if (code) {
        g_string_append(line, ",\"code\":");
        json_append_escaped(line, code);
    }

    if (message) {
        g_string_append(line, ",\"message\":");
        json_append_escaped(line, message);
    }

    if (strcmp(type, "start") == 0) {
        g_string_append(line, ",\"restoreToken\":null");
    }

    g_string_append(line, "}\n");

    flockfile(stderr);
    fputs(line->str, stderr);
    fflush(stderr);
    funlockfile(stderr);

    g_string_free(line, TRUE);
}

static void print_probe_json(gboolean ok, gboolean native_capture, const char *error)
{
    fputs("{\"ok\":", stdout);
    fputs(ok ? "true" : "false", stdout);
    fputs(",\"portalVersion\":null", stdout);
    fputs(",\"supportsPersistMode\":false", stdout);
    fputs(",\"supportsRestoreToken\":false", stdout);
    fputs(",\"supportsSystemAudio\":", stdout);
    fputs(ok ? "true" : "false", stdout);
    fputs(",\"supportsNativeCapture\":", stdout);
    fputs(native_capture ? "true" : "false", stdout);
    fputs(",\"source\":\"pipewire-loopback\"", stdout);

    if (!ok && error) {
        fputs(",\"error\":", stdout);
        json_print_escaped(stdout, error);
    }

    fputs("}\n", stdout);
    fflush(stdout);
}

#ifdef HAVE_PIPEWIRE
static void finish_start(Helper *app, int exit_code)
{
    app->exit_code = exit_code;
    if (app->loop) {
        g_main_loop_quit(app->loop);
    }
}

static gboolean check_pipewire_available(void)
{
    gboolean available = FALSE;
    struct pw_thread_loop *loop = NULL;
    struct pw_context *context = NULL;
    struct pw_core *core = NULL;

    pw_init(NULL, NULL);

    loop = pw_thread_loop_new("ow-probe", NULL);
    if (!loop) {
        goto out;
    }

    context = pw_context_new(pw_thread_loop_get_loop(loop), NULL, 0);
    if (!context) {
        goto out;
    }

    core = pw_context_connect(context, NULL, 0);
    available = core != NULL;

out:
    if (core) {
        pw_core_disconnect(core);
    }
    if (context) {
        pw_context_destroy(context);
    }
    if (loop) {
        pw_thread_loop_destroy(loop);
    }
    pw_deinit();

    return available;
}

static gboolean write_all_stdout(Helper *app, const uint8_t *data, size_t size)
{
    size_t written_total = 0;

    while (written_total < size) {
        ssize_t written = write(STDOUT_FILENO, data + written_total, size - written_total);
        if (written > 0) {
            written_total += (size_t)written;
            continue;
        }

        if (written == 0) {
            emit_event("error", "stdout_write_failed",
                       "System audio PCM output write returned zero bytes");
            finish_start(app, 2);
            return FALSE;
        }

        if (written < 0 && errno == EINTR) {
            continue;
        }

        if (written < 0 && errno == EPIPE) {
            emit_event("error", "stdout_closed",
                       "System audio consumer closed the PCM output pipe");
            finish_start(app, 2);
            return FALSE;
        }

        emit_event("error", "stdout_write_failed", g_strerror(errno));
        finish_start(app, 2);
        return FALSE;
    }

    return TRUE;
}

static void sink_source_push(SinkSource *source, const float *samples, guint frames)
{
    if (frames > SOURCE_RING_FRAMES) {
        samples += frames - SOURCE_RING_FRAMES;
        frames = SOURCE_RING_FRAMES;
    }

    for (guint i = 0; i < frames; i++) {
        if (source->fill == SOURCE_RING_FRAMES) {
            source->read_pos = (source->read_pos + 1) % SOURCE_RING_FRAMES;
            source->fill--;
        }
        source->ring[(source->read_pos + source->fill) % SOURCE_RING_FRAMES] = samples[i];
        source->fill++;
    }

    /* Each sink runs on its own device clock; trimming bounds the drift against
     * the monotonic mix clock instead of letting latency grow. */
    if (source->fill > SOURCE_MAX_FRAMES) {
        guint excess = source->fill - SOURCE_TRIM_FRAMES;
        source->read_pos = (source->read_pos + excess) % SOURCE_RING_FRAMES;
        source->fill -= excess;
    }

    if (!source->primed && source->fill >= SOURCE_PRIME_FRAMES) {
        source->primed = TRUE;
    }
}

static void on_source_process(void *userdata)
{
    SinkSource *source = userdata;
    struct pw_buffer *b = pw_stream_dequeue_buffer(source->stream);
    if (!b) return;

    struct spa_buffer *buf = b->buffer;
    if (source->format_ok && buf->n_datas > 0 && buf->datas[0].data && buf->datas[0].chunk) {
        uint32_t offs = SPA_MIN(buf->datas[0].chunk->offset, buf->datas[0].maxsize);
        uint32_t size = SPA_MIN(buf->datas[0].chunk->size, buf->datas[0].maxsize - offs);
        const float *samples = (const float *)((const uint8_t *)buf->datas[0].data + offs);
        sink_source_push(source, samples, size / sizeof(float));
    }

    pw_stream_queue_buffer(source->stream, b);
}

static void on_source_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    SinkSource *source = userdata;

    if (id != SPA_PARAM_Format || !param) {
        return;
    }

    struct spa_audio_info_raw info;
    if (spa_format_audio_raw_parse(param, &info) < 0) {
        source->format_ok = FALSE;
        emit_event("warning", "unsupported_pipewire_format", source->sink_name);
        return;
    }

    source->format_ok =
        info.format == SPA_AUDIO_FORMAT_F32 &&
        info.rate == TARGET_SAMPLE_RATE &&
        info.channels == TARGET_CHANNELS;

    if (!source->format_ok) {
        gchar *message = g_strdup_printf(
            "Unsupported PipeWire audio format on %s: format=%u rate=%u channels=%u",
            source->sink_name, (unsigned int)info.format, info.rate, info.channels);
        emit_event("warning", "unsupported_pipewire_format", message);
        g_free(message);
    }
}

static void on_source_state_changed(void *userdata, enum pw_stream_state old,
                                    enum pw_stream_state state, const char *error)
{
    (void)old;
    SinkSource *source = userdata;

    if (state == PW_STREAM_STATE_ERROR) {
        gchar *message = g_strdup_printf("%s: %s", source->sink_name,
                                         error ? error : "PipeWire stream error");
        emit_event("warning", "sink_capture_error", message);
        g_free(message);
    }
}

static const struct pw_stream_events source_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .process = on_source_process,
    .param_changed = on_source_param_changed,
    .state_changed = on_source_state_changed,
};

static void free_sink_source(SinkSource *source)
{
    if (source->stream) {
        spa_hook_remove(&source->stream_listener);
        pw_stream_destroy(source->stream);
    }
    g_free(source->ring);
    g_free(source->sink_name);
    g_free(source);
}

static void add_sink_source(Helper *app, uint32_t node_id, const char *sink_name)
{
    SinkSource *source = g_new0(SinkSource, 1);
    source->app = app;
    source->node_id = node_id;
    source->sink_name = g_strdup(sink_name);
    source->ring = g_new0(float, SOURCE_RING_FRAMES);

    /* WirePlumber 0.4 moves target.object streams to the new default sink unless
     * dont-reconnect is set, which would capture one device twice. */
    struct pw_properties *props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_NODE_NAME, "openwhispr-system-audio",
        PW_KEY_STREAM_CAPTURE_SINK, "true",
        PW_KEY_TARGET_OBJECT, sink_name,
        PW_KEY_NODE_DONT_RECONNECT, "true",
        PW_KEY_NODE_PASSIVE, "true",
        PW_KEY_NODE_LATENCY, SINK_NODE_LATENCY,
        NULL);

    source->stream = pw_stream_new(app->core, "openwhispr-system-audio", props);
    if (!source->stream) {
        emit_event("warning", "sink_capture_error", sink_name);
        free_sink_source(source);
        return;
    }

    pw_stream_add_listener(source->stream, &source->stream_listener, &source_stream_events, source);

    uint8_t params_buffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(params_buffer, sizeof(params_buffer));
    const struct spa_pod *params[1];
    params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat,
        &SPA_AUDIO_INFO_RAW_INIT(
            .format = SPA_AUDIO_FORMAT_F32,
            .channels = TARGET_CHANNELS,
            .rate = TARGET_SAMPLE_RATE));

    int res = pw_stream_connect(source->stream,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS,
        params, 1);

    if (res < 0) {
        emit_event("warning", "sink_capture_error", sink_name);
        free_sink_source(source);
        return;
    }

    g_ptr_array_add(app->sources, source);
}

static void on_registry_global(void *data, uint32_t id, uint32_t permissions,
                               const char *type, uint32_t version,
                               const struct spa_dict *props)
{
    (void)permissions;
    (void)version;
    Helper *app = data;

    if (!type || strcmp(type, PW_TYPE_INTERFACE_Node) != 0 || !props) {
        return;
    }

    const char *media_class = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    const char *node_name = spa_dict_lookup(props, PW_KEY_NODE_NAME);
    if (!media_class || strcmp(media_class, SINK_MEDIA_CLASS) != 0 || !node_name ||
        g_str_has_prefix(node_name, OWN_NODE_PREFIX)) {
        return;
    }

    add_sink_source(app, id, node_name);
}

static void on_registry_global_remove(void *data, uint32_t id)
{
    Helper *app = data;

    for (guint i = 0; i < app->sources->len; i++) {
        SinkSource *source = g_ptr_array_index(app->sources, i);
        if (source->node_id == id) {
            g_ptr_array_remove_index_fast(app->sources, i);
            free_sink_source(source);
            return;
        }
    }
}

static const struct pw_registry_events registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = on_registry_global,
    .global_remove = on_registry_global_remove,
};

static void on_core_done(void *data, uint32_t id, int seq)
{
    Helper *app = data;

    if (id != PW_ID_CORE || seq != app->sync_seq || g_atomic_int_get(&app->started)) {
        return;
    }

    g_atomic_int_set(&app->started, 1);
    emit_event("start", NULL, NULL);
}

static void on_core_error(void *data, uint32_t id, int seq, int res, const char *message)
{
    (void)seq;
    Helper *app = data;

    if (id == PW_ID_CORE && res == -EPIPE) {
        emit_event("error", "pipewire_error", message ? message : "PipeWire connection lost");
        finish_start(app, 2);
    }
}

static const struct pw_core_events core_events = {
    PW_VERSION_CORE_EVENTS,
    .done = on_core_done,
    .error = on_core_error,
};

static void mix_sources(Helper *app, guint frames)
{
    memset(app->mix_buffer, 0, frames * sizeof(float));

    pw_thread_loop_lock(app->pw_loop);
    for (guint s = 0; s < app->sources->len; s++) {
        SinkSource *source = g_ptr_array_index(app->sources, s);
        if (!source->primed) {
            continue;
        }

        guint available = SPA_MIN(source->fill, frames);
        for (guint i = 0; i < available; i++) {
            app->mix_buffer[i] += source->ring[(source->read_pos + i) % SOURCE_RING_FRAMES];
        }
        source->read_pos = (source->read_pos + available) % SOURCE_RING_FRAMES;
        source->fill -= available;

        if (available < frames) {
            source->primed = FALSE;
        }
    }
    pw_thread_loop_unlock(app->pw_loop);
}

static gboolean on_mix_tick(gpointer user_data)
{
    Helper *app = user_data;

    if (!g_atomic_int_get(&app->started)) {
        return G_SOURCE_CONTINUE;
    }

    gint64 now = g_get_monotonic_time();
    if (!app->clock_running) {
        app->clock_running = TRUE;
        app->clock_origin_us = now;
        app->frames_emitted = 0;
        return G_SOURCE_CONTINUE;
    }

    guint64 due_total =
        (guint64)(now - app->clock_origin_us) * TARGET_SAMPLE_RATE / G_USEC_PER_SEC;
    if (due_total <= app->frames_emitted) {
        return G_SOURCE_CONTINUE;
    }

    guint64 due = due_total - app->frames_emitted;
    if (due > MAX_CATCHUP_FRAMES) {
        due = TARGET_SAMPLE_RATE * MIX_TICK_MS / 1000;
        app->frames_emitted = due_total - due;
    }

    while (due > 0) {
        guint frames = due < MIX_CHUNK_FRAMES ? (guint)due : MIX_CHUNK_FRAMES;
        mix_sources(app, frames);

        for (guint i = 0; i < frames; i++) {
            float value = app->mix_buffer[i];
            if (value > 1.0f) value = 1.0f;
            if (value < -1.0f) value = -1.0f;
            value *= 32767.0f;
            app->out_buffer[i] = (int16_t)(value >= 0.0f ? value + 0.5f : value - 0.5f);
        }

        if (!write_all_stdout(app, (const uint8_t *)app->out_buffer, frames * sizeof(int16_t))) {
            app->mix_source_id = 0;
            return G_SOURCE_REMOVE;
        }

        app->frames_emitted += frames;
        due -= frames;
    }

    return G_SOURCE_CONTINUE;
}

static gboolean on_unix_signal(gpointer user_data)
{
    Helper *app = user_data;
    finish_start(app, 0);
    return G_SOURCE_REMOVE;
}

static gboolean run_pipewire_capture(Helper *app)
{
    signal(SIGPIPE, SIG_IGN);

    pw_init(NULL, NULL);

    app->sources = g_ptr_array_new();

    app->pw_loop = pw_thread_loop_new("ow-capture", NULL);
    if (!app->pw_loop) {
        emit_event("error", "pipewire_error", "Failed to create PipeWire loop");
        return FALSE;
    }

    app->context = pw_context_new(pw_thread_loop_get_loop(app->pw_loop), NULL, 0);
    if (!app->context) {
        emit_event("error", "pipewire_error", "Failed to create PipeWire context");
        return FALSE;
    }

    if (pw_thread_loop_start(app->pw_loop) < 0) {
        emit_event("error", "pipewire_error", "Failed to start PipeWire loop");
        return FALSE;
    }

    pw_thread_loop_lock(app->pw_loop);

    app->core = pw_context_connect(app->context, NULL, 0);
    if (!app->core) {
        pw_thread_loop_unlock(app->pw_loop);
        emit_event("error", "pipewire_error", "Failed to connect to PipeWire");
        return FALSE;
    }

    pw_core_add_listener(app->core, &app->core_listener, &core_events, app);

    app->registry = pw_core_get_registry(app->core, PW_VERSION_REGISTRY, 0);
    if (!app->registry) {
        pw_thread_loop_unlock(app->pw_loop);
        emit_event("error", "pipewire_error", "Failed to get PipeWire registry");
        return FALSE;
    }

    pw_registry_add_listener(app->registry, &app->registry_listener, &registry_events, app);
    app->sync_seq = pw_core_sync(app->core, PW_ID_CORE, 0);

    pw_thread_loop_unlock(app->pw_loop);

    app->mix_source_id = g_timeout_add(MIX_TICK_MS, on_mix_tick, app);

    g_unix_signal_add(SIGTERM, on_unix_signal, app);
    g_unix_signal_add(SIGINT, on_unix_signal, app);

    return TRUE;
}

static void cleanup_pipewire(Helper *app)
{
    if (app->mix_source_id) {
        g_source_remove(app->mix_source_id);
        app->mix_source_id = 0;
    }

    if (app->pw_loop) {
        pw_thread_loop_lock(app->pw_loop);
    }
    if (app->sources) {
        for (guint i = 0; i < app->sources->len; i++) {
            free_sink_source(g_ptr_array_index(app->sources, i));
        }
        g_ptr_array_set_size(app->sources, 0);
    }
    if (app->registry) {
        spa_hook_remove(&app->registry_listener);
        pw_proxy_destroy((struct pw_proxy *)app->registry);
        app->registry = NULL;
    }
    if (app->core) {
        spa_hook_remove(&app->core_listener);
        pw_core_disconnect(app->core);
        app->core = NULL;
    }
    if (app->pw_loop) {
        pw_thread_loop_unlock(app->pw_loop);
        pw_thread_loop_stop(app->pw_loop);
    }
    if (app->context) {
        pw_context_destroy(app->context);
        app->context = NULL;
    }
    if (app->pw_loop) {
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
    }
    if (app->sources) {
        g_ptr_array_free(app->sources, TRUE);
        app->sources = NULL;
    }
    pw_deinit();
}
#endif

static gboolean run_probe(void)
{
#ifdef HAVE_PIPEWIRE
    gboolean ok = check_pipewire_available();
    print_probe_json(ok, TRUE, ok ? NULL : "pipewire_unavailable");
#else
    print_probe_json(FALSE, FALSE, "pipewire_not_compiled");
#endif
    return TRUE;
}

static gboolean run_start(void)
{
#ifdef HAVE_PIPEWIRE
    Helper app = {0};
    app.loop = g_main_loop_new(NULL, FALSE);

    if (!run_pipewire_capture(&app)) {
        cleanup_pipewire(&app);
        g_main_loop_unref(app.loop);
        return FALSE;
    }

    g_main_loop_run(app.loop);

    cleanup_pipewire(&app);
    g_main_loop_unref(app.loop);
    return app.exit_code == 0;
#else
    emit_event("error", "capture_unimplemented",
               "Native PipeWire PCM capture is not compiled into this helper");
    return FALSE;
#endif
}

static void print_usage(void)
{
    fprintf(stderr, "Usage: linux-system-audio-helper <probe|start>\n");
}

int main(int argc, char *argv[])
{
    if (argc != 2) {
        print_usage();
        return 1;
    }

    if (strcmp(argv[1], "probe") == 0) {
        run_probe();
        return 0;
    }

    if (strcmp(argv[1], "start") == 0) {
        return run_start() ? 0 : 2;
    }

    print_usage();
    return 1;
}
