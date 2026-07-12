# Chromium WebUI extension oracle

The oracle is Chromium's real `chrome` target at the exact version pinned by
Electron `DEPS`. It supplies the expected result for extension differential
tests and a runnable reference for the Profile-backed Electron browser lane.
It does not route Chrome APIs through `ElectronBrowserContext`.

The current pin is Chromium 152.0.7945.0 at
`c3d37161338e586b75ae8f9b3f8088be6c64c2d7`. The launcher fails when the
contract, `DEPS`, source checkout ancestry, or runtime binary version differs.

## Build

Use a disposable Chromium checkout so its `src` repository can remain exactly
at the pinned commit while `src/electron` contains this fork. Do not reset a
shared Electron build checkout. From the clean `src`, generate a non-component
release developer build:

```sh
gn gen out/ChromeOracle --args='import("//electron/build/args/chromium-webui-oracle.gn")'
autoninja -C out/ChromeOracle chrome
```

The GN file intentionally does not import Electron's common arguments. It
builds Chromium's `chrome` target with Chromium defaults plus a small,
recorded developer-build configuration. It disables Chromium's dummy
`LASTCHANGE` so `Browser.getVersion` proves the binary's source revision.
`is_official_build` is false, so the
oracle represents self-built stock Chromium's unknown channel. Tests for a
Google Chrome release channel need a separate official Chrome oracle.

Electron normally applies its Chromium patch stack as commits after the pinned
revision. The default launcher rejects that source because those patches can
change extension behavior. `--allow-patched-source` permits it for a Webium
architectural smoke run and records `stockSource: false`. That result must not
be used as the stock differential oracle.

The commands are the same in PowerShell. Use `out\ChromeOracle` if preferred
and run the depot_tools `gn` and `autoninja` wrappers from `PATH`.

## Launch

From `src/electron/experiments/extensions-browser`:

```sh
npm ci
npm run fetch-extensions
npm run oracle:webui:launch -- --chromium-root ../../..
```

The launcher performs these checks before reporting ready:

1. `DEPS`, the generated conformance contract, and the Chromium checkout share
   version 152.0.7945.0 and its pinned base revision.
2. The runtime DevTools product reports that exact four-part version.
3. A `chrome://webui-browser/` DevTools target proves that the
   `WebUIBrowserWindow` top chrome was created.
4. A fixed-ID MV3 probe calls native `chrome.management.getAll`. Its report
   records whether Chrome accepted each unmodified uBlock Origin and Bitwarden
   fixture. Rejection remains a valid oracle outcome when stock Chromium no
   longer supports a fixture's manifest or permission model.

The dedicated profile defaults to
`artifacts/chromium-oracle-profile`. It is deleted before each run unless
`--reuse-profile` is passed. Chrome starts with a random loopback debugging
port and the launcher discovers it through `DevToolsActivePort`.

`artifacts/chromium-oracle-startup.json` separates stable comparison inputs in
`comparable` from paths, target IDs, and the live DevTools endpoint in
`instance`. Differential tests should first compare `comparableSha256`, then
inspect the structured values when it differs.

For automated startup verification:

```sh
npm run oracle:webui:smoke -- --chromium-root ../../..
```

Useful overrides are `--chrome`, `--out-dir`, `--profile-dir`, `--metadata`,
`--url`, and repeatable `--chrome-arg` values. Run the launcher with `--help`
for the full syntax.
