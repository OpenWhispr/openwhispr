#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <glib.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifdef HAVE_PIPEWIRE
#include <glib-unix.h>
#include <pipewire/pipewire.h>
#include <pipewire/extensions/metadata.h>
#include <spa/param/audio/format-utils.h>
#include <spa/param/props.h>
#endif

#define TARGET_SAMPLE_RATE 24000
#define TARGET_CHANNELS 1
#define TARGET_SAMPLE_BYTES 2
#define AUDIO_PIPE_READ 0
#define AUDIO_PIPE_WRITE 1
#define AUDIO_DRAIN_BUFFER_SIZE 16384
#define AUDIO_FRAME_BYTES (TARGET_CHANNELS * TARGET_SAMPLE_BYTES)
#define AUDIO_PIPE_CHUNK_SIZE ((uint32_t)((PIPE_BUF / AUDIO_FRAME_BYTES) * AUDIO_FRAME_BYTES))
#define DEFAULT_METADATA_NAME "default"
#define DEFAULT_AUDIO_SINK_KEY "default.audio.sink"
#define DEFAULT_SINK_RESOLVE_TIMEOUT_NS (500 * SPA_NSEC_PER_MSEC)

typedef struct {
    GMainLoop *loop;
    int exit_code;
#ifdef HAVE_PIPEWIRE
    struct pw_thread_loop *pw_loop;
    struct pw_stream *pw_stream;
    int audio_pipe_fds[2];
    guint audio_source_id;
    gint audio_dropped_bytes; /* atomic; RT thread increments, main loop reads */
    gboolean drop_warning_emitted;
    gboolean stream_format_ok;
    gboolean start_event_emitted;
#endif
} Helper;

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

typedef struct {
    struct pw_thread_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_registry *registry;
    struct pw_metadata *metadata;
    struct spa_hook core_listener;
    struct spa_hook registry_listener;
    struct spa_hook metadata_listener;
    gchar *sink_name;
    int sync_seq;
    gboolean done;
    gboolean loop_started;
} DefaultSinkResolver;

