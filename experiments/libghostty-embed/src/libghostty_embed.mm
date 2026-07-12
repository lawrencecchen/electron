#import <Cocoa/Cocoa.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>

#include <node_api.h>

#include "ghostty.h"

struct GhosttyHost;

@interface GhosttyTerminalView : NSView
@property(nonatomic, assign) GhosttyHost* ghosttyHost;
@end

struct GhosttyHost {
  ghostty_config_t config = nullptr;
  ghostty_app_t app = nullptr;
  ghostty_surface_t surface = nullptr;
  __strong GhosttyTerminalView* view = nil;
  std::atomic<bool> closing = false;
  std::atomic<bool> finalizer_called = false;
  std::atomic<uint32_t> pending_wakeups = 0;
};

void UpdateSurfaceSize(GhosttyHost* host) {
  if (!host || !host->surface || !host->view.window)
    return;

  const NSRect backing = [host->view convertRectToBacking:host->view.bounds];
  const CGFloat scale = host->view.window.backingScaleFactor;
  ghostty_surface_set_content_scale(host->surface, scale, scale);
  ghostty_surface_set_size(host->surface,
                           static_cast<uint32_t>(NSWidth(backing)),
                           static_cast<uint32_t>(NSHeight(backing)));
}

ghostty_input_mods_e GhosttyMods(NSEventModifierFlags flags) {
  int mods = GHOSTTY_MODS_NONE;
  if (flags & NSEventModifierFlagShift)
    mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl)
    mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption)
    mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand)
    mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock)
    mods |= GHOSTTY_MODS_CAPS;
  if (flags & NSEventModifierFlagNumericPad)
    mods |= GHOSTTY_MODS_NUM;
  return static_cast<ghostty_input_mods_e>(mods);
}

void SendMousePosition(GhosttyHost* host,
                       GhosttyTerminalView* view,
                       NSEvent* event) {
  if (!host || !host->surface)
    return;
  const NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(host->surface, point.x, point.y,
                            GhosttyMods(event.modifierFlags));
}

@implementation GhosttyTerminalView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  for (NSTrackingArea* area in self.trackingAreas) {
    [self removeTrackingArea:area];
  }
  NSTrackingAreaOptions options =
      NSTrackingMouseEnteredAndExited | NSTrackingMouseMoved |
      NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect;
  [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:NSZeroRect
                                                     options:options
                                                       owner:self
                                                    userInfo:nil]];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  UpdateSurfaceSize(self.ghosttyHost);
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  UpdateSurfaceSize(self.ghosttyHost);
}

- (void)mouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  ghostty_surface_set_focus(host->surface, true);
  SendMousePosition(host, self, event);
  ghostty_surface_mouse_button(host->surface, GHOSTTY_MOUSE_PRESS,
                               GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseUp:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  SendMousePosition(host, self, event);
  ghostty_surface_mouse_button(host->surface, GHOSTTY_MOUSE_RELEASE,
                               GHOSTTY_MOUSE_LEFT,
                               GhosttyMods(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent*)event {
  SendMousePosition(self.ghosttyHost, self, event);
}

- (void)mouseDragged:(NSEvent*)event {
  SendMousePosition(self.ghosttyHost, self, event);
}

- (void)rightMouseDragged:(NSEvent*)event {
  SendMousePosition(self.ghosttyHost, self, event);
}

- (void)copyTerminalSelection:(id)sender {
  (void)sender;
  static constexpr char action[] = "copy_to_clipboard";
  if (self.ghosttyHost && self.ghosttyHost->surface) {
    ghostty_surface_binding_action(self.ghosttyHost->surface, action,
                                   sizeof(action) - 1);
  }
}

- (void)pasteIntoTerminal:(id)sender {
  (void)sender;
  static constexpr char action[] = "paste_from_clipboard";
  if (self.ghosttyHost && self.ghosttyHost->surface) {
    ghostty_surface_binding_action(self.ghosttyHost->surface, action,
                                   sizeof(action) - 1);
  }
}

- (NSMenu*)terminalContextMenu {
  NSMenu* menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItemWithTitle:@"Copy"
                  action:@selector(copyTerminalSelection:)
           keyEquivalent:@""];
  [menu addItemWithTitle:@"Paste"
                  action:@selector(pasteIntoTerminal:)
           keyEquivalent:@""];
  for (NSMenuItem* item in menu.itemArray)
    item.target = self;
  return menu;
}

- (void)rightMouseDown:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  [self.window makeFirstResponder:self];
  SendMousePosition(host, self, event);
  const bool consumed = ghostty_surface_mouse_button(
      host->surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_RIGHT,
      GhosttyMods(event.modifierFlags));
  if (!consumed) {
    [NSMenu popUpContextMenu:self.terminalContextMenu
                   withEvent:event
                     forView:self];
  }
}

