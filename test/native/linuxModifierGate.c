#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* XTest keys are released when the client that pressed them disconnects, so the
 * fixture keeps its connection open while the helper reads the key state. */
static Display *display;
static char command[1024];

static void require(int condition, const char *message)
{
  if (condition) return;
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static void set_key(KeySym keysym, Bool pressed)
{
  XTestFakeKeyEvent(display, XKeysymToKeycode(display, keysym), pressed, CurrentTime);
  XSync(display, False);
}

static FILE *start_wait(const char *helper, int timeout_ms)
{
  snprintf(command, sizeof(command), "'%s' --capabilities --await-modifier-release %d",
           helper, timeout_ms);
  FILE *output = popen(command, "r");
  require(output != NULL, "cannot start helper");
  return output;
}

static long now_ms(void)
{
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return now.tv_sec * 1000L + now.tv_nsec / 1000000L;
}

static int finish_wait(FILE *output, const char *expected_state, int min_waited_ms,
                       int max_waited_ms)
{
  char state[32];
  int waited_ms = -1;
  int fields = fscanf(output, "MODIFIERS %31s %d", state, &waited_ms);
  require(pclose(output) == 0, "helper exited with an error");
  require(fields == 2, "helper did not report a modifier state");
  if (strcmp(state, expected_state) != 0 || waited_ms < min_waited_ms ||
      waited_ms > max_waited_ms) {
    fprintf(stderr, "expected %s after %d-%dms, got %s after %dms\n", expected_state,
            min_waited_ms, max_waited_ms, state, waited_ms);
    exit(1);
  }
  return waited_ms;
}

int main(int argc, char **argv)
{
  require(argc >= 2, "usage: linuxModifierGate <linux-fast-paste> [xkb-unavailable.so]");
  display = XOpenDisplay(NULL);
  require(display != NULL, "cannot open display");
  const char *helper = argv[1];

  finish_wait(start_wait(helper, 1000), "released", 0, 0);

  set_key(XK_Control_L, True);
  finish_wait(start_wait(helper, 100), "held", 100, 1000);

  /* The reported wait must be wall-clock time: the JS caller kills the helper
   * at timeout + 1s, and a wait that counts sleeps instead of time runs past
   * that on a loaded machine, so the paste would go ahead into the held key. */
  long started_at = now_ms();
  int waited_ms = finish_wait(start_wait(helper, 2000), "held", 2000, 2100);
  long overshoot_ms = now_ms() - started_at - waited_ms;
  if (overshoot_ms < 0 || overshoot_ms > 100) {
    fprintf(stderr, "helper reported %dms but ran %ldms longer than that\n", waited_ms,
            overshoot_ms);
    exit(1);
  }

  FILE *output = start_wait(helper, 3000);
  usleep(200000);
  set_key(XK_Control_L, False);
  finish_wait(output, "released", 150, 1000);

  /* A locked Caps Lock is not a key being held. */
  set_key(XK_Caps_Lock, True);
  set_key(XK_Caps_Lock, False);
  finish_wait(start_wait(helper, 1000), "released", 0, 0);
  set_key(XK_Caps_Lock, True);
  set_key(XK_Caps_Lock, False);

  /* An X server whose XKB state cannot be read is "unknown", never "released":
   * the caller must know the wait was blind. */
  if (argc >= 3) {
    setenv("LD_PRELOAD", argv[2], 1);
    finish_wait(start_wait(helper, 1000), "unknown", 0, 0);
    unsetenv("LD_PRELOAD");
  }

  XCloseDisplay(display);
  printf("modifier gate native checks passed\n");
  return 0;
}
