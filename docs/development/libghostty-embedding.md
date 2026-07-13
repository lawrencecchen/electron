# Embedding libghostty in Electron

## Decision

Use Electron for window composition and web UI, but keep terminal state,
terminal I/O, glyph shaping, and GPU rendering inside libghostty. Native child
surface demos now validate this boundary on macOS, Linux X11, and Windows. Do
not begin the cmux migration until the compositor-texture path also covers
Wayland and hardware-accelerated Windows.

The permanent Electron change should be a small `GhosttyView` wrapper around a
generic native or external-texture view. Maintaining a broad Chromium fork for
terminal behavior would make every Chromium roll part of the terminal runtime.

## Current capability matrix

| Layer | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Electron parent handle | `NSView*` | X11 `Window`; no portable Wayland child handle | `HWND` |
| Ghostty embedded surface | `GHOSTTY_PLATFORM_MACOS` | Embedder-owned OpenGL callbacks | Embedder-owned OpenGL callbacks |
| Ghostty renderer | Metal embedded target | OpenGL through GLX | OpenGL through WGL |
| Terminal process backend | PTY | PTY | ConPTY code exists |
| Result today | Working native demo | Working X11 demo | Working demo; hardware WGL pass pending |

The OpenGL ABI keeps platform windowing outside Ghostty. The Linux addon owns
its X11 child, GLX drawable, and context. The Windows addon owns its child HWND,
device context, and WGL context. Ghostty makes the supplied context current,
loads GL functions, renders, updates the live viewport, and calls the host's
swap callback.

## Ghostty OpenGL API

The fork adds an embedder-owned render target instead of adding Electron
knowledge to Ghostty. The C boundary supplies callbacks equivalent to:

```c
typedef struct {
  void *userdata;
  bool (*make_current)(void *userdata);
  void *(*get_proc_address)(void *userdata, const char *name);
  uint32_t (*framebuffer)(void *userdata);
  void (*present)(void *userdata, const ghostty_damage_s *damage);
} ghostty_platform_opengl_s;
```

`ghostty_surface_config_s` has an OpenGL platform tag and target. Ghostty owns
its renderer thread, atlas, shaders, terminal state, and PTY or ConPTY.
Electron owns the platform surface, sizing, focus, input events, and
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

1. The macOS native-handle demo proves Metal rendering, resize, typing,
   selection, scrolling, clipboard, right-click actions, and lifecycle.
2. The platform-neutral OpenGL ABI and native X11/GLX and HWND/WGL demos prove
   Linux and Windows rendering, input, resize, and teardown.
3. Implement Linux EGL or DMA-BUF and Windows ANGLE or D3D shared-texture
   targets, plus hardware-GPU validation.
4. Add `GhosttyView` to the Electron fork and exercise the same JavaScript API
   on all three operating systems.
5. Rebuild one cmux workspace flow in Electron and measure startup, idle memory,
   typing latency, resize behavior, IME, accessibility, and browser/terminal
   composition before deciding on the migration.

## Go or no-go criteria

Proceed only if one API passes the same behavior tests on macOS, Wayland, X11,
and Windows, terminal input stays out of renderer-process IPC, Chrome UI can
animate and clip beside terminal layers without airspace artifacts, and typing
latency remains within one display frame of native cmux under load.

The child-window demos preserve Ghostty's native renderer and establish
feasibility. They do not satisfy the migration criteria because native child
windows cannot participate fully in Chromium clipping, transforms, or overlay
composition, and Linux still lacks Wayland support.