- (void)rightMouseUp:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  SendMousePosition(host, self, event);
  ghostty_surface_mouse_button(host->surface, GHOSTTY_MOUSE_RELEASE,
                               GHOSTTY_MOUSE_RIGHT,
                               GhosttyMods(event.modifierFlags));
}

- (void)keyDown:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;

  ghostty_input_key_s key = {};
  key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  key.keycode = event.keyCode;
  key.mods = GhosttyMods(event.modifierFlags);
  const int consumed =
      static_cast<int>(key.mods) & ~(GHOSTTY_MODS_CTRL | GHOSTTY_MODS_SUPER);
  key.consumed_mods = static_cast<ghostty_input_mods_e>(consumed);

  NSString* characters = event.characters;
  NSData* utf8 = [characters dataUsingEncoding:NSUTF8StringEncoding];
  const uint8_t* bytes = static_cast<const uint8_t*>(utf8.bytes);
  if (utf8.length > 0 && bytes[0] >= 0x20 && bytes[0] != 0x7f) {
    std::string text(static_cast<const char*>(utf8.bytes), utf8.length);
    key.text = text.c_str();
    ghostty_surface_key(host->surface, key);
  } else {
    ghostty_surface_key(host->surface, key);
  }
}

- (void)keyUp:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  ghostty_input_key_s key = {};
  key.action = GHOSTTY_ACTION_RELEASE;
  key.keycode = event.keyCode;
  key.mods = GhosttyMods(event.modifierFlags);
  ghostty_surface_key(host->surface, key);
}

- (void)scrollWheel:(NSEvent*)event {
  GhosttyHost* host = self.ghosttyHost;
  if (!host || !host->surface)
    return;
  ghostty_surface_mouse_scroll(host->surface, event.scrollingDeltaX,
                               event.scrollingDeltaY, 0);
}

@end

void Throw(napi_env env, const char* message) {
  napi_throw_error(env, "ERR_GHOSTTY_EMBED", message);
}

bool GetNamedDouble(napi_env env,
                    napi_value object,
                    const char* name,
                    double* result) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok)
    return false;
  return napi_get_value_double(env, value, result) == napi_ok;
}

std::string GetNamedString(napi_env env, napi_value object, const char* name) {
  napi_value value;
  if (napi_get_named_property(env, object, name, &value) != napi_ok)
    return {};

  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok)
    return {};

  std::string result(length + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), length + 1, &length);
  result.resize(length);
  return result;
}

NSRect FrameForBounds(NSView* parent,
                      double x,
                      double y,
                      double width,
                      double height) {
  const double native_y =
      parent.isFlipped ? y : NSHeight(parent.bounds) - y - height;
  return NSMakeRect(x, native_y, width, height);
}

void DeleteFinalizedHostIfIdle(GhosttyHost* host) {
  if (host->finalizer_called.load(std::memory_order_acquire) &&
      host->pending_wakeups.load(std::memory_order_acquire) == 0) {
    delete host;
  }
}

void Wakeup(void* userdata) {
  auto* host = static_cast<GhosttyHost*>(userdata);
  host->pending_wakeups.fetch_add(1, std::memory_order_acq_rel);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!host->closing.load(std::memory_order_acquire) && host->app) {
      ghostty_app_tick(host->app);
    }
    const uint32_t previous =
        host->pending_wakeups.fetch_sub(1, std::memory_order_acq_rel);
    if (previous == 1)
      DeleteFinalizedHostIfIdle(host);
  });
}

bool Action(ghostty_app_t, ghostty_target_s, ghostty_action_s) {
  return false;
}

