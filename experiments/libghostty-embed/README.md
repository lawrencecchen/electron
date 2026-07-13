# Electron + native libghostty demo

This executable demo places a real macOS `NSView` rendered by libghostty next
to ordinary Chromium content in one Electron `BrowserWindow`. It uses
`BrowserWindow.getNativeWindowHandle()` and a Node-API addon, so the first proof
does not require a Chromium or Electron core build.

The terminal is not xterm.js. The addon links Ghostty's native static library,
creates a `GHOSTTY_PLATFORM_MACOS` surface, and renders through Ghostty's Metal
renderer. The demo implements physical keyboard input, terminal mouse input,
selection, scrolling, clipboard callbacks, and a native right-click Copy/Paste
menu.

## Run on macOS

Set `GHOSTTY_XCFRAMEWORK` to a GhosttyKit xcframework built from the same
`ghostty.h` ABI, and set `GHOSTTY_RESOURCES_DIR` to Ghostty's installed resource
directory.

```sh
cd experiments/libghostty-embed
export GHOSTTY_XCFRAMEWORK=/absolute/path/to/GhosttyKit.xcframework
export GHOSTTY_RESOURCES_DIR=/absolute/path/to/ghostty/resources
npm install
npm run build
npm start
```

If a development shell exports `NO_COLOR`, applications such as `htop` will
correctly honor it. Launch with `env -u NO_COLOR npm start` when validating ANSI
colors. A normal Finder launch does not inherit the development harness value.

Production work still needs IME marked text, accessibility, renderer health
handling, full action routing, and lifecycle hardening.

`npm run stress` repeatedly creates a real Ghostty app/surface, writes ANSI
output, performs 40 native resizes, explicitly destroys it while callbacks are
active, and repeats for 100 surfaces. It fails on renderer loss, an unresponsive
window, or more than 64 MB of retained/peak working-set growth after ten warmup
surfaces, and writes `artifacts/stress-0.json`. Change the workload with
`npm run stress -- --stress-iterations=<n> --stress-resizes=<n>`.

The addon exposes idempotent `destroy()` and drains queued wakeup callbacks
before the N-API external is deleted. Window close calls `destroy()` directly,
so native resources no longer depend on a later garbage-collection pass.

`npm run stress:cycles` starts ten fresh Electron processes and creates 100
Ghostty surfaces in each. It fails on a browser-process signal, nonzero exit,
timeout, missing report, native/renderer failure, or retained-memory violation.
Use `npm run stress:cycles -- --cycles=<n> --iterations=<n> --resizes=<n>` to
change the process and surface counts.

## Platform result

macOS is viable now. Electron exposes an `NSView*`, and libghostty accepts an
`NSView*` through `GHOSTTY_PLATFORM_MACOS`.

Linux cannot use the same route today. Full Ghostty rendering is implemented in
the GTK4 application runtime, while Electron's native view hierarchy is
Chromium Views/Aura. The embedded libghostty OpenGL path explicitly compiles but
does not initialize or own a render target.

Windows has ConPTY-related terminal I/O in Ghostty and can build a libghostty
DLL, but its embedded surface ABI has no `HWND` platform variant and the OpenGL
embedded renderer is marked broken. A Windows Electron handle alone is
therefore insufficient.

The cross-platform work belongs primarily in Ghostty: add a platform-neutral
embedded render-target ABI, then wrap it in an Electron `View`. Linux X11/GLX
and Windows HWND/WGL prototypes are being developed against that boundary.
