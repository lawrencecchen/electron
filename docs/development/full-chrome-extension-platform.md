# Full Chrome extension platform

## Goal and parity contract

The target is behavioral parity with the `DEPS`-pinned stock Chromium build on
Linux and Windows. An extension that works in that Chromium build must observe the
same API availability, permissions, lifecycle, browser state, and UI behavior
in the Electron fork.

Parity is evaluated for the same operating system, GN build flags, release
channel, extension type, manifest version, execution context, policy state, and
allowlist. Chromium includes ChromeOS-only, platform-specific, private, and
component-extension schemas in its source tree. Those APIs are in scope only on
the platform and for the extension class where stock Chromium exposes them.
Private APIs must retain Chromium's allowlist and component-extension checks.
Exposing every checked-in schema to every third-party extension would be less
compatible and less secure than Chrome.

The full-browser lane must report the pinned Chromium channel. Electron's
existing `UNKNOWN` channel shortcut, which enables channel-gated APIs, cannot
be used as a parity result. A separate developer configuration may expose
experimental APIs, but its denominator must be the matching Chromium channel.

The denominator must be generated from the pinned build, not maintained by
hand. Record and compare:

- the Core and Chrome generated schemas linked into that build;
- every registered extension function;
- API, manifest, permission, and behavior feature-provider decisions after
  platform and channel filtering;
- the contexts in which each function is available;
- the expected permission warnings and manifest validation results.

uBlock Origin and Bitwarden are end-to-end canaries. Passing those two
extensions does not establish platform parity. JavaScript shims, namespace-only
smoke tests, and special cases for individual extensions do not count as API
support.

### Version freshness

The branch must start from current Electron `main`, including its Node, V8,
dependency lockfiles, build tooling, and package versions. Its Chromium pin must
then advance to the newest tagged Chromium build that Electron's checkout and
patch stack can reproduce. A live Chromium tip without a version tag is not a
reproducible pin.

CI must compare Electron `DEPS` with the newest official Chromium tag, fail when
the branch falls behind, and regenerate the schema contract from the resolved
revision after every roll. A roll is incomplete until Electron patches apply,
Linux and Windows compile, the differential contract is regenerated, and the
full extension suites pass on both platforms.

## Current compile-only scaffold

`enable_full_chrome_extensions` currently selects these Chromium provider
shards:

- `extensions::ChromeExtensionsClient` for common schemas, features,
  permissions, manifest handlers, and permission messages;
- `extensions::ChromeExtensionsBrowserAPIProvider` for generated browser-side
  function registration;
- `extensions::ChromeExtensionsAPIClient` for Chrome browser delegates;
- `extensions::ChromeExtensionsRendererAPIProvider` for renderer hooks and
  generated JavaScript sources;
- Chrome's browser-context keyed-service factory registration.

This proves that the provider shards link. It does not produce a usable Chrome
extension host. Binaries built with the flag intentionally fail at startup so
the scaffold cannot be mistaken for runtime support.

### Why provider registration is unsafe today

Electron's `ElectronBrowserContext` derives from `content::BrowserContext`.
Chrome's extension service graph is built around `Profile` and frequently uses
`Profile::FromBrowserContext()` or unchecked `Profile*` casts. Registering
Chrome's keyed-service factories against an `ElectronBrowserContext` therefore
causes undefined behavior when an eager service is created or when an API first
requests one.

The missing substrate extends beyond the cast:

- `ElectronExtensionSystem::extension_service()`, its state, rules, and dynamic
  user-script stores, its content verifier, and its update path are absent;
- `BrowserProcessImpl::profile_manager()` and many global Chrome services return
  null;
- `session.loadExtension()` assumes `ElectronExtensionSystem`;
- Electron tabs are independent `WebContents` objects, while Chrome APIs expect
  `Browser`, `TabStripModel`, window-controller registration, and `Profile`;
- action, popup, context-menu, side-panel, omnibox, install, identity, and
  permission UI require Chrome browser models and delegates;
- Electron's renderer client lacks Chrome's permissions-policy delegate,
  resource-request-policy delegate, policy logging, and exact incognito state;
- Electron registers generic extension frame binders but not Chrome's frame
  binders and Chrome `WebContents` helpers.

Registering more generated functions cannot repair these ownership and
lifecycle gaps.

## Required ownership model

The full-platform path must be a separate, opt-in browser lane until it reaches
parity. Existing Electron `BrowserWindow` and `Session` behavior should remain
unchanged during development.

