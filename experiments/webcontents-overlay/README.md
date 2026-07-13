# Layered WebContentsView browser demo

This demo composes three independent Chromium surfaces in one Electron
`BaseWindow`:

- a browser content `WebContentsView`
- an omnibar `WebContentsView`
- a topmost overlay `WebContentsView` that crosses the omnibar/content boundary

The overlay proves native view z-order and pointer routing. It is not DOM from
the page or the omnibar. `CommandOrControl+L` focuses the omnibar and
`CommandOrControl+Shift+P` toggles the overlay.

```sh
npm install
npm start
```

Run `npm run smoke` to navigate, display the overlay, capture all three views,
and write `artifacts/smoke.json` plus PNG evidence.
The Node launcher sets the smoke environment and resolves Electron without
POSIX shell syntax, so the same command works on Linux, Windows, and macOS.
Set `ELECTRON_BINARY` to exercise a fork build instead of the package binary.
Use `npm run smoke -- --print-command` to verify launcher resolution without
opening a window.

Run `npm run stress` for 200 resize, navigation, focus, pointer, keyboard, and
overlay z-order iterations. The harness force-crashes and recovers the content
renderer every 25 iterations, samples process memory, treats unexpected
renderer exits or unresponsive events as failures, and writes
`artifacts/stress-0.json`. Override the workload with
`--stress-iterations=<n>` and `--stress-crash-every=<n>` after `--`.
Browser-private and total-process working-set growth are checked against a
256 MB default bound, configurable with `ELECTRON_STRESS_MAX_RSS_GROWTH_MB`.

`npm run stress:cycles` runs ten fresh application processes with 200
iterations each. It fails on a browser-process signal, nonzero exit, timeout,
missing report, unexpected renderer exit, unresponsive event, or memory-bound
violation. Use `npm run stress:cycles -- --cycles=<n> --iterations=<n>
--crash-every=<n>` to change the workload. Per-cycle logs and the aggregate
result are written under `artifacts/`.