bool ReadClipboard(void* userdata, ghostty_clipboard_e, void* state) {
  auto* host = static_cast<GhosttyHost*>(userdata);
  if (!host || !host->surface)
    return false;
  NSString* value =
      [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
  if (!value)
    return false;
  ghostty_surface_complete_clipboard_request(host->surface, value.UTF8String,
                                             state, false);
  return true;
}

void ConfirmReadClipboard(void* userdata,
                          const char* value,
                          void* state,
                          ghostty_clipboard_request_e request) {
  (void)request;
  auto* host = static_cast<GhosttyHost*>(userdata);
  if (!host || !host->surface)
    return;
  ghostty_surface_complete_clipboard_request(host->surface, value, state, true);
}

void WriteClipboard(void*,
                    ghostty_clipboard_e,
                    const ghostty_clipboard_content_s* content,
                    size_t length,
                    bool) {
  for (size_t index = 0; index < length; ++index) {
    if (strcmp(content[index].mime, "text/plain") != 0)
      continue;
    NSPasteboard* pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard clearContents];
    [pasteboard setString:[NSString stringWithUTF8String:content[index].data]
                  forType:NSPasteboardTypeString];
    return;
  }
}

void CloseSurface(void*, bool) {}

bool EnsureGhosttyInitialized() {
  static std::once_flag once;
  static int result = -1;
  std::call_once(once, [] {
    char process_name[] = "electron-libghostty";
    char* argv[] = {process_name};
    result = ghostty_init(1, argv);
  });
  return result == GHOSTTY_SUCCESS;
}

void DestroyHostResources(GhosttyHost* host) {
  if (!host || host->closing.exchange(true, std::memory_order_acq_rel))
    return;
  if (host->view) {
    host->view.ghosttyHost = nullptr;
    [host->view removeFromSuperview];
    host->view = nil;
  }
  if (host->surface) {
    ghostty_surface_free(host->surface);
    host->surface = nullptr;
  }
  if (host->app) {
    ghostty_app_free(host->app);
    host->app = nullptr;
  }
  if (host->config) {
    ghostty_config_free(host->config);
    host->config = nullptr;
  }
}

void FinalizeHost(napi_env, void* data, void*) {
  auto* host = static_cast<GhosttyHost*>(data);
  DestroyHostResources(host);
  host->finalizer_called.store(true, std::memory_order_release);
  DeleteFinalizedHostIfIdle(host);
}

napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    Throw(env, "create expects a native window handle and bounds/options");
    return nullptr;
  }

  void* handle_data = nullptr;
  size_t handle_size = 0;
  if (napi_get_buffer_info(env, args[0], &handle_data, &handle_size) !=
          napi_ok ||
      handle_size != sizeof(NSView*)) {
    Throw(env, "Expected BrowserWindow.getNativeWindowHandle() on macOS");
    return nullptr;
  }

  void* raw_parent = *static_cast<void**>(handle_data);
  NSView* parent = (__bridge NSView*)raw_parent;
  if (!parent) {
    Throw(env, "Electron returned a null native parent view");
    return nullptr;
  }

  double x = 0;
  double y = 0;
  double width = 800;
  double height = 600;
  if (!GetNamedDouble(env, args[1], "x", &x) ||
      !GetNamedDouble(env, args[1], "y", &y) ||
      !GetNamedDouble(env, args[1], "width", &width) ||
      !GetNamedDouble(env, args[1], "height", &height)) {
    Throw(env, "Bounds must contain numeric x, y, width, and height");
    return nullptr;
  }

  if (!EnsureGhosttyInitialized()) {
    Throw(env, "ghostty_init failed");
    return nullptr;
  }

  auto* host = new GhosttyHost();
  host->config = ghostty_config_new();
  if (!host->config) {
    delete host;
    Throw(env, "ghostty_config_new failed");
    return nullptr;
  }
  ghostty_config_load_default_files(host->config);
  ghostty_config_finalize(host->config);

  ghostty_runtime_config_s runtime = {};
  runtime.userdata = host;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = Wakeup;
  runtime.action_cb = Action;
  runtime.read_clipboard_cb = ReadClipboard;
  runtime.confirm_read_clipboard_cb = ConfirmReadClipboard;
  runtime.write_clipboard_cb = WriteClipboard;
  runtime.close_surface_cb = CloseSurface;
  host->app = ghostty_app_new(&runtime, host->config);
  if (!host->app) {
    ghostty_config_free(host->config);
    delete host;
    Throw(env, "ghostty_app_new failed");
    return nullptr;
  }

  host->view = [[GhosttyTerminalView alloc]
      initWithFrame:FrameForBounds(parent, x, y, width, height)];
  host->view.ghosttyHost = host;
  [parent addSubview:host->view positioned:NSWindowAbove relativeTo:nil];

  const std::string working_directory =
      GetNamedString(env, args[1], "workingDirectory");
  const std::string command = GetNamedString(env, args[1], "command");

  ghostty_surface_config_s surface = ghostty_surface_config_new();
  surface.platform_tag = GHOSTTY_PLATFORM_MACOS;
  surface.platform.macos.nsview = (__bridge void*)host->view;
  surface.userdata = host;
  surface.scale_factor = parent.window.backingScaleFactor ?: 1.0;
  surface.working_directory =
      working_directory.empty() ? nullptr : working_directory.c_str();
  surface.command = command.empty() ? nullptr : command.c_str();
  host->surface = ghostty_surface_new(host->app, &surface);
  if (!host->surface) {
    DestroyHostResources(host);
    host->finalizer_called.store(true, std::memory_order_release);
    DeleteFinalizedHostIfIdle(host);
    Throw(env, "ghostty_surface_new failed");
    return nullptr;
  }

  ghostty_app_set_focus(host->app, true);
  ghostty_surface_set_focus(host->surface, true);
  UpdateSurfaceSize(host);

  napi_value external;
  napi_create_external(env, host, FinalizeHost, nullptr, &external);
  return external;
}