```text
BrowserProcessImpl
  -> ProfileManager
       -> ProfileImpl
            -> ChromeExtensionSystem and Profile keyed services
            -> Browser
                 -> TabStripModel -> tab WebContents
                 -> WebUIBrowserWindow
                      -> WebUI top chrome
                      -> WebUIToolbarExtensionsContainer
```

Use Chromium's `ProfileImpl` directly. Subclassing `ElectronBrowserContext` or
implementing a partial `Profile` adapter would duplicate a large, changing
contract and leave unchecked casts pointing at the wrong object. Map each
persistent full-browser partition to a profile path. Use real off-the-record
profiles for incognito partitions.

Use a real `Browser` and `TabStripModel` as the canonical window and tab model.
The current Chromium pin has newer `BrowserWindowInterface`, `TabListInterface`, and
`tabs::TabInterface` abstractions, but extension code still reaches
`GetBrowserForMigrationOnly()`, `Browser`, and `TabStripModel`. An
Electron-owned tab adapter therefore cannot cover the complete API surface.

Use Chromium's `WebUIBrowserWindow` under
`chrome/browser/ui/webui_browser/`. It is a Views browser window whose top
chrome is WebUI. It preserves the Profile/Browser/TabStrip ownership graph and
already connects WebUI extension controls through
`WebUIToolbarExtensionsContainer`. This is the shortest path to an HTML
omnibar and overlays without reimplementing extension UI models. Electron may
wrap the active tab's `content::WebContents` for compatible inspection and
events, but must not take ownership from `Browser`.

## First vertical slice

The first runtime milestone is one persistent profile, one WebUI browser
window, one installed unpacked extension, and a restart. It must exercise
runtime, storage, tabs/windows, an action popup, and one network rule. Complete
it without adding adapters that later API categories must bypass.

1. **Global Chrome substrate.** Upgrade or replace
   `shell/browser/browser_process_impl.{h,cc}` with Chrome's real global-service
   lifecycle. It must own a working `ProfileManager`; the long-term design must
   not fill the current null getters one API at a time. Run the profile factory
   registration performed by `ChromeBrowserMainExtraPartsProfiles` in
   `chrome/browser/profiles/chrome_browser_main_extra_parts_profiles.{h,cc}`
   before any profile is created.
2. **Provider initialization.** In
   `shell/browser/electron_browser_main_parts.{h,cc}`, initialize Core plus
   Chrome common/browser providers exactly once and register the complete
   Chrome profile and extension keyed-service graph. Remove the startup guard
   only after these factories receive `ProfileImpl`, never
   `ElectronBrowserContext`.
3. **Profile-backed window.** Add an opt-in `ChromeBrowserWindow` binding under
   `shell/browser/api/` and a browser host under `shell/browser/chrome/`. The
   host owns a `Profile*`, creates a real `Browser`, and lets Chromium's browser
   window factory create `WebUIBrowserWindow`. The JavaScript wrapper observes
   the host and exposes navigation/window controls without becoming the tab
   owner.
4. **Installation.** Give this lane a separate extension-loading entry point
   backed by Chrome `ExtensionService` and `UnpackedInstaller`. Do not reuse the
   `ElectronExtensionSystem` cast in
   `shell/browser/api/electron_api_extensions.cc`. Verify extension registry,
   preferences, `storage.local`, service-worker state, and dynamic rules across
   process restart.
5. **Renderer completion.** Use
   `ChromeExtensionsRendererAPIProvider`,
   `RendererPermissionsPolicyDelegate`, and
   `ChromeResourceRequestPolicyDelegate`. Register the extension URL scheme as
   an extension scheme and as hash-based code cache. Preserve Chrome's
   incognito-process state and policy activity logging.
6. **Frame and tab helpers.** Call
   `PopulateChromeFrameBindersForExtension` in addition to the core binders.
   Attach `ChromeExtensionWebContentsObserver`, `TabHelper`,
   `ExtensionActionRunner`, active-tab helpers, and session-tab identity to
   every browser-owned tab.
7. **First UI path.** Use `ToolbarActionsModel`,
   `WebUIToolbarExtensionsContainer`, `ExtensionActionViewModel`,
   `ExtensionActionDelegateDesktop`, and `ExtensionPopup`. Test popup focus,
   keyboard input, pointer hit-testing, close behavior, and navigation before
   broadening the API set.

The likely minimum GN dependency set includes:

- `//chrome/common/extensions`;
- `//chrome/browser/extensions`;
- `//chrome/browser/extensions/api:api`;
- `//chrome/browser/extensions/keyed_services:keyed_service_factories`;
- `//chrome/renderer/extensions`;
- Chrome Profile and ProfileManager targets;
- Browser, tab-strip, Views, WebUI browser, and browser-resource targets.

