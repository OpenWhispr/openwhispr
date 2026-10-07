// Re-joins an overlay panel to every Space of its display.
//
// The dictation pill and the Agent companion are Electron `type: "panel"`
// windows. ElectronNSPanel ORs NSWindowCollectionBehaviorCanJoinAllSpaces into
// every -setCollectionBehavior: call, so the bit never changes, and AppKit only
// re-registers a window's Spaces with the window server when it does. Once a
// display reconfiguration pins a hidden panel to one Space, nothing Electron
// exposes brings it back. NSWindow's own implementation, called with the bit
// cleared and then the original behavior, makes AppKit re-apply it.
//
//   reassertAllSpaces(handle: Buffer) -> boolean
//
// `handle` is BrowserWindow#getNativeWindowHandle() (an NSView*). Anything else,
// or a call off the main thread, returns false without touching a window. No
// reference to the window outlives the call.
#include <node_api.h>
#include <string.h>
#import <AppKit/AppKit.h>
#include <objc/runtime.h>

typedef void (*SetCollectionBehaviorIMP)(id, SEL, NSWindowCollectionBehavior);

static NSWindow *WindowFromHandle(napi_env env, napi_value handle) {
  bool isBuffer = false;
  void *data = NULL;
  size_t length = 0;
  if (napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer) return nil;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok) return nil;
  if (length != sizeof(void *)) return nil;
  void *pointer = NULL;
  memcpy(&pointer, data, sizeof(pointer));
  id view = (id)pointer;
  if (!view || ![view isKindOfClass:[NSView class]]) return nil;
  return [(NSView *)view window];
}

static void ToggleCanJoinAllSpaces(NSWindow *window) {
  SEL selector = @selector(setCollectionBehavior:);
  // NSWindow's implementation, not the panel's override of it.
  SetCollectionBehaviorIMP setCollectionBehavior =
      (SetCollectionBehaviorIMP)class_getMethodImplementation([NSWindow class], selector);
  NSWindowCollectionBehavior behavior = window.collectionBehavior;
  @try {
    setCollectionBehavior(window, selector,
                          behavior & ~NSWindowCollectionBehaviorCanJoinAllSpaces);
  } @finally {
    setCollectionBehavior(window, selector, behavior);
  }
}

static napi_value ReassertAllSpaces(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  bool reasserted = false;
  if ([NSThread isMainThread] &&
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == napi_ok) {
    @autoreleasepool {
      @try {
        NSWindow *window = WindowFromHandle(env, argv[0]);
        if (window) {
          ToggleCanJoinAllSpaces(window);
          reasserted = true;
        }
      } @catch (NSException *exception) {
        // An exception must not reach JS: the caller shows the window anyway.
      }
    }
  }
  napi_value result;
  napi_get_boolean(env, reasserted, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "reassertAllSpaces", NAPI_AUTO_LENGTH, ReassertAllSpaces, NULL,
                       &function);
  napi_set_named_property(env, exports, "reassertAllSpaces", function);
  return exports;
}
