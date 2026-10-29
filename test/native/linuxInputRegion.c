#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/shape.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static Display *display;
static pid_t helper_pid = -1;
static FILE *helper_input;
static FILE *helper_output;

static void cleanup(void)
{
  if (helper_pid > 0) {
    kill(helper_pid, SIGKILL);
    waitpid(helper_pid, NULL, 0);
  }
  if (display) XCloseDisplay(display);
}

static void require(int condition, const char *message)
{
  if (condition) return;
  fprintf(stderr, "%s\n", message);
  exit(1);
}

static void start_helper(const char *binary, Window window)
{
  int requests[2], responses[2];
  require(pipe(requests) == 0 && pipe(responses) == 0, "cannot create helper pipes");
  helper_pid = fork();
  require(helper_pid >= 0, "cannot fork helper");
  if (helper_pid == 0) {
    char window_id[32];
    snprintf(window_id, sizeof(window_id), "%lu", window);
    dup2(requests[0], STDIN_FILENO);
    dup2(responses[1], STDOUT_FILENO);
    close(requests[0]);
    close(requests[1]);
    close(responses[0]);
    close(responses[1]);
    close(ConnectionNumber(display));
    execl(binary, binary, "--capabilities", "--input-region-server", "--window", window_id, NULL);
    _exit(127);
  }
  close(requests[0]);
  close(responses[1]);
  helper_input = fdopen(requests[1], "w");
  helper_output = fdopen(responses[0], "r");
  require(helper_input && helper_output, "cannot open helper streams");
}

static void assert_rectangle(Window window, int kind, int expected_count,
                             int x, int y, int width, int height)
{
  int count, ordering;
  XRectangle *rectangles = XShapeGetRectangles(display, window, kind, &count, &ordering);
  if (count != expected_count ||
      (count == 1 && (rectangles[0].x != x || rectangles[0].y != y ||
                     rectangles[0].width != width || rectangles[0].height != height))) {
    fprintf(stderr, "shape %d: expected %d rectangle(s) at %d,%d %dx%d; got %d",
            kind, expected_count, x, y, width, height, count);
    if (count > 0) {
      fprintf(stderr, " at %d,%d %ux%u", rectangles[0].x, rectangles[0].y,
              rectangles[0].width, rectangles[0].height);
    }
    fprintf(stderr, "\n");
    exit(1);
  }
  if (rectangles) XFree(rectangles);
}

static void send_command(const char *command)
{
  char response[32];
  require(fputs(command, helper_input) >= 0 && fflush(helper_input) == 0, "helper write failed");
  require(fgets(response, sizeof(response), helper_output) != NULL, "helper exited before ACK");
  require(strcmp(response, "OK\n") == 0, "unexpected helper ACK");
}

static void apply(Window window, const char *command, int native_width, int native_height,
                  int count, int x, int y, int width, int height)
{
  send_command(command);
  assert_rectangle(window, ShapeInput, count, x, y, width, height);
  assert_rectangle(window, ShapeBounding, 1, 0, 0, native_width, native_height);
}

static Window focused_window(void)
{
  Window focus;
  int revert_to;
  XGetInputFocus(display, &focus, &revert_to);
  return focus;
}

static int focus_in_delivered(Window window)
{
  XEvent event;
  int delivered = 0;
  XSync(display, False);
  while (XCheckTypedWindowEvent(display, window, FocusIn, &event)) delivered = 1;
  return delivered;
}

/* Stands in for a window manager: answers every pending WM_Sn conversion. */
static void answer_selection_requests(Window owner)
{
  XEvent request;
  XSync(display, False);
  while (XCheckTypedWindowEvent(display, owner, SelectionRequest, &request)) {
    XEvent reply = { 0 };
    reply.xselection.type = SelectionNotify;
    reply.xselection.requestor = request.xselectionrequest.requestor;
    reply.xselection.selection = request.xselectionrequest.selection;
    reply.xselection.target = request.xselectionrequest.target;
    reply.xselection.property = None;
    XSendEvent(display, reply.xselection.requestor, False, 0, &reply);
  }
  XSync(display, False);
}

static long elapsed_ms(const struct timespec *since)
{
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - since->tv_sec) * 1000L + (now.tv_nsec - since->tv_nsec) / 1000000L;
}

