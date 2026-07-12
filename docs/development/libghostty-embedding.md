# Embedding libghostty in Electron

## Decision

Use Electron for window composition and web UI, but keep terminal state,
terminal I/O, glyph shaping, and GPU rendering inside libghostty. Validate the
macOS product shape with the Node-API spike in
`experiments/libghostty-embed`. Do not begin the cmux migration until Ghostty
has a platform-neutral embedded render target that works on Linux and Windows.

The permanent Electron change should be a small `GhosttyView` wrapper around a
generic native or external-texture view. Maintaining a broad Chromium fork for
terminal behavior would make every Chromium roll part of the terminal runtime.

## Current capability matrix

| Layer | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Electron parent handle | `NSView*` | X11 `Window`; no portable Wayland child handle | `HWND` |
| Ghostty embedded surface | `GHOSTTY_PLATFORM_MACOS` | None | None |
| Ghostty renderer | Metal embedded target | OpenGL through GTK4 only | No embedded target |
| Terminal process backend | PTY | PTY | ConPTY code exists |
| Result today | Full-render spike is viable | Blocked on render-target ABI | Blocked on render-target ABI |

Ghostty's current `src/renderer/OpenGL.zig` says the embedded OpenGL branch only
exists so libghostty compiles and is broken for rendering. Its C header exposes
only macOS and iOS platform tags. The GTK4 surface cannot be inserted directly
into Electron's Chromium Views/Aura tree, and GTK3 and GTK4 must not be treated
as interchangeable widget ABIs.

## Required Ghostty API

Add an embedder-owned render target instead of adding Electron knowledge to
Ghostty. One possible C boundary is:

```c
typedef struct {
  void *userdata;
  bool (*make_current)(void *userdata);
  void *(*get_proc_address)(void *userdata, const char *name);
  uint32_t (*framebuffer)(void *userdata);
  void (*present)(void *userdata, const ghostty_damage_s *damage);
} ghostty_platform_opengl_s;
```

`ghostty_surface_config_s` would gain an OpenGL platform tag and target. Ghostty
would continue to own its renderer thread, atlas, shaders, terminal state, and
PTY. Electron would own the platform surface, sizing, focus, input events, and
composition.

For the final product, prefer a compositor texture path over child windows:

1. Ghostty renders into an IOSurface on macOS, DMA-BUF or an EGL image on Linux,
   and a shared D3D texture on Windows.
2. Electron imports that surface into a `ui::Layer` or Chromium shared-image
   mailbox.
3. The layer participates in Chromium composition, clipping, transforms, and
   z-order with `WebContentsView` siblings.

A child `NSView`, X11 child window, or `HWND` is useful for the spike. Native
child windows create airspace problems for HTML overlays, rounded clipping,
Wayland, and animated layout, so they should not define the long-term API.

## Electron boundary

The main-process API should look like other Electron view classes:

```js
const terminal = new GhosttyView({
  workingDirectory,
  command,
  environment
})

window.contentView.addChildView(terminal)
terminal.setBounds({ x, y, width, height })
```

`GhosttyView` should derive from Electron's C++ `View` wrapper and own a
`views::View` with a compositor layer. JavaScript must not receive raw native
handles. The wrapper routes resize, focus, keyboard, IME, mouse, clipboard, and
Ghostty actions through one shared C++ host object.

Keep libghostty in Electron's browser process for the first product build. Its
existing wakeup callback can post `ghostty_app_tick` to Electron's UI sequence,
while Ghostty keeps rendering and terminal I/O on its own threads. A utility
process can be evaluated later for crash isolation, but it requires explicit
GPU-resource and input IPC.

## Input and UI contract

The host must translate Electron/Chromium events into Ghostty's physical key,
modifier, mouse, and preedit APIs. Text-only forwarding is insufficient for
terminal shortcuts, dead keys, CJK IME, keyboard layouts, and application mode
keys.

Web UI should compose terminals and browser areas as sibling views. React can
own tabs, sidebars, notifications, command UI, and layout state. Browser areas
remain `WebContentsView` instances. Terminal focus and accessibility remain
native responsibilities and must not travel through renderer-process DOM IPC.

## Rollout

1. Prove macOS rendering, resize, typing, and scrolling with the native-handle
   spike.
2. Add complete macOS keyboard, IME, clipboard, mouse, action, and lifecycle
   handling, then compare latency and memory with Swift cmux.
3. Land the platform-neutral Ghostty render-target ABI and a headless renderer
   conformance test.
4. Implement Linux EGL and Windows ANGLE or D3D shared-texture targets.
5. Add `GhosttyView` to the Electron fork and exercise the same JavaScript API
   on all three operating systems.
6. Rebuild one cmux workspace flow in Electron and measure startup, idle memory,
   typing latency, resize behavior, IME, accessibility, and browser/terminal
   composition before deciding on the migration.

## Go or no-go criteria

Proceed only if one API passes the same behavior tests on macOS, Wayland, X11,
and Windows, terminal input stays out of renderer-process IPC, Chrome UI can
animate and clip beside terminal layers without airspace artifacts, and typing
latency remains within one display frame of native cmux under load.

Until the render-target work lands, Electron can provide a macOS prototype or a
cross-platform terminal based on `libghostty-vt` plus a web renderer. The latter
does not preserve Ghostty's native renderer and should not be presented as the
target architecture.
