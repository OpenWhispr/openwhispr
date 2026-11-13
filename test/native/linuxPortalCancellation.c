#define _GNU_SOURCE
#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

/* Keep the real portal state machine and key sequence, replacing only D-Bus
 * transport so these checks never connect to the user's desktop. */
enum FixtureScenario {
  CANCEL_WHILE_WAITING,
  CANCEL_AT_APPROVAL,
  CANCEL_AFTER_KEYDOWN,
  ORDINARY_WITH_CLOSED_STDIN,
  COMPLETE_WITH_OPEN_STDIN
};

typedef struct {
  gint32 keysym;
  guint32 pressed;
} FixtureKey;

typedef struct {
  GDBusSignalCallback callback;
  gpointer data;
  const char *method;
} FixtureResponse;

static enum FixtureScenario scenario;
static int input_writer = -1;
static int half_close_input;
static int input_closed;
static FixtureKey keys[8];
static size_t key_count;
static GDBusSignalCallback response_callback;
static gpointer response_data;

static void require(int condition, const char *message)
{
  if (condition) return;
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static void close_input(void)
{
  if (input_closed) return;
  if (half_close_input) {
    require(shutdown(input_writer, SHUT_WR) == 0, "cannot half-close fixture input");
  } else {
    require(close(input_writer) == 0, "cannot close fixture input");
    input_writer = -1;
  }
  input_closed = 1;
}

static gboolean cancel_wait(gpointer data)
{
  close_input();
  return G_SOURCE_REMOVE;
}

static gboolean deliver_response(gpointer data)
{
  FixtureResponse *response = data;
  if (strcmp(response->method, "Start") == 0 && scenario == CANCEL_AT_APPROVAL)
    close_input();

  GVariantBuilder results;
  g_variant_builder_init(&results, G_VARIANT_TYPE("a{sv}"));
  if (strcmp(response->method, "CreateSession") == 0) {
    g_variant_builder_add(&results, "{sv}", "session_handle",
                          g_variant_new_string("/fixture/session"));
  }
  GVariant *parameters = g_variant_ref_sink(g_variant_new(
    "(u@a{sv})", 0u, g_variant_builder_end(&results)));
  response->callback(NULL, "fixture", "/fixture/request", "fixture", "Response",
                     parameters, response->data);
  g_variant_unref(parameters);
  free(response);
  return G_SOURCE_REMOVE;
}

static GDBusConnection *fixture_bus_get(GBusType type, GCancellable *cancellable,
                                        GError **error)
{
  return (GDBusConnection *)g_object_new(G_TYPE_OBJECT, NULL);
}

static const gchar *fixture_unique_name(GDBusConnection *connection)
{
  return ":1.1";
}

static guint fixture_subscribe(GDBusConnection *connection, const gchar *sender,
                               const gchar *interface_name, const gchar *member,
                               const gchar *object_path, const gchar *arg0,
                               GDBusSignalFlags flags, GDBusSignalCallback callback,
                               gpointer user_data, GDestroyNotify destroy_notify)
{
  response_callback = callback;
  response_data = user_data;
  return 1;
}

static void fixture_unsubscribe(GDBusConnection *connection, guint subscription_id) {}

static GVariant *fixture_call(GDBusConnection *connection, const gchar *bus_name,
                              const gchar *object_path, const gchar *interface_name,
                              const gchar *method_name, GVariant *parameters,
                              const GVariantType *reply_type, GDBusCallFlags flags,
                              gint timeout, GCancellable *cancellable, GError **error)
{
  if (strcmp(method_name, "NotifyKeyboardKeysym") == 0) {
    const gchar *session;
    GVariant *options;
    gint32 keysym;
    guint32 pressed;
    g_variant_get(parameters, "(&o@a{sv}iu)", &session, &options, &keysym, &pressed);
    g_variant_unref(options);
    require(key_count < G_N_ELEMENTS(keys), "too many key events");
    keys[key_count++] = (FixtureKey){ keysym, pressed };
    if (scenario == CANCEL_AFTER_KEYDOWN && key_count == 1) close_input();
    return g_variant_ref_sink(g_variant_new("()"));
  }

  require(strcmp(method_name, "CreateSession") == 0 ||
          strcmp(method_name, "SelectDevices") == 0 ||
          strcmp(method_name, "Start") == 0, "unexpected portal method");
  FixtureResponse *response = malloc(sizeof(*response));
  require(response != NULL, "cannot allocate fixture response");
  *response = (FixtureResponse){ response_callback, response_data, method_name };
  if (strcmp(method_name, "Start") == 0 && scenario == CANCEL_WHILE_WAITING) {
    g_idle_add(cancel_wait, NULL);
    g_timeout_add(100, deliver_response, response);
  } else {
    g_idle_add(deliver_response, response);
  }
  return NULL;
}

#define HAVE_GIO
#define main fast_paste_main
#define g_bus_get_sync fixture_bus_get
#define g_dbus_connection_get_unique_name fixture_unique_name
#define g_dbus_connection_signal_subscribe fixture_subscribe
#define g_dbus_connection_signal_unsubscribe fixture_unsubscribe
#define g_dbus_connection_call_sync fixture_call
#include "../../resources/linux-fast-paste.c"
#undef main

static void check_scenario(enum FixtureScenario selected, paste_mode_t mode, int socket_input)
{
  scenario = selected;
  half_close_input = socket_input;
  int input[2];
  require((socket_input ? socketpair(AF_UNIX, SOCK_STREAM, 0, input) : pipe(input)) == 0,
          "cannot create fixture input");
  require(dup2(input[0], STDIN_FILENO) == STDIN_FILENO, "cannot install fixture input");
  close(input[0]);
  input_writer = input[1];
  if (scenario == ORDINARY_WITH_CLOSED_STDIN) close_input();

  char *arguments[] = {
    "linux-fast-paste", "--portal", NULL, NULL, NULL
  };
  int count = 2;
  if (scenario != ORDINARY_WITH_CLOSED_STDIN)
    arguments[count++] = "--cancel-on-stdin-close";
  if (mode == PASTE_MODE_SHIFT_INSERT) arguments[count++] = "--shift-insert";
  if (mode == PASTE_MODE_CTRL_SHIFT_V) arguments[count++] = "--terminal";

  int result = fast_paste_main(count, arguments);
  close_input();
  if (input_writer >= 0) close(input_writer);
  if (scenario == CANCEL_WHILE_WAITING || scenario == CANCEL_AT_APPROVAL) {
    require(key_count == 0, "cancelled portal approval still dispatched keyboard input");
    require(result == 7, "cancelled portal approval did not report cancellation");
    return;
  }

  require(result == 0, "a dispatched or ordinary paste did not finish successfully");
  const FixtureKey control_v[] = {
    { XK_Control_L, 1 }, { XK_v, 1 }, { XK_v, 0 }, { XK_Control_L, 0 }
  };
  const FixtureKey control_shift_v[] = {
    { XK_Control_L, 1 }, { XK_Shift_L, 1 }, { XK_v, 1 },
    { XK_v, 0 }, { XK_Shift_L, 0 }, { XK_Control_L, 0 }
  };
  const FixtureKey shift_insert[] = {
    { XK_Shift_L, 1 }, { XK_Insert, 1 }, { XK_Insert, 0 }, { XK_Shift_L, 0 }
  };
  const FixtureKey *expected = mode == PASTE_MODE_SHIFT_INSERT ? shift_insert :
    mode == PASTE_MODE_CTRL_SHIFT_V ? control_shift_v : control_v;
  size_t expected_count = mode == PASTE_MODE_CTRL_SHIFT_V ? 6 : 4;
  require(key_count == expected_count, "paste interrupted before completing its key sequence");
  for (size_t index = 0; index < expected_count; index++) {
    require(keys[index].keysym == expected[index].keysym &&
            keys[index].pressed == expected[index].pressed,
            "paste changed its key sequence or left a modifier pressed");
  }
}

int main(void)
{
  require(setenv("DISPLAY", "", 1) == 0, "cannot isolate the fixture display");
  /* Node closes its child's socket write side: EOF can be readable without HUP. */
  for (int socket_input = 0; socket_input <= 1; socket_input++) {
    for (int selected = CANCEL_WHILE_WAITING; selected <= COMPLETE_WITH_OPEN_STDIN; selected++) {
      for (int mode = PASTE_MODE_CTRL_V; mode <= PASTE_MODE_SHIFT_INSERT; mode++) {
        pid_t child = fork();
        require(child >= 0, "cannot fork fixture case");
        if (child == 0) {
          alarm(3);
          g_log_set_always_fatal(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL);
          check_scenario(selected, mode, socket_input);
          exit(0);
        }
        int status;
        require(waitpid(child, &status, 0) == child, "cannot wait for fixture case");
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
          fprintf(stderr, "portal fixture failed: socket=%d scenario=%d mode=%d status=%d\n",
                  socket_input, selected, mode, status);
          return 1;
        }
      }
    }
  }
  puts("portal cancellation and complete key-release checks passed");
  return 0;
}