napi_value SetBounds(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    Throw(env, "setBounds expects a terminal handle and bounds");
    return nullptr;
  }

  GhosttyHost* host = nullptr;
  if (napi_get_value_external(env, args[0], reinterpret_cast<void**>(&host)) !=
          napi_ok ||
      !host || host->closing.load(std::memory_order_acquire) || !host->view ||
      !host->view.superview) {
    Throw(env, "Invalid terminal handle");
    return nullptr;
  }

  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  if (!GetNamedDouble(env, args[1], "x", &x) ||
      !GetNamedDouble(env, args[1], "y", &y) ||
      !GetNamedDouble(env, args[1], "width", &width) ||
      !GetNamedDouble(env, args[1], "height", &height)) {
    Throw(env, "Bounds must contain numeric x, y, width, and height");
    return nullptr;
  }

  host->view.frame = FrameForBounds(host->view.superview, x, y, width, height);
  UpdateSurfaceSize(host);

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value SendText(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    Throw(env, "sendText expects a terminal handle and UTF-8 text");
    return nullptr;
  }

  GhosttyHost* host = nullptr;
  if (napi_get_value_external(env, args[0], reinterpret_cast<void**>(&host)) !=
          napi_ok ||
      !host || host->closing.load(std::memory_order_acquire) ||
      !host->surface) {
    Throw(env, "Invalid terminal handle");
    return nullptr;
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, args[1], nullptr, 0, &length) !=
      napi_ok) {
    Throw(env, "sendText text must be a string");
    return nullptr;
  }
  std::string text(length + 1, '\0');
  if (napi_get_value_string_utf8(env, args[1], text.data(), text.size(),
                                 &length) != napi_ok) {
    Throw(env, "Unable to read sendText text");
    return nullptr;
  }
  text.resize(length);
  ghostty_surface_text(host->surface, text.data(), text.size());

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
      argc != 1) {
    Throw(env, "destroy expects a terminal handle");
    return nullptr;
  }

  GhosttyHost* host = nullptr;
  if (napi_get_value_external(env, args[0], reinterpret_cast<void**>(&host)) !=
          napi_ok ||
      !host) {
    Throw(env, "Invalid terminal handle");
    return nullptr;
  }
  DestroyHostResources(host);

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"setBounds", nullptr, SetBounds, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"sendText", nullptr, SendText, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"destroy", nullptr, Destroy, nullptr, nullptr, nullptr, napi_default,
       nullptr},
  };
  napi_define_properties(env, exports, 4, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