static void init_pipewire_state(Helper *app)
{
    app->audio_pipe_fds[AUDIO_PIPE_READ] = -1;
    app->audio_pipe_fds[AUDIO_PIPE_WRITE] = -1;
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

static gchar *extract_metadata_name_value(const char *value)
{
    const char *cursor;
    const char *trimmed;
    GString *name;

    if (!value || !*value) {
        return NULL;
    }

    trimmed = value;
    while (g_ascii_isspace(*trimmed)) {
        trimmed++;
    }

    cursor = strstr(value, "\"name\"");
    if (!cursor) {
        return *trimmed && *trimmed != '{' ? g_strdup(trimmed) : NULL;
    }

    cursor = strchr(cursor, ':');
    if (!cursor) {
        return NULL;
    }

    cursor = strchr(cursor, '"');
    if (!cursor) {
        return NULL;
    }
    cursor++;

    name = g_string_new(NULL);
    for (; *cursor; cursor++) {
        if (*cursor == '"') {
            break;
        }

        if (*cursor == '\\' && cursor[1]) {
            cursor++;
            switch (*cursor) {
                case '"':
                case '\\':
                case '/':
                    g_string_append_c(name, *cursor);
                    break;
                case 'b':
                    g_string_append_c(name, '\b');
                    break;
                case 'f':
                    g_string_append_c(name, '\f');
                    break;
                case 'n':
                    g_string_append_c(name, '\n');
                    break;
                case 'r':
                    g_string_append_c(name, '\r');
                    break;
                case 't':
                    g_string_append_c(name, '\t');
                    break;
                default:
                    g_string_append_c(name, *cursor);
                    break;
            }
            continue;
        }

        g_string_append_c(name, *cursor);
    }

    if (*cursor != '"' || name->len == 0) {
        g_string_free(name, TRUE);
        return NULL;
    }

    return g_string_free(name, FALSE);
}

static int on_default_metadata_property(void *data, uint32_t subject, const char *key,
                                        const char *type, const char *value)
{
    (void)subject;
    (void)type;
    DefaultSinkResolver *resolver = data;

    if (!key || strcmp(key, DEFAULT_AUDIO_SINK_KEY) != 0 || !value) {
        return 0;
    }

    g_free(resolver->sink_name);
    resolver->sink_name = extract_metadata_name_value(value);
    if (resolver->sink_name) {
        resolver->done = TRUE;
        pw_thread_loop_signal(resolver->loop, FALSE);
    }

    return 0;
}

static const struct pw_metadata_events default_metadata_events = {
    PW_VERSION_METADATA_EVENTS,
    .property = on_default_metadata_property,
};

static void on_default_registry_global(void *data, uint32_t id, uint32_t permissions,
                                       const char *type, uint32_t version,
                                       const struct spa_dict *props)
{
    (void)permissions;
    DefaultSinkResolver *resolver = data;
    const char *metadata_name;

    if (!type || strcmp(type, PW_TYPE_INTERFACE_Metadata) != 0 || !props ||
        resolver->metadata) {
        return;
    }

    metadata_name = spa_dict_lookup(props, PW_KEY_METADATA_NAME);
    if (!metadata_name || strcmp(metadata_name, DEFAULT_METADATA_NAME) != 0) {
        return;
    }

    uint32_t metadata_version =
        version < (uint32_t)PW_VERSION_METADATA ? version : (uint32_t)PW_VERSION_METADATA;
    resolver->metadata = pw_registry_bind(resolver->registry, id, PW_TYPE_INTERFACE_Metadata,
                                          metadata_version, 0);
    if (resolver->metadata) {
        pw_metadata_add_listener(resolver->metadata, &resolver->metadata_listener,
                                 &default_metadata_events, resolver);
    }
}

static const struct pw_registry_events default_registry_events = {
    PW_VERSION_REGISTRY_EVENTS,
    .global = on_default_registry_global,
};

static void on_default_core_done(void *data, uint32_t id, int seq)
{
    (void)id;
    DefaultSinkResolver *resolver = data;

    if (seq == resolver->sync_seq) {
        resolver->done = TRUE;
        pw_thread_loop_signal(resolver->loop, FALSE);
    }
}

static const struct pw_core_events default_core_events = {
    PW_VERSION_CORE_EVENTS,
    .done = on_default_core_done,
};

static gchar *resolve_default_audio_sink_name(void)
{
    DefaultSinkResolver resolver = {0};
    struct timespec timeout;
    gchar *sink_name = NULL;

    resolver.loop = pw_thread_loop_new("ow-default-sink", NULL);
    if (!resolver.loop) {
        goto out;
    }

    resolver.context = pw_context_new(pw_thread_loop_get_loop(resolver.loop), NULL, 0);
    if (!resolver.context) {
        goto out;
    }

    resolver.core = pw_context_connect(resolver.context, NULL, 0);
    if (!resolver.core) {
        goto out;
    }

    pw_core_add_listener(resolver.core, &resolver.core_listener, &default_core_events, &resolver);
    resolver.registry = pw_core_get_registry(resolver.core, PW_VERSION_REGISTRY, 0);
    if (!resolver.registry) {
        goto out;
    }
    pw_registry_add_listener(resolver.registry, &resolver.registry_listener,
                             &default_registry_events, &resolver);

    if (pw_thread_loop_start(resolver.loop) < 0) {
        goto out;
    }
    resolver.loop_started = TRUE;

    pw_thread_loop_lock(resolver.loop);
    resolver.sync_seq = pw_core_sync(resolver.core, PW_ID_CORE, 0);
    if (resolver.sync_seq >= 0 &&
        pw_thread_loop_get_time(resolver.loop, &timeout, DEFAULT_SINK_RESOLVE_TIMEOUT_NS) == 0) {
        while (!resolver.done && !resolver.sink_name) {
            if (pw_thread_loop_timed_wait_full(resolver.loop, &timeout) != 0) {
                break;
            }
        }
    }
    pw_thread_loop_unlock(resolver.loop);

    if (resolver.sink_name) {
        sink_name = g_strdup(resolver.sink_name);
    }

out:
    if (resolver.loop && resolver.loop_started) {
        pw_thread_loop_lock(resolver.loop);
    }
    if (resolver.metadata) {
        pw_proxy_destroy((struct pw_proxy *)resolver.metadata);
        resolver.metadata = NULL;
    }
    if (resolver.registry) {
        pw_proxy_destroy((struct pw_proxy *)resolver.registry);
        resolver.registry = NULL;
    }
    if (resolver.loop && resolver.loop_started) {
        pw_thread_loop_unlock(resolver.loop);
        pw_thread_loop_stop(resolver.loop);
    }
    if (resolver.core) {
        pw_core_disconnect(resolver.core);
    }
    if (resolver.context) {
        pw_context_destroy(resolver.context);
    }
    if (resolver.loop) {
        pw_thread_loop_destroy(resolver.loop);
    }
    g_free(resolver.sink_name);

    return sink_name;
}

static void close_audio_pipe(Helper *app)
{
    if (app->audio_source_id) {
        g_source_remove(app->audio_source_id);
        app->audio_source_id = 0;
    }

    if (app->audio_pipe_fds[AUDIO_PIPE_READ] >= 0) {
        close(app->audio_pipe_fds[AUDIO_PIPE_READ]);
        app->audio_pipe_fds[AUDIO_PIPE_READ] = -1;
    }

    if (app->audio_pipe_fds[AUDIO_PIPE_WRITE] >= 0) {
        close(app->audio_pipe_fds[AUDIO_PIPE_WRITE]);
        app->audio_pipe_fds[AUDIO_PIPE_WRITE] = -1;
    }
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

static void enqueue_audio_bytes(Helper *app, const uint8_t *data, uint32_t size)
{
    size -= size % AUDIO_FRAME_BYTES;

    /* Nonblocking pipe writes up to PIPE_BUF are atomic, so backpressure drops
     * whole S16 frames instead of splitting samples. */
    while (size > 0) {
        uint32_t chunk_size = size < AUDIO_PIPE_CHUNK_SIZE ? size : AUDIO_PIPE_CHUNK_SIZE;
        ssize_t written = write(app->audio_pipe_fds[AUDIO_PIPE_WRITE], data, chunk_size);

        if (written != (ssize_t)chunk_size) {
            uint32_t dropped = size;

            if (written > 0 && (uint32_t)written <= size) {
                dropped -= (uint32_t)written;
            }

            g_atomic_int_add(&app->audio_dropped_bytes, (gint)dropped);
            return;
        }

        data += chunk_size;
        size -= chunk_size;
    }
}

static void maybe_warn_dropped_audio(Helper *app)
{
    if (app->drop_warning_emitted) {
        return;
    }

    gint dropped_bytes = g_atomic_int_get(&app->audio_dropped_bytes);
    if (dropped_bytes <= 0) {
        return;
    }

    app->drop_warning_emitted = TRUE;
    gchar *message = g_strdup_printf(
        "System audio PCM frames dropped under backpressure (%d bytes so far); "
        "expect gaps in captured audio",
        dropped_bytes);

    emit_event("warning", "audio_frames_dropped", message);
    g_free(message);
}

static gboolean on_audio_pipe_readable(gint fd, GIOCondition condition, gpointer user_data)
{
    Helper *app = user_data;
    uint8_t buffer[AUDIO_DRAIN_BUFFER_SIZE];

    while (TRUE) {
        ssize_t bytes_read = read(fd, buffer, sizeof(buffer));
        if (bytes_read > 0) {
            if (!write_all_stdout(app, buffer, (size_t)bytes_read)) {
                app->audio_source_id = 0;
                return G_SOURCE_REMOVE;
            }
            continue;
        }

        if (bytes_read == 0) {
            app->audio_source_id = 0;
            return G_SOURCE_REMOVE;
        }

        if (errno == EINTR) {
            continue;
        }

        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            break;
        }

        emit_event("error", "audio_pipe_read_failed", g_strerror(errno));
        finish_start(app, 2);
        app->audio_source_id = 0;
        return G_SOURCE_REMOVE;
    }

    maybe_warn_dropped_audio(app);

    if (condition & (G_IO_HUP | G_IO_ERR | G_IO_NVAL)) {
        app->audio_source_id = 0;
        return G_SOURCE_REMOVE;
    }

    return G_SOURCE_CONTINUE;
}

static void maybe_emit_start(Helper *app)
{
    if (!app->stream_format_ok || app->start_event_emitted) {
        return;
    }

    app->start_event_emitted = TRUE;
    emit_event("start", NULL, NULL);
}

static void fail_pipewire_format(Helper *app, const char *message)
{
    emit_event("error", "unsupported_pipewire_format", message);
    finish_start(app, 2);
}

static void on_pw_process(void *userdata)
{
    Helper *app = userdata;
    struct pw_buffer *b = pw_stream_dequeue_buffer(app->pw_stream);
    if (!b) return;

    struct spa_buffer *buf = b->buffer;
    if (!app->stream_format_ok || buf->n_datas == 0 || !buf->datas[0].data ||
        !buf->datas[0].chunk || app->audio_pipe_fds[AUDIO_PIPE_WRITE] < 0) {
        pw_stream_queue_buffer(app->pw_stream, b);
        return;
    }

    const void *src = buf->datas[0].data;
    uint32_t offs = SPA_MIN(buf->datas[0].chunk->offset, buf->datas[0].maxsize);
    uint32_t size = SPA_MIN(buf->datas[0].chunk->size, buf->datas[0].maxsize - offs);

    if (size > 0) {
        const uint8_t *ptr = (const uint8_t *)src + offs;
        enqueue_audio_bytes(app, ptr, size);
    }

    pw_stream_queue_buffer(app->pw_stream, b);
}

static void on_pw_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    Helper *app = userdata;

    if (id != SPA_PARAM_Format || !param) {
        return;
    }

    struct spa_audio_info_raw info;
    if (spa_format_audio_raw_parse(param, &info) < 0) {
        app->stream_format_ok = FALSE;
        fail_pipewire_format(app, "Failed to parse negotiated PipeWire audio format");
        return;
    }

    app->stream_format_ok =
        info.format == SPA_AUDIO_FORMAT_S16_LE &&
        info.rate == TARGET_SAMPLE_RATE &&
        info.channels == TARGET_CHANNELS;

    if (!app->stream_format_ok) {
        gchar *message = g_strdup_printf(
            "Unsupported PipeWire audio format: format=%u rate=%u channels=%u",
            (unsigned int)info.format, info.rate, info.channels);
        fail_pipewire_format(app, message);
        g_free(message);
        return;
    }

    maybe_emit_start(app);
}

