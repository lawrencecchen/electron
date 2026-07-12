# Electron Chrome-extension conformance lab

This lab makes every extension API, manifest feature, permission feature, and
behavior feature in the Electron fork's pinned Chromium revision part of the
acceptance denominator. Production uBlock Origin and Bitwarden builds remain
behavioral canaries. They are not the definition of platform support.

```sh
npm install
npm run fetch-extensions
npm start
```

`npm start` and `npm run smoke` use native Electron extension bindings only.
No compatibility library injects APIs into native conformance results. The GPL
`electron-chrome-extensions` provider is available only as an explicit
reference comparison:

```sh
npm run start:shim
npm run smoke:shim
```

The extension artifacts come from the projects' official GitHub releases:

- uBlock Origin 1.72.2, Chromium build
- Bitwarden Browser 2026.6.1, Chrome build

`npm run smoke` writes API inventories, load warnings, popup screenshots,
provider metadata, and the full Chrome denominator to
`artifacts/compatibility.json`. Run `npm run platform:check` to write the
expanded result to `artifacts/platform-coverage.json`. The strict form exits
nonzero until every contract item has passing evidence:

```sh
npm run platform:check:strict
npm run platform:check:linux
npm run platform:check:win
```

`required-api.json` contains canary assertions extracted from the two pinned
extensions. Canary visibility is diagnostic because Chrome gates API exposure
by permission, context, manifest version, extension type, channel, platform,
policy, and allowlist. It never counts as proof that the full platform passes.

## Chromium contract

`platform/source-manifest.json` pins Chromium 152.0.7945.0 at revision
`c3d37161338e586b75ae8f9b3f8088be6c64c2d7`. The generated snapshot inventories
both Chromium schema roots and their API, manifest, permission, and behavior
feature files. It includes private and platform-restricted entries so an item
cannot disappear from the denominator merely because a canary cannot access
it.

Refresh from a full Chromium checkout, including generated schema files found
under `out/*/gen`, with:

```sh
npm run platform:update -- --chromium-root /path/to/chromium/src
```

Without a checkout, the same command fetches the pinned source blobs from
Chromium Gitiles and regenerates the committed fallback snapshot. Each consumed
file is SHA-256 recorded in the snapshot. `platform/support-ledger.json` holds
conformance evidence keyed by the exact feature names in that snapshot. A
`supported` entry must name at least one automated test in its `tests` array.
It must also list the tested `linux`, `mac`, or `win` targets in `platforms`.
For example: `"tabs": { "status": "supported", "platforms": ["linux"],
"tests": ["conformance/tabs.test.mjs"] }`.
A Chromium roll requires regenerating the snapshot and ledger against the new
revision.

## Stock Chromium Webium oracle

The `oracle:launch` lane runs the real Chromium `chrome` target built from a
clean checkout of the pinned Chromium revision. It enables Chromium's
`Webium`, `SurfaceEmbed`, and
`ExtensionsMenuAccessControl` features, which select `WebUIBrowserWindow` and
its HTML top chrome. It uses a clean dedicated profile, requests the pinned
uBlock Origin and Bitwarden fixtures as unpacked extensions, and verifies the
native extension registry with a fixed-ID probe extension.

Build `chrome` from the Chromium `src` directory:

```sh
gn gen out/ChromeOracle --args='import("//electron/build/args/chromium-webui-oracle.gn")'
autoninja -C out/ChromeOracle chrome
```

Then run from this directory on Linux or Windows:

```sh
npm ci
npm run fetch-extensions
npm run oracle:launch -- --chromium-root ../../..
```

Use `npm run oracle:smoke -- --chromium-root ../../..` to exit after startup
verification. The launcher writes
`artifacts/chromium-oracle-startup.json`. Its `comparable` object contains the
pinned source identity, resolved GN arguments, native runtime versions,
fixture hashes and load outcomes, platform information, and Webium evidence.
`comparableSha256` is stable for identical inputs. The `instance` object holds
machine-specific paths and the ephemeral DevTools endpoint.

This is the stock Chromium browser oracle and the architectural base for the
full-browser lane. It proves how Chrome behaves with a real `ProfileImpl`,
`Browser`, tab model, extension system, and `WebUIBrowserWindow`. It does not
prove that Electron's current `ElectronBrowserContext` has Chrome extension
parity. A Chrome binary built after applying Electron's Chromium patch stack
requires `--allow-patched-source` and is labeled as an architectural smoke run,
not an exact oracle result.

The stock Electron baseline is expected to fail. Electron documents arbitrary
Chrome extensions as unsupported and registers only a subset of the extension
platform. The report is the acceptance checklist for the Electron fork.
