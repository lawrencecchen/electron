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
`artifacts/compatibility.json`. Run `npm run platform:check` to write an
immutable result under `artifacts/platform-coverage-runs/` and refresh the
platform-specific `artifacts/platform-coverage-<platform>.json` pointer. The
strict form exits nonzero until every contract item has passing evidence:

```sh
npm run platform:check:strict
npm run platform:check:linux
npm run platform:check:win
```

`required-api.json` contains canary assertions extracted from the two pinned
extensions. Canary visibility is diagnostic because Chrome gates API exposure
by permission, context, manifest version, extension type, channel, platform,
policy, and allowlist. It never counts as proof that the full platform passes.

`npm run stress:cycles` runs five fresh Electron processes against one
persistent profile created under a unique per-run evidence directory. Each
process performs 50 page/form/popup cycles, reloads
both production extensions every five iterations, and force-crashes then
recovers the page renderer every ten iterations. Unexpected renderer or child
process loss, unresponsive views, nonzero exits, timeouts, missing reports, and
post-warmup retained-memory growth fail the run. Override counts with
`--cycles`, `--iterations`, `--reload-every`, and `--crash-every` after `--`.
Use `--artifacts` or `--profile` only when a caller needs explicit paths.
Per-cycle reports and logs are deleted before each launch, so a failed process
cannot reuse a stale success report. Every run writes its immutable result
under `artifacts/stress-runs/<run-id>` and updates
`artifacts/stress-cycles.json` as a convenience pointer.

## Chromium contract

`platform/source-manifest.json` points to Electron's `DEPS`. The generator reads
`chromium_version`, resolves that tag to its exact Chromium revision, then
inventories both Chromium schema roots and their API, manifest, permission, and
behavior feature files. It includes private and platform-restricted entries so
an item cannot disappear from the denominator merely because a canary cannot
access it.

Refresh from a full Chromium checkout, including generated schema files found
under `out/*/gen`, with:

```sh
npm run platform:update -- --chromium-root /path/to/chromium/src
```

Without a checkout, the same command fetches the DEPS-pinned source blobs from
Chromium Gitiles and regenerates the committed fallback snapshot. Each consumed
file is SHA-256 recorded in the snapshot. `platform/support-ledger.json` holds
conformance evidence keyed by the exact feature names in that snapshot. A
`supported` entry must set `coverage` to `complete` and name its automated tests
in `tests`.
It must also list the tested `linux`, `mac`, or `win` targets in `platforms`.
For example: `"tabs": { "status": "supported", "coverage": "complete",
"platforms": ["linux"], "tests": ["conformance/tabs.test.mjs"] }`.
A Chromium roll requires regenerating the snapshot and ledger against the new
revision.

`npm run platform:freshness` compares the contract with local Electron `DEPS`,
upstream Electron main, the newest tagged Chromium build for the same major,
and Chromium's live tip. A fork pin ahead of Electron main is current; a pin
behind Electron main fails strict freshness. The checker distinguishes a
buildable tagged roll target from an untagged tip and only writes a roll plan.
Update Electron `DEPS`, sync and apply its Chromium patches, then run
`npm run platform:update -- --reset-ledger` to accept a roll explicitly.

## Differential Chromium oracle

The oracle generates two unpacked extensions from the contract and runs them
in a caller-supplied stock Chromium binary and native Electron. It compares an
MV2 background page, MV3 service worker, extension page, popup, content script,
and ordinary page. Feature eligibility applies Chromium platform, context,
manifest-version, extension-type, channel, location, internal, and allowlist
gates before a probe enters the matrix.

```sh
npm run oracle:run -- \
  --chromium-binary /path/to/chromium \
  --electron-binary /path/to/electron
```

Linux CI should run Electron under Xvfb. Root-only containers may pass
`--no-sandbox` explicitly; the runner does not weaken either browser sandbox by
default.

The Chromium binary must match Electron's DEPS pin. `--allow-version-mismatch`
exists only to exercise the harness during development and disables all
evidence candidates. The report is `artifacts/chromium-oracle.json`.

Chromium 152 hard-disables ordinary MV2 installations. The runner still loads
the generated MV2 fixture in both engines and records Chromium's missing MV2
contexts as non-comparable instead of borrowing results from an older browser.
Electron-only MV2 behavior is retained in the report but cannot become oracle
evidence.

Surface additions, removals, and type changes are always marked
`evidenceEligible: false`. Matching behavior probes produce partial evidence
candidates only when both engines run the pinned Chromium version. They cannot
set a support-ledger feature to `supported`; that still requires a complete
feature suite recorded with `coverage: "complete"`.

## Stock Chromium WebUI oracle

The WebUI lane builds Chromium's real `chrome` target at the same pin and
enables `Webium`, `SurfaceEmbed`, and `ExtensionsMenuAccessControl`. This gives
the migration a real `ProfileImpl`, `Browser`, tab model, extension system, and
HTML top chrome while retaining stock extension behavior.

```sh
gn gen out/ChromeOracle --args='import("//electron/build/args/chromium-webui-oracle.gn")'
autoninja -C out/ChromeOracle chrome
npm run oracle:webui:launch -- --chromium-root ../../..
```

`npm run oracle:webui:smoke -- --chromium-root ../../..` exits after verifying
the WebUI browser target and native extension registry, then records the load
status of the unchanged uBlock and Bitwarden fixtures. Stock Chromium 152 is
expected to reject uBlock Origin 1.72.2 because it is Manifest V2. The launcher
rejects the obsolete MV2 feature switches rather than treating them as a way
to restore uBlock. It writes `artifacts/chromium-oracle-startup.json`. A
Chromium checkout with Electron patches is rejected unless
`--allow-patched-source` is passed, and that override is marked ineligible as a
stock oracle. See `../../docs/development/chromium-webui-oracle.md` for build and
metadata details.

The stock Electron baseline is expected to fail. Electron documents arbitrary
Chrome extensions as unsupported and registers only a subset of the extension
platform. The report is the acceptance checklist for the Electron fork.