static void on_pw_state_changed(void *userdata, enum pw_stream_state old,
                                enum pw_stream_state state, const char *error)
{
    (void)old;
    Helper *app = userdata;

    if (state == PW_STREAM_STATE_ERROR) {
        emit_event("error", "pipewire_error", error ? error : "PipeWire stream error");
        finish_start(app, 2);
    }
}

static const struct pw_stream_events pw_stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .process = on_pw_process,
    .param_changed = on_pw_param_changed,
    .state_changed = on_pw_state_changed,
};

static gboolean on_unix_signal(gpointer user_data)
{
    Helper *app = user_data;
    finish_start(app, 0);
    return G_SOURCE_REMOVE;
}

static gboolean run_pipewire_capture(Helper *app)
{
    init_pipewire_state(app);

    signal(SIGPIPE, SIG_IGN);

    pw_init(NULL, NULL);

    app->pw_loop = pw_thread_loop_new("ow-capture", NULL);
    if (!app->pw_loop) {
        emit_event("error", "pipewire_error", "Failed to create PipeWire loop");
        return FALSE;
    }

    if (pipe2(app->audio_pipe_fds, O_NONBLOCK | O_CLOEXEC) != 0) {
        emit_event("error", "audio_pipe_error", "Failed to create PCM drain pipe");
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
        return FALSE;
    }

    app->audio_source_id = g_unix_fd_add(app->audio_pipe_fds[AUDIO_PIPE_READ],
                                         G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL,
                                         on_audio_pipe_readable, app);
    if (!app->audio_source_id) {
        emit_event("error", "audio_pipe_error", "Failed to register PCM drain source");
        close_audio_pipe(app);
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
        return FALSE;
    }

    gchar *target_sink_name = resolve_default_audio_sink_name();
    struct pw_properties *props = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Audio",
        PW_KEY_MEDIA_CATEGORY, "Capture",
        PW_KEY_MEDIA_ROLE, "Communication",
        PW_KEY_STREAM_CAPTURE_SINK, "true",
        NULL);
    if (props && target_sink_name) {
        pw_properties_set(props, PW_KEY_TARGET_OBJECT, target_sink_name);
    }
    g_free(target_sink_name);

    app->pw_stream = pw_stream_new_simple(
        pw_thread_loop_get_loop(app->pw_loop),
        "openwhispr-system-audio",
        props,
        &pw_stream_events,
        app);

    if (!app->pw_stream) {
        emit_event("error", "pipewire_error", "Failed to create PipeWire stream");
        pw_properties_free(props);
        close_audio_pipe(app);
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
        return FALSE;
    }

    uint8_t params_buffer[1024];
    struct spa_pod_builder b = SPA_POD_BUILDER_INIT(params_buffer, sizeof(params_buffer));
    const struct spa_pod *params[1];
    params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat,
        &SPA_AUDIO_INFO_RAW_INIT(
            .format = SPA_AUDIO_FORMAT_S16_LE,
            .channels = TARGET_CHANNELS,
            .rate = TARGET_SAMPLE_RATE));

    int res = pw_stream_connect(app->pw_stream,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS,
        params, 1);

    if (res < 0) {
        emit_event("error", "pipewire_error", "Failed to connect PipeWire stream");
        pw_stream_destroy(app->pw_stream);
        app->pw_stream = NULL;
        close_audio_pipe(app);
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
        return FALSE;
    }

    if (pw_thread_loop_start(app->pw_loop) < 0) {
        emit_event("error", "pipewire_error", "Failed to start PipeWire loop");
        pw_stream_destroy(app->pw_stream);
        app->pw_stream = NULL;
        close_audio_pipe(app);
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
        return FALSE;
    }

    g_unix_signal_add(SIGTERM, on_unix_signal, app);
    g_unix_signal_add(SIGINT, on_unix_signal, app);

    return TRUE;
}

static void cleanup_pipewire(Helper *app)
{
    if (app->pw_stream) {
        pw_thread_loop_lock(app->pw_loop);
        pw_stream_destroy(app->pw_stream);
        pw_thread_loop_unlock(app->pw_loop);
        app->pw_stream = NULL;
    }
    if (app->pw_loop) {
        pw_thread_loop_stop(app->pw_loop);
        pw_thread_loop_destroy(app->pw_loop);
        app->pw_loop = NULL;
    }
    close_audio_pipe(app);
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
    init_pipewire_state(&app);

    if (!run_pipewire_capture(&app)) {
        g_main_loop_unref(app.loop);
        cleanup_pipewire(&app);
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
