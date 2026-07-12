# Electron Chrome-extension compatibility lab

This demo loads production uBlock Origin and Bitwarden builds into one
persistent Electron session, gives each browser content view a stable browser
tab role, opens their real extension popups, captures extension console output,
and writes a machine-readable `chrome.*` compatibility report.

```sh
npm install
npm run fetch-extensions
npm start
```

The extension artifacts come from the projects' official GitHub releases:

- uBlock Origin 1.72.2, Chromium build
- Bitwarden Browser 2026.6.1, Chrome build

`npm run smoke` writes API inventories, load warnings, popup screenshots, and
runtime status to `artifacts/compatibility.json`.

The stock Electron baseline is expected to fail. Electron documents arbitrary
Chrome extensions as unsupported and registers only a subset of the extension
platform. The report is the acceptance checklist for the Electron fork.
