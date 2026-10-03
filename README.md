# DejaTab

DejaTab is a Chrome extension that closes the earlier tabs showing the same
page as the tab you just navigated. You decide what "the same page" means:
tracking parameters, `www.`, the protocol and the query string can each be
ignored or respected, globally and per site. A trailing slash is always
ignored. DejaTab acts
on every site except the ones you exclude, or can instead be limited to a
list of sites you allow.

Before anything closes, DejaTab asks in a banner drawn on the page that just
loaded, offering four answers: Yes, No, Always (stop asking on this site) and
Never (ignore this site entirely). Nothing closes until you answer.

DejaTab reads no page content. It compares addresses only.

## Origin and license

DejaTab is a rewrite of [Unique Tabs](https://github.com/joeyAghion/unique_tabs)
by Joey Aghion, which is MIT licensed. DejaTab keeps that license and its
copyright notice, and adds its own; see [LICENSE](LICENSE). Unique Tabs
matches on exact URL equality after stripping the fragment. DejaTab keeps the
closing behavior and replaces that one fixed rule with rules you control.

## Install it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this repository's root directory, the one
   holding `manifest.json`.

After a change to any file, press the reload button on the DejaTab card in
`chrome://extensions`.

## Run the tests

```
node --test
```

Run it bare, from the repository root. Do not pass the directory: `node
--test test/` fails with `MODULE_NOT_FOUND`, because Node reads the argument
as a module to run rather than a directory to scan. A single file works:
`node --test test/rules.test.js`.

Nothing needs installing. There is no `package.json` and no dependency of any
kind, so a clone plus Node 18 or later is the whole setup.

Two suites:

- `test/rules.test.js` covers `src/rules.js`: the canonical key each rule
  produces, the R7 and R9 interactions, and the difference explanation the
  address tester reports.
- `test/settings.test.js` covers the pure parts of `src/settings.js`: the
  shipped defaults, host matching for the exclusion and per-site lists, rule
  resolution for a host, and the normalizers for the timeout and the
  parameter lists. `loadSettings` and `saveSettings` are left out, being the
  only functions there that touch `chrome`.

Both suites are testable without a browser because the modules under them
touch no browser API.

## What the manifest declares

JSON carries no comments, so the reasoning for `manifest.json` lives here.

- `permissions: storage`: settings, and the question waiting for an
  answer.
- `permissions: webNavigation`: the one navigation event DejaTab acts on,
  top frame only.
- `permissions: scripting`: injecting the banner into one tab, on demand.
- `permissions: notifications`: the notification posted after a close.
- `host_permissions` for http and https: reading the addresses of open tabs
  so they can be compared, and placing the banner on the page that just
  loaded. Nothing else.
- `background.service_worker` with `type: module`: `src/worker.js` is an ES
  module. Chrome unloads it when idle, and no timer or alarm wakes it.
- `options_ui.open_in_tab`: the options page is a full page, not a popup.
- `action` with no `default_popup`: clicking the toolbar icon opens the
  options page, and the service worker registers that click handler.
- `icons` at 16, 32, 48 and 128: the tab strip, the toolbar,
  `chrome://extensions` and the store listing.

The `tabs` permission is deliberately absent: host permission already makes
tab addresses readable, and declaring both would widen the permission warning
Chrome shows at install for nothing. No content script is declared either, so
no DejaTab code runs on a page until that page produces a duplicate.

## Artwork

All of it lives in `icons/`.

- `dejatab.svg` is the Inkscape master. Re-export from it rather than
  resizing a PNG.
- `icon16.png`, `icon32.png`, `icon48.png` and `icon128.png` are the exports
  the manifest names. They are the only artwork Chrome loads.
- `dejatab_wordmark_512.png` is a 512 pixel render carrying the wordmark. It
  is a Chrome Web Store listing asset, not an extension icon, and nothing in
  the code refers to it.

The settings page takes its colours from the mark, so the page and the icon
read as one thing. One item is not settled: the 16 pixel export is hard to
read at actual size.
