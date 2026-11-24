#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Stubbed libatspi keeps this test off the real desktop and bus. */
static int inits;
static int inits_with_direct_connections;
static int inits_refusing_the_bus;

/* Opens a connection as libatspi does; reports whether the helper refused it. */
static int connection_refused(void) {
  DBusError error;
  dbus_error_init(&error);
  DBusConnection *connection = dbus_connection_open_private("unix:path=/nonexistent", &error);
  int refused = !connection && dbus_error_has_name(&error, DBUS_ERROR_NOT_SUPPORTED);
  dbus_error_free(&error);
  return refused;
}

/* libatspi reads ATSPI_DISABLE_P2P when it first meets each application, so it
 * must already be set when AT-SPI starts (#3242). It opens the bus itself
 * during atspi_init(), which the helper must let through. */
static int fixture_atspi_init(void) {
  const char *disable_p2p = getenv("ATSPI_DISABLE_P2P");
  inits++;
  if (!disable_p2p || strcmp(disable_p2p, "1") != 0) inits_with_direct_connections++;
  if (connection_refused()) inits_refusing_the_bus++;
  return 0;
}
static void fixture_atspi_set_timeout(gint timeout, gint startup_timeout) {}
static AtspiAccessible *fixture_atspi_get_desktop(gint index) { return NULL; }

#define main text_monitor_main
#define atspi_init fixture_atspi_init
#define atspi_set_timeout fixture_atspi_set_timeout
#define atspi_get_desktop fixture_atspi_get_desktop
#include "../../resources/linux-text-monitor.c"
#undef main

int main(void) {
  char *monitor_argv[] = {"linux-text-monitor", NULL};
  char *probe_argv[] = {"linux-text-monitor", "--probe-editable", "1234", NULL};

  unsetenv("ATSPI_DISABLE_P2P");
  text_monitor_main(1, monitor_argv);
  unsetenv("ATSPI_DISABLE_P2P");
  atspi_started = 0;
  text_monitor_main(3, probe_argv);

  if (inits != 2 || inits_with_direct_connections != 0) {
    fprintf(stderr,
            "expected both modes to start AT-SPI with direct application connections "
            "disabled; %d of %d starts had them enabled\n",
            inits_with_direct_connections, inits);
    return 1;
  }
  if (inits_refusing_the_bus != 0 || !connection_refused()) {
    fprintf(stderr, "expected the bus to open during AT-SPI start and direct connections "
                    "to be refused after\n");
    return 1;
  }
  puts("AT-SPI text monitor connection checks passed");
  return 0;
}
