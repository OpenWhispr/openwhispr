#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/shape.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
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

static void apply(Window window, const char *command, int native_width, int native_height,
                  int count, int x, int y, int width, int height)
{
  char response[32];
  require(fputs(command, helper_input) >= 0 && fflush(helper_input) == 0, "helper write failed");
  require(fgets(response, sizeof(response), helper_output) != NULL, "helper exited before ACK");
  require(strcmp(response, "OK\n") == 0, "unexpected helper ACK");
  assert_rectangle(window, ShapeInput, count, x, y, width, height);
  assert_rectangle(window, ShapeBounding, 1, 0, 0, native_width, native_height);
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
  XSelectInput(display, foreground, ButtonPressMask);
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

  require(fclose(helper_input) == 0, "cannot close helper input");
  int status;
  require(waitpid(helper_pid, &status, 0) == helper_pid, "cannot wait for helper exit");
  helper_pid = -1;
  require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "helper did not exit cleanly on EOF");
  fclose(helper_output);
  puts("input region native checks passed");
  return 0;
}
