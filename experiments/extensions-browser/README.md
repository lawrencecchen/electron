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

`platform/source-manifest.json` pins Chromium 152.0.7925.0 at revision
`743c625106f2622aca4eef5f2e717442a54a3687`. The generated snapshot inventories
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

The stock Electron baseline is expected to fail. Electron documents arbitrary
Chrome extensions as unsupported and registers only a subset of the extension
platform. The report is the acceptance checklist for the Electron fork.
