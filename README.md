# BrowserOS TV for Tizen (TizenBrew module)

A port of [BrowserOS TV](../browserOS) to Samsung Tizen TVs (built for Tizen 5.5, the 2020 models). It makes any website navigable with the TV remote: arrows move focus, OK clicks, Back goes back. It runs as a [TizenBrew](https://github.com/reisxd/TizenBrew) module, because a normal Tizen app can't put its script into other sites.

```
npm install
npm run build        # src/ -> dist/browseros.js, checked to parse on Chromium 69
npm test             # build, then run 71 checks with simulated remote keys
npm test -- --suite=streaming    # one suite: basic | shell | streaming
npm test -- --modern             # keep APIs newer than Chromium 69 (default: hidden)

# drive a real site as the TV sees it (Tizen user agent, 1920x1080), one screenshot per key
npm test -- --explore=https://example.com/ --keys=ArrowDown*5,ArrowRight*2,Enter --shots=out
#   --cookie=name=value  set a cookie first    --wait=ms  wait before the first key
#   CANDIDATES=down      also print what Down would consider from each focus
```

The tests use the Electron install and test pages from `../browserOS`, so run `npm install` there first.

## Install on the TV

1. **Turn on Developer Mode.** Open Apps, type `12345` on the remote, turn Developer mode on, and set the Host PC IP to `127.0.0.1`. TizenBrew needs that IP to start its debugger. Restart the TV.
2. **Install TizenBrew** with the TizenBrew Installer or Tizen Studio. The steps are in the [TizenBrew README](https://github.com/reisxd/TizenBrew).
3. **Publish this module** so TizenBrew can download it. TizenBrew loads modules through jsDelivr, so either:
   - publish to npm (`npm publish`), and the module name is `npm/browseros-tv`, or
   - push this folder to a **public** GitHub repo **with `dist/` committed and a version tag** (e.g. `v0.1.0`), and the module name is `gh/<user>/<repo>`. Without a version in the name, jsDelivr serves the latest tag; a repo with no tags makes TizenBrew show "Unknown module".
4. **Add the module.** In TizenBrew, open the Module Manager, add the module name, and launch **BrowserOS TV**. You can make it auto-launch from there too.

This module is published as `gh/wall-hacker/browserOS`. To release an update:

```
npm run build
# bump "version" in package.json, commit, then:
git tag v0.1.1 && git push origin main v0.1.1
curl https://purge.jsdelivr.net/gh/wall-hacker/browserOS/package.json
curl https://purge.jsdelivr.net/gh/wall-hacker/browserOS/dist/browseros.js
```

Then restart TizenBrew on the TV (it caches the module list until its service restarts).

## Remote keys

| Key | Action |
| --- | --- |
| Arrows | Move focus to the nearest item in that direction; scroll when nothing is nearby |
| OK | Click, open the on-screen keyboard (text fields) or a picker (`<select>`), play/pause (video) |
| Back | Close the keyboard, picker or dialog, leave fullscreen, go back, or go home |
| **Hold OK**, or **Red** | Menu: back, forward, reload, home, address, zoom, pin, key mode, exit. (Holding Back works too on keyboards; Samsung remotes report Back's release immediately, so it can't be held there.) |
| **Green** | Home screen |
| **Yellow** | Address / search |
| Play, Pause, ⏯, ⏪, ⏩ | Control the main video, wherever focus is |
| Channel ± | Scroll the page |
| Video, progress bar, sliders, embedded players | Same as the Electron build: ← → scrub, OK grabs a slider, OK on a big iframe enters the player |

**Keys: Site** in the menu hands the arrows and OK to sites that already work with a remote, such as YouTube's TV app at `youtube.com/tv`. That site starts in this mode, and the setting is remembered per site.

## How it works

TizenBrew opens `websiteURL` in its own app window, connects to it with the DevTools protocol, and runs `dist/browseros.js` in every new execution context: every page after every navigation, and every iframe. That gives the same reach the Electron preload had, but there is no main process, so the parts the main process did are rebuilt in the page.

- **[src/page.js](src/page.js)**: spatial navigation, the focus ring, video, keyboard and picker, ported from `preload-site.js`. Clicks and hover are dispatched DOM events. Typing uses `execCommand('insertText')`, which fires real input events.
- **[src/remote.js](src/remote.js)**: Tizen key codes (Back is `10009`). Keys go to whichever frame has focus. A frame that isn't in control forwards them to the top frame with `postMessage`. The top frame handles them, opens the shell, or passes them to the player iframe it entered.
- **[src/shell.js](src/shell.js)**: home screen, menu and address screen, drawn in the page overlay.
- **[src/store.js](src/store.js)**: settings without a main process.
  - The home page is `http://127.0.0.1:8081/browseros/home`. TizenBrew's local server answers any path there, which gives favourites a stable origin to live in.
  - `window.name` survives cross-site navigation, so it carries pins and the "Continue" page between sites and the home page.
  - Zoom and key mode are stored in each site's own `localStorage`.
- **[src/compat.js](src/compat.js)**: replacements for APIs Chromium 69 doesn't have: popover, constructed stylesheets, `replaceChildren`, unprefixed fullscreen, `:modal` and `checkVisibility`. The CSS also avoids flex `gap`, `inset` and `min()`.

The test harness ([test/harness.js](test/harness.js)) injects the bundle the same way TizenBrew does, with site isolation off as on the TV. It sends trusted DevTools key events with Tizen key codes, and by default removes the newer APIs first so the fallbacks are what gets tested.

## Known limits

- **Not tested on a real TV yet.** The harness covers the logic and the Chromium 69 fallbacks, but it runs a modern Chromium. Things to check on the TV first:
  - whether OK reports its release (hold OK needs it; a key whose release never arrives acts on press, and the menu stays on Red)
  - CSS zoom, which old Chromium handles differently; the code measures it, and the harness reports `zoom correction factor`
  - whether `tizen.application` exists on remote pages; if not, Exit shows a hint to use the remote's Exit key
- **The TV's own keyboard** opens for any focused editable field. To keep only ours, a field is read-only while our keyboard edits it. A field a site focuses by itself is either taken over (right after OK) or let go. Rich editors (`contenteditable`) can't be made read-only, so the TV keyboard may still show there; its Done key submits and Cancel closes it.
- **Anti-bot frames are left alone.** Cloudflare Turnstile, reCAPTCHA and hCaptcha fail when a script runs in their frame. Sites like flystream.net then refuse to play, so the module doesn't run there. If such a check asks for a click, it can't be reached with the remote.
- **Clicks are synthetic** (`isTrusted: false`). Most sites accept them. Sites that check for trusted events won't react, and `:hover` styles don't show.
- **Fullscreen and `play()` from forwarded keys.** Chromium 69 grants user activation only to the frame that got the key. Fullscreen or play requested by a different frame may be refused.
- **No error page** when a site fails to load, and no new windows: pop-ups and new tabs open in place, so sign-in flows that need `window.opener` won't complete.
- **Inline `<style>` fallback.** Without constructed stylesheets, the overlay is styled with a `<style>` element. Sites with a strict `style-src` CSP block it, and the overlay loses its styling there.
- **DRM video** (Netflix, Disney+) won't play, same as in the Electron build.