static void assert_click_target(Window expected, int x, int y)
{
  XWarpPointer(display, None, DefaultRootWindow(display), 0, 0, 0, 0, 20 + x, 20 + y);
  XTestFakeButtonEvent(display, 1, True, CurrentTime);
  XTestFakeButtonEvent(display, 1, False, CurrentTime);
  XSync(display, False);
  int clicks = 0;
  while (XPending(display)) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type != ButtonPress) continue;
    require(event.xbutton.window == expected, "click delivered to the wrong input region");
    clicks += 1;
  }
  require(clicks == 1, "expected one native click");
}

int main(int argc, char **argv)
{
  require(argc == 2, "expected compiled helper path");
  atexit(cleanup);
  alarm(8);
  display = XOpenDisplay(NULL);
  require(display != NULL, "cannot open the isolated test display");
  Window root = DefaultRootWindow(display);
  Window background = XCreateSimpleWindow(display, root, 20, 20, 416, 240, 0, 0, 0);
  Window foreground = XCreateSimpleWindow(display, root, 20, 20, 208, 120, 0, 0, 0);
  XSelectInput(display, background, ButtonPressMask);
  XSelectInput(display, foreground, ButtonPressMask | FocusChangeMask);
  XMapWindow(display, background);
  XMapRaised(display, foreground);
  XSync(display, False);
  start_helper(argv[1], foreground);

  apply(foreground, "208 120 156 68 40 40\n", 208, 120, 1, 156, 68, 40, 40);
  assert_click_target(foreground, 170, 80);
  assert_click_target(background, 10, 10);

  XResizeWindow(display, foreground, 416, 240);
  XSync(display, False);
  apply(foreground, "208 120 156 68 40 40\n", 416, 240, 1, 312, 136, 80, 80);
  assert_click_target(foreground, 340, 160);
  assert_click_target(background, 170, 80);

  apply(foreground, "208 120 -1.25 10.25 11.5 5.25\n", 416, 240, 1, 0, 20, 21, 11);
  apply(foreground, "208 120 200.25 115.25 20 20\n", 416, 240, 1, 400, 230, 16, 10);
  apply(foreground, "208 120 156.25 68.25 0 0\n", 416, 240, 0, 0, 0, 0, 0);
  assert_click_target(background, 340, 160);
  apply(foreground, "full\n", 416, 240, 1, 0, 0, 416, 240);
  assert_click_target(foreground, 10, 10);

  /* No window manager owns WM_S0 here, so the server answers the round trip. */
  send_command("focus\n");
  require(focused_window() == foreground, "focus did not reach the window");
  focus_in_delivered(foreground);
  send_command("focus\n");
  require(focused_window() == foreground, "focusing again lost the window");
  require(focus_in_delivered(foreground),
          "focusing a window that already has X focus sent no FocusIn");

  /* A window manager that answers after the helper gave up waiting must not
   * satisfy the next round trip with that late reply. */
  Window manager = XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0);
  char selection_name[16];
  snprintf(selection_name, sizeof(selection_name), "WM_S%d", DefaultScreen(display));
  Atom selection = XInternAtom(display, selection_name, False);
  XSetSelectionOwner(display, selection, manager, CurrentTime);
  XSync(display, False);
  send_command("focus\n");
  answer_selection_requests(manager);
  struct timespec started;
  clock_gettime(CLOCK_MONOTONIC, &started);
  send_command("focus\n");
  require(elapsed_ms(&started) >= 50, "a late window manager reply ended a later round trip");
  answer_selection_requests(manager);
  XSetSelectionOwner(display, selection, None, CurrentTime);
  XUnmapWindow(display, foreground);
  XSync(display, False);
  send_command("focus\n");
  require(focused_window() != PointerRoot, "focusing an unmapped window dropped X focus");
  XMapRaised(display, foreground);
  XSync(display, False);
  apply(foreground, "full\n", 416, 240, 1, 0, 0, 416, 240);

  require(fclose(helper_input) == 0, "cannot close helper input");
  int status;
  require(waitpid(helper_pid, &status, 0) == helper_pid, "cannot wait for helper exit");
  helper_pid = -1;
  require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "helper did not exit cleanly on EOF");
  fclose(helper_output);
  puts("input region native checks passed");
  return 0;
}
