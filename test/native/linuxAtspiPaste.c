#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <stdio.h>

/* A synthetic accessibility graph keeps this test off the real desktop and bus. */
static GObject *desktop;
static GObject *application;
static GObject *missing_window;
static GObject *active_window;
static AtspiStateSet *active_states;
static const char *application_name;
static int criticals;
static int finalized;

static int fixture_atspi_init(void) { return 0; }
static void fixture_atspi_set_timeout(gint timeout, gint startup_timeout) {}
static AtspiAccessible *fixture_atspi_get_desktop(gint index) {
  return (AtspiAccessible *)desktop;
}
static gint fixture_child_count(AtspiAccessible *object, GError **error) {
  return (GObject *)object == desktop ? 1 : 2;
}
static AtspiAccessible *fixture_child(AtspiAccessible *object, gint index, GError **error) {
  if ((GObject *)object == desktop)
    return (AtspiAccessible *)g_object_ref(application);
  return (AtspiAccessible *)g_object_ref(index == 0 ? missing_window : active_window);
}
static AtspiStateSet *fixture_state_set(AtspiAccessible *object) {
  return (GObject *)object == active_window && active_states
    ? g_object_ref(active_states) : NULL;
}
static gchar *fixture_accessible_name(AtspiAccessible *object, GError **error) {
  return g_strdup(application_name);
}

#define HAVE_ATSPI
#define main fast_paste_main
#define atspi_init fixture_atspi_init
#define atspi_set_timeout fixture_atspi_set_timeout
#define atspi_get_desktop fixture_atspi_get_desktop
#define atspi_accessible_get_child_count fixture_child_count
#define atspi_accessible_get_child_at_index fixture_child
#define atspi_accessible_get_state_set fixture_state_set
#define atspi_accessible_get_name fixture_accessible_name
#include "../../resources/linux-fast-paste.c"
#undef main

static void record_critical(const gchar *domain, GLogLevelFlags level,
                            const gchar *message, gpointer data) {
  criticals++;
}

static void record_finalized(gpointer data, GObject *object) {
  finalized++;
}

static int check_detection(int expected) {
  int result = detect_terminal_atspi();
  if (result != expected || criticals != 0) {
    fprintf(stderr, "expected result=%d without GLib criticals; got result=%d criticals=%d\n",
            expected, result, criticals);
    return 0;
  }
  return 1;
}

int main(void) {
  desktop = g_object_new(G_TYPE_OBJECT, NULL);
  application = g_object_new(G_TYPE_OBJECT, NULL);
  missing_window = g_object_new(G_TYPE_OBJECT, NULL);
  active_window = g_object_new(G_TYPE_OBJECT, NULL);
  g_object_weak_ref(desktop, record_finalized, NULL);
  g_object_weak_ref(application, record_finalized, NULL);
  g_object_weak_ref(missing_window, record_finalized, NULL);
  g_object_weak_ref(active_window, record_finalized, NULL);
  g_log_set_always_fatal(G_LOG_LEVEL_ERROR);
  guint handler = g_log_set_handler("GLib-GObject", G_LOG_LEVEL_CRITICAL,
                                    record_critical, NULL);

  int valid = check_detection(-1);
  active_states = atspi_state_set_new(NULL);
  g_object_weak_ref(G_OBJECT(active_states), record_finalized, NULL);
  atspi_state_set_add(active_states, ATSPI_STATE_ACTIVE);
  application_name = "kitty";
  valid &= check_detection(1);
  application_name = "firefox";
  valid &= check_detection(0);
  atspi_state_set_remove(active_states, ATSPI_STATE_ACTIVE);
  valid &= check_detection(-1);

  g_log_remove_handler("GLib-GObject", handler);
  g_object_unref(active_states);
  g_object_unref(active_window);
  g_object_unref(missing_window);
  g_object_unref(application);
  g_object_unref(desktop);
  if (!valid || finalized != 5) {
    fprintf(stderr, "expected five finalized fixture objects; got %d\n", finalized);
    return 1;
  }
  puts("AT-SPI paste detection and cleanup checks passed");
  return 0;
}
