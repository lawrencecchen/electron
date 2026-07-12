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