Full parity will pull a substantial portion of `//chrome/browser`
transitively. That dependency is an architectural requirement of using Chrome's
extension host, not evidence that generated providers should be copied into
Electron.

## Full closure map

| Capability | Chromium implementation to retain | Required host state |
| --- | --- | --- |
| Schemas, feature gates, permissions, manifests | `chrome/common/extensions/`, `ChromeExtensionsClient`, `ChromeExtensionsAPIProvider`, Chrome manifest handlers | Pinned build flags, channel, allowlists, policy |
| Function registration and delegates | `ChromeExtensionsBrowserAPIProvider`, `ChromeExtensionsAPIClient`, `chrome/browser/extensions/api/` | Profile-backed keyed services |
| Extension lifecycle and persistence | `ChromeExtensionSystem`, `ExtensionService`, `ExtensionPrefs`, `ExtensionRegistry`, `StateStore`, `ServiceWorkerManager`, `UserScriptManager` | Persistent `ProfileImpl` and OTR profiles |
| Installation and security | `UnpackedInstaller`, component loader, management policy, install verifier, content verifier, blocklist, updater | Profile paths, network/global services, policy |
| Tabs and windows | `Browser`, `BrowserWindowInterface`, `TabStripModel`, `TabListInterface`, `ExtensionTabUtil`, browser extension window controller | Browser-owned tabs and registered windows |
| Actions and popups | `ToolbarActionsModel`, action dispatcher/runner, action view model/delegate, `ExtensionPopup`, WebUI toolbar extensions container | Active browser/tab, toolbar and popup host |
| Context menus | `MenuManager`, context-menu matcher/model/controller | Browser tab selection, native/WebUI menu host |
| Side panel | side-panel API/service, extension side-panel utilities, BrowserWindow features | Real browser window side-panel host |
| Omnibox | omnibox API, extension event router, suggestion watcher, template URL service | Profile omnibox services and WebUI bridge |
| Requests and content | webRequest, declarativeNetRequest, content scripts, user-script stores, Chrome frame binders | Network contexts, renderer helpers, persisted rules |
| Identity and permissions | Chrome runtime/identity delegates, auth flows, permission and install prompts | Browser windows, sign-in/policy services, prompt UI |
| Native and external messaging | Chrome messaging delegate, native message port dispatcher, native host registry and policy | Profile policy and OS host discovery |
| Desktop integrations | downloads, notifications, commands, debugger, desktop capture, cookies, history, bookmarks, settings | Corresponding Chrome Profile/global services and OS delegates |
| Renderer surface | Chrome renderer API provider/client, generated sources, policy/resource delegates | Correct scheme registration, process/context state |

No category is complete when its namespace merely exists. Its events,
permissions, persistence, cancellation, error results, incognito behavior, and
visible UI are part of the contract.

## Linux and Windows acceptance

Build and test Linux and Windows independently because stock Chromium exposes
different features and uses different OS delegates. For every pinned Chromium
roll:

1. Generate the platform-filtered contract from a stock Chromium binary and
   the Electron fork built with matching GN inputs.
2. Diff registered functions and API/manifest/permission/behavior feature
   decisions. Any difference needs an explicit compatibility rationale.
3. Run the applicable upstream Chromium extension API browser tests against the
   fork by category. Preserve upstream fixtures and assertions where possible.
4. Run differential fixture extensions in stock Chromium and the fork and
   compare results and emitted events, including negative permission and
   context cases.
5. Run UI automation for action popups, context menus, permission/install
   prompts, side panels, omnibox suggestions, identity windows, downloads, and
   notifications.
6. Run uBlock Origin and Bitwarden end to end only after the category suites
   pass.

The minimum behavior matrix covers:

- MV2 background pages where the pinned Chrome build permits them, MV3 service
  workers, suspend/restart/update, and crash recovery;
- `storage` areas, extension preferences, static/dynamic content scripts,
  declarative rules, and user scripts across restart;
- tab/window creation, movement, grouping, activation, querying, and event
  ordering across normal and incognito profiles;
- `webRequest`, response filtering, declarativeNetRequest blocking/redirects,
  cookies, and proxy/auth interactions;
- action state, popup focus, commands, context menus, side panels, and omnibox;
- native messaging, external messaging, identity, management, install/update/
  uninstall, permission changes, and policy restrictions;
- downloads, notifications, debugger, desktop capture, history, bookmarks, and
  settings where stock Chrome exposes them;
- API rejection and permission-warning parity for unavailable contexts.

Release readiness requires zero unexplained contract differences and passing
behavior tests for every supported ledger entry on both operating systems. A
provider registration count or two working production extensions is not a
release criterion.
