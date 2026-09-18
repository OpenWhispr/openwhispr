#include <X11/XKBlib.h>

/* Preloaded into the helper to stand in for an X server whose XKB state cannot
 * be queried: every XkbGetState call fails. */
int XkbGetState(Display *display, unsigned int device_spec, XkbStatePtr state)
{
  (void)display;
  (void)device_spec;
  (void)state;
  return BadAccess;
}
