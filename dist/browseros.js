// BrowserOS TV 0.1.6 for TizenBrew. Built from src/ by build.js; don't edit.
(function () {
  'use strict';
  // TizenBrew evaluates the module in every new execution context; run once per document.
  if (window.__browserOS) return;
  // Anti-bot checks (Cloudflare Turnstile, reCAPTCHA, hCaptcha) fail if anything touches
  // their frame, and sites then refuse to play or log in. Leave them alone.
  if (/(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net)$/.test(location.hostname) ||
    (/(^|\.)google\.com$/.test(location.hostname) && /^\/recaptcha\//.test(location.pathname))) return;
  window.__browserOS = true;

// ---- defuse.js
// TizenBrew drives the page through a DevTools connection, with Runtime and Debugger
// enabled. Anti-DevTools scripts (disable-devtool and the like) read that as DevTools
// being open: logging gets slow because every console call is reported to the client.
// They then run a `debugger;` trap, and with TizenBrew's debugger attached and nothing
// to resume it, the page freezes for good. flystream.net's home page never fills in.
// Console output isn't visible on the TV, so the methods those detectors probe go quiet.
// Errors and warnings still get through.

(function quietConsole() {
  const quiet = function () {};
  for (const name of ['log', 'debug', 'info', 'table', 'dir', 'dirxml', 'clear', 'trace']) {
    try {
      if (typeof console[name] === 'function') console[name] = quiet;
    } catch (e) { /* read-only console */ }
  }
})();

// ---- compat.js
// Tizen 5.5 runs Chromium 69, which lacks much of what the Electron build relied on:
// constructed stylesheets, replaceChildren, unprefixed fullscreen, :modal,
// checkVisibility and the popover top layer. These helpers fill the gaps.
// (CSS in this module also avoids flex gap, inset and min(), all newer than M69.)

const IS_TOP = window === window.top;
const MSG = 'browseros-1'; // tags our postMessage traffic between frames
const HAS_POPOVER = typeof HTMLElement.prototype.showPopover === 'function';

function replaceKids(node, kids) {
  while (node.firstChild) node.removeChild(node.firstChild);
  for (const kid of kids) node.appendChild(kid);
}

const styledRoots = new WeakMap(); // root -> stylesheets already added to it

/** Adds a stylesheet to a shadow root once. A <style> element is the fallback (blocked by strict style CSP). */
function addStyles(root, css) {
  let added = styledRoots.get(root);
  if (!added) styledRoots.set(root, (added = new Set()));
  if (added.has(css)) return;
  added.add(css);
  const doc = root.ownerDocument || document;
  try {
    if ('adoptedStyleSheets' in root) {
      const sheet = new (doc.defaultView || window).CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = root.adoptedStyleSheets.concat([sheet]);
      return;
    }
  } catch (e) { /* fall through */ }
  const style = doc.createElement('style');
  style.textContent = css;
  root.appendChild(style);
}

/**
 * Unprefixed, promise-returning fullscreen for Chromium 69, which only has the webkit
 * methods, and those return nothing. Players then check on the next frame whether
 * fullscreen started; on a TV it takes longer, so they give up and fall back to native
 * <video> fullscreen, which shows none of their controls and nothing brings them back
 * (flystream.net). With a promise they wait for the real outcome.
 */
(function fullscreenPolyfill() {
  const proto = Element.prototype;
  if (proto.requestFullscreen || !proto.webkitRequestFullscreen) return;
  const settle = (resolve, reject) => {
    const done = (ok) => {
      document.removeEventListener('webkitfullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenerror', onError);
      if (ok) resolve();
      else reject(new TypeError('Fullscreen request denied'));
    };
    const onChange = () => done(true);
    const onError = () => done(false);
    document.addEventListener('webkitfullscreenchange', onChange);
    document.addEventListener('webkitfullscreenerror', onError);
  };
  proto.requestFullscreen = function () {
    const el = this;
    return new Promise((resolve, reject) => {
      settle(resolve, reject);
      el.webkitRequestFullscreen();
    });
  };
  if (!document.exitFullscreen && document.webkitExitFullscreen) {
    Document.prototype.exitFullscreen = function () {
      const doc = this;
      return new Promise((resolve, reject) => {
        if (!doc.webkitFullscreenElement) return resolve();
        settle(resolve, reject);
        doc.webkitExitFullscreen();
      });
    };
  }
  if (!('fullscreenElement' in document)) {
    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      configurable: true,
      get() { return this.webkitFullscreenElement || null; },
    });
  }
  // Pages that now take the unprefixed path listen for the unprefixed events too.
  document.addEventListener('webkitfullscreenchange', (e) => {
    e.target.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
  }, true);
  document.addEventListener('webkitfullscreenerror', (e) => {
    e.target.dispatchEvent(new Event('fullscreenerror', { bubbles: true }));
  }, true);
})();

function fullscreenEl() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function leaveFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const p = exit.call(document);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* not fullscreen */ }
}

function onFullscreenChange(fn) {
  document.addEventListener('onfullscreenchange' in document ? 'fullscreenchange' : 'webkitfullscreenchange', fn);
}

function isModal(dialog) {
  try {
    return dialog.matches(':modal');
  } catch (e) {
    return dialog.open; // M69 has no :modal; an open <dialog> is close enough
  }
}

function hasOpenModal() {
  try {
    return !!document.querySelector(':modal');
  } catch (e) {
    return !!document.querySelector('dialog[open]');
  }
}

/**
 * Style facts about an element and its ancestors, memoised per key press (see
 * resetStyleCache). Siblings share ancestors, so a page's worth of candidates costs
 * one getComputedStyle per element instead of one per element per descendant.
 */
const styleCache = { faded: new Map(), pinned: new Map() };

function resetStyleCache() {
  styleCache.faded = new Map();
  styleCache.pinned = new Map();
}

/** True when el or one of its ancestors matches test; answers are cached up the chain. */
function chainHas(el, cache, test, maxDepth) {
  const chain = [];
  let result = false;
  for (let n = el, depth = 0; n && n.nodeType === 1 && depth < maxDepth; n = parentOf(n), depth++) {
    const known = cache.get(n);
    if (known !== undefined) {
      result = known;
      break;
    }
    chain.push(n);
    if (test(getComputedStyle(n))) {
      result = true;
      break;
    }
  }
  // Everything walked lies below where the answer was found, so it shares it.
  for (const n of chain) cache.set(n, result);
  return result;
}

/** fresh: don't use (or fill) the per-key-press cache, for checks made between presses. */
function isVisible(el, fresh) {
  if (el.checkVisibility) {
    // Opacity only counts when asked for (both spellings, old and new).
    return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, opacityProperty: true, checkOpacity: true });
  }
  if (getComputedStyle(el).visibility === 'hidden') return false;
  return !chainHas(el, fresh ? new Map() : styleCache.faded, (s) => s.opacity === '0', 12);
}

function isPinned(el) {
  return chainHas(el, styleCache.pinned, (s) => s.position === 'fixed' || s.position === 'sticky', 30);
}

function post(win, msg) {
  msg.browserOS = MSG;
  try {
    win.postMessage(msg, '*');
  } catch (e) { /* frame gone */ }
}

/** Posts to every frame below win, nested ones included (frames/length work cross-origin). */
function broadcast(win, msg) {
  let count = 0;
  try {
    count = win.frames.length;
  } catch (e) {
    return;
  }
  for (let i = 0; i < count; i++) {
    const child = win.frames[i];
    post(child, Object.assign({}, msg));
    broadcast(child, msg);
  }
}

function onReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

// ---- osk.js
// On-screen keyboard driven by a D-pad, used by page text fields and the shell's address
// screen. Ported from the Electron build's src/osk.js: same layout and behaviour, with
// DOM and CSS that Chromium 69 understands (no flex gap, min() or replaceChildren).

const OSK_CSS = `
.osk {
  position: fixed; left: 50%; bottom: 2.5vh; transform: translateX(-50%);
  width: 94vw; max-width: 150vh; box-sizing: border-box; padding: 1.6vh 1.6vh 1.2vh;
  border-radius: 2.2vh; background: rgba(18, 21, 30, .97); color: #f4f6fb;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif;
  pointer-events: auto; z-index: 1;
}
.osk-preview {
  height: 6.4vh; padding: 0 2.2vh; margin-bottom: .6vh; border-radius: 1.2vh;
  background: rgba(255, 255, 255, .07); font-size: 2.9vh; line-height: 6.4vh;
  white-space: pre; overflow: hidden;
}
.osk-preview.empty { color: rgba(244, 246, 251, .4); }
.osk-preview::after {
  content: ''; display: inline-block; width: .3vh; height: 3.6vh; margin-left: .3vh;
  vertical-align: -0.7vh; background: #3d8bff;
}
.osk-preview.empty::after { margin: 0 .3vh 0 0; }
.osk-row { display: flex; margin-top: .9vh; }
.osk-key {
  flex: 1 1 0; min-width: 0; height: 7vh; border-radius: 1.1vh;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, .09); font-size: 3vh; font-weight: 500;
  cursor: pointer; user-select: none;
}
.osk-key + .osk-key { margin-left: .9vh; }
.osk-key.fn { background: rgba(255, 255, 255, .16); font-size: 2.3vh; }
.osk-key.accent { background: #2f6fd6; }
.osk-key.lit { color: #6fb0ff; }
.osk-key.on { background: #fff; color: #0b0d12; position: relative; z-index: 1; }
`;

function oskKey(label, action, w, cls, value) {
  return { label, action: action || 'char', w: w || 1, cls: cls || '', value: value === undefined ? label : value };
}

function oskChars(s) {
  return s.split(' ').map((c) => oskKey(c));
}

function oskRows(page, shift, enterLabel, kind) {
  const bottom = (toggle) => [
    oskKey(toggle, 'page', 2, 'fn'),
    oskKey('‹', 'left', 1, 'fn'),
    oskKey('space', 'space', 4, 'fn', ' '),
    oskKey('›', 'right', 1, 'fn'),
    kind === 'url' || kind === 'email' ? oskKey('.com', 'char', 2, 'fn') : oskKey('Done', 'done', 2, 'fn'),
  ];
  if (page === 'symbols') {
    return [
      oskChars('1 2 3 4 5 6 7 8 9 0 -').concat([oskKey('⌫', 'backspace', 1, 'fn')]),
      oskChars('! @ # $ % ^ & * ( ) _').concat([oskKey('Clear', 'clear', 1, 'fn')]),
      oskChars('+ = / \\ : ; " \' ? ~').concat([oskKey(enterLabel, 'enter', 2, 'accent')]),
      oskChars('[ ] { } < > | ` , . € £'),
      bottom('ABC'),
    ];
  }
  const letters = (s) => s.split(' ').map((c) => oskKey(shift ? c.toUpperCase() : c));
  return [
    oskChars('1 2 3 4 5 6 7 8 9 0 -').concat([oskKey('⌫', 'backspace', 1, 'fn')]),
    letters('q w e r t y u i o p').concat([oskKey('@'), oskKey('Clear', 'clear', 1, 'fn')]),
    letters('a s d f g h j k l').concat([oskKey("'"), oskKey(enterLabel, 'enter', 2, 'accent')]),
    [oskKey('⇧', 'shift', 2, shift ? 'fn lit' : 'fn')].concat(letters('z x c v b n m'), oskChars(', . /')),
    bottom('&123'),
  ];
}

class Keyboard {
  /**
   * @param {Element|ShadowRoot} container where the keyboard is appended
   * @param {{onKey: (action: string, value?: string) => void, kind?: string,
   *          enterLabel?: string, preview?: boolean}} opts
   */
  constructor(container, opts) {
    this.opts = opts;
    this.kind = opts.kind || 'text';
    this.page = this.kind === 'number' ? 'symbols' : 'letters';
    this.shift = false;
    this.row = 1;
    this.col = 0;
    addStyles(container.getRootNode ? container.getRootNode() : container, OSK_CSS);
    this.el = document.createElement('div');
    this.el.className = 'osk';
    if (opts.preview !== false) {
      this.previewEl = document.createElement('div');
      this.previewEl.className = 'osk-preview';
      this.el.appendChild(this.previewEl);
    }
    this.keysEl = document.createElement('div');
    this.el.appendChild(this.keysEl);
    // Keep focus in the text field when the keyboard is clicked with a pointer.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    container.appendChild(this.el);
    this.render();
  }

  get rows() {
    return oskRows(this.page, this.shift, this.opts.enterLabel || 'Go', this.kind);
  }

  render() {
    const rows = this.rows;
    this.row = Math.min(this.row, rows.length - 1);
    this.col = Math.min(this.col, rows[this.row].length - 1);
    replaceKids(this.keysEl, rows.map((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      row.forEach((k, c) => {
        const el = document.createElement('div');
        el.className = `osk-key ${k.cls}${r === this.row && c === this.col ? ' on' : ''}`;
        el.style.flex = `${k.w} 1 0px`;
        el.textContent = k.label;
        el.addEventListener('click', () => {
          this.row = r;
          this.col = c;
          this.press();
        });
        rowEl.appendChild(el);
      });
      return rowEl;
    }));
  }

  /** Moves the highlight. Returns false when already at that edge (up/down). */
  move(dir) {
    const rows = this.rows;
    const row = rows[this.row];
    if (dir === 'left' || dir === 'right') {
      const n = row.length;
      this.col = (this.col + (dir === 'right' ? 1 : n - 1)) % n;
    } else {
      const target = this.row + (dir === 'down' ? 1 : -1);
      if (target < 0 || target >= rows.length) return false;
      // Land on the key in the next row whose centre is closest to the current one.
      const center = (r, c) => rows[r].slice(0, c).reduce((s, k) => s + k.w, 0) + rows[r][c].w / 2;
      const x = center(this.row, this.col);
      let best = 0;
      rows[target].forEach((_, c) => {
        if (Math.abs(center(target, c) - x) < Math.abs(center(target, best) - x)) best = c;
      });
      this.row = target;
      this.col = best;
    }
    this.render();
    return true;
  }

  press() {
    const k = this.rows[this.row][this.col];
    switch (k.action) {
      case 'shift':
        this.shift = !this.shift;
        this.render();
        return;
      case 'page':
        this.page = this.page === 'letters' ? 'symbols' : 'letters';
        this.render();
        return;
      case 'space':
      case 'char':
        this.opts.onKey('char', k.value);
        if (this.shift && k.action === 'char') {
          this.shift = false;
          this.render();
        }
        return;
      default:
        this.opts.onKey(k.action);
    }
  }

  setPreview(text, placeholder) {
    if (!this.previewEl) return;
    const value = text.replace(/\s*\n\s*/g, ' ⏎ ');
    const shown = value.length > 70 ? '…' + value.slice(-69) : value;
    this.previewEl.textContent = shown || placeholder || '';
    this.previewEl.classList.toggle('empty', !shown);
  }

  destroy() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// ---- store.js
// Settings. There is no main process to hold them, and localStorage is per site, so:
//   - Favourites live in the home page's localStorage. The home page is a fixed origin
//     (TizenBrew's local server answers any path on 127.0.0.1:8081).
//   - Other sites can't read that, so the tab's window.name, which survives cross-site
//     navigation, carries a copy of the favourites, pins/unpins for the home page to
//     apply, and the last page visited (for "Continue").
//   - Per-site settings (zoom, key mode) live in that site's own localStorage.

const HOME_URL = 'http://127.0.0.1:8081/browseros/home';
const IS_HOME = IS_TOP && location.href.split(/[?#]/)[0] === HOME_URL;
const NAME_PREFIX = 'browseros:';
const FAVORITES_KEY = 'browseros.favorites';
const SITE_KEY = 'browseros.site';

const DEFAULT_FAVORITES = [
  { title: 'YouTube', url: 'https://www.youtube.com/tv' },
  { title: 'Twitch', url: 'https://www.twitch.tv/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
  { title: 'Google News', url: 'https://news.google.com/' },
];
// TV web apps that already drive themselves with the remote start in "Keys: Site".
const DEFAULT_PASSTHROUGH = [/^https?:\/\/(www\.)?youtube\.com\/tv/i];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

/** Rough registrable-domain comparison (good enough to tell an ad network from the site). */
function sameSite(a, b) {
  const site = (url) => {
    const parts = hostOf(url).split('.');
    const last = parts[parts.length - 1] || '';
    const second = parts[parts.length - 2] || '';
    const n = parts.length > 2 && last.length === 2 && second.length <= 3 ? 3 : 2;
    return parts.slice(-n).join('.');
  };
  return !!hostOf(a) && site(a) === site(b);
}

/** Turns what the user typed into a URL: an address if it looks like one, else a search. */
function toUrl(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    return null; // storage blocked (sandboxed frame, opaque origin)
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage blocked */ }
}

// ------------------------------------------------------------------ window.name carrier

const carrier = loadCarrier();

// Sites write window.name too. Some prepend their own marker to whatever is there
// (flystream.net adds "fsLegacyTried|"), so ours is found wherever it is and saved
// after what they put in front of it. A site that replaces the whole name loses it.

function loadCarrier() {
  const empty = { favorites: null, pending: [], last: null };
  if (!IS_TOP) return empty;
  try {
    const at = window.name.indexOf(NAME_PREFIX);
    if (at >= 0) return Object.assign(empty, JSON.parse(window.name.slice(at + NAME_PREFIX.length)));
  } catch (e) { /* not ours, or cut short */ }
  return empty;
}

function saveCarrier() {
  if (!IS_TOP) return;
  try {
    const at = window.name.indexOf(NAME_PREFIX);
    window.name = (at > 0 ? window.name.slice(0, at) : '') + NAME_PREFIX + JSON.stringify(carrier);
  } catch (e) { /* ignore */ }
}

/** Remembers this page for the home screen's "Continue" tile. */
function rememberPage() {
  if (!IS_TOP || IS_HOME || !/^https?:/i.test(location.href)) return;
  carrier.last = { url: location.href, title: document.title || '' };
  saveCarrier();
}

// ------------------------------------------------------------------ favourites

/** On the home page: stored favourites with pins made on other sites applied. */
function loadHomeFavorites() {
  let favs = readJSON(FAVORITES_KEY) || DEFAULT_FAVORITES.slice();
  for (const op of carrier.pending) {
    favs = favs.filter((f) => hostOf(f.url) !== hostOf(op.url));
    if (op.pin) favs.push({ title: op.title, url: op.url });
  }
  if (carrier.pending.length) writeJSON(FAVORITES_KEY, favs);
  carrier.pending = [];
  carrier.favorites = favs;
  saveCarrier();
  return favs;
}

function saveHomeFavorites(favs) {
  writeJSON(FAVORITES_KEY, favs);
  carrier.favorites = favs;
  saveCarrier();
}

/** The favourites as last seen by the home page (other sites can't read its storage). */
function knownFavorites() {
  return carrier.favorites || [];
}

function isFavorite(url) {
  const host = hostOf(url);
  return !!host && knownFavorites().some((f) => hostOf(f.url) === host);
}

/** Pins or unpins a site from any page; the home page applies it next time it opens. */
function togglePin(url, title) {
  const host = hostOf(url);
  if (!host) return false;
  const pin = !isFavorite(url);
  const entry = { title: title || host.replace(/^www\./, ''), url };
  carrier.pending = carrier.pending.filter((op) => hostOf(op.url) !== host).concat([Object.assign({ pin }, entry)]);
  carrier.favorites = knownFavorites().filter((f) => hostOf(f.url) !== host).concat(pin ? [entry] : []);
  saveCarrier();
  return pin;
}

// ------------------------------------------------------------------ per-site settings

function siteSettings() {
  return readJSON(SITE_KEY) || {};
}

function updateSiteSettings(changes) {
  writeJSON(SITE_KEY, Object.assign(siteSettings(), changes));
}

function sitePassthrough() {
  const s = siteSettings();
  if (typeof s.passthrough === 'boolean') return s.passthrough;
  return DEFAULT_PASSTHROUGH.some((re) => re.test(location.href));
}

function siteZoom() {
  const z = Number(siteSettings().zoom);
  return z > 0 ? z : 1;
}

// ---- page.js
// Runs in every page and iframe. It turns an arbitrary website into something a TV
// remote can drive (ported from the Electron build's src/preload-site.js):
//   - spatial D-pad focus across links, buttons, inputs and script-clickable elements
//   - a focus ring in an overlay (top layer where the engine has popover)
//   - clicks and hover, as synthetic events (there is no trusted input on the TV)
//   - an on-screen keyboard for text fields and a picker for <select>
//   - video: play/pause, scrubbing with a preview bar, seek/volume sliders
//   - embedded players: OK on a large iframe hands the remote to that iframe's copy
//     of this script until Back leaves it again
// Keys arrive through remote.js, only in the frame in control.

const SELECTOR = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  'video', 'iframe', 'label[for]', '[onclick]', '[contenteditable=""]', '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])', '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="treeitem"]', '[role="slider"]',
].join(',');
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'password', 'number', 'tel']);
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const POINTER_GRID = 12; // sample points along the short side of the viewport
const POINTER_STEP_MIN = 40; // px between samples, at least
const FAR_JUMP = 0.8; // targets farther than this × viewport are approached by scrolling
const REPEAT_MS = 85;
const SCRUB_STEPS = [10, 10, 10, 20, 30, 30, 60, 60, 90, 120]; // seconds per press while held
const SCRUB_COMMIT_MS = 700;
const PLAYER_FRAME_SHARE = 0.15; // iframes at least this share of the screen are "entered"

const S = {
  baseMode: 'nav',
  mode: null,
  active: false, // iframes: true while the top frame has handed us the remote
  focused: null,
  lastRect: null,
  osk: null,
  editing: null,
  picker: null,
  typing: null,
  inFrame: null,
  shell: null, // top frame: 'home' | 'menu' | 'search' while the shell is open
  scrub: null,
  scrubHideTimer: null,
  engaged: null, // slider taken over by OK: left/right adjust it until OK/Back/up/down
  escapedModal: null,
  mouseActive: false,
  synthMouseUntil: 0,
  lastKeyAt: 0,
  lastClick: null,
  activatedAt: 0,
  hits: { grid: 0, click: 0, pinned: 0 },
  guarded: null, // field we made readonly so the TV's own keyboard stays closed
  hovered: null,
  hoverToken: 0,
  zoom: 1,
  zoomFix: 1,
  host: null,
  shadow: null,
  ring: null,
  ringKey: '',
  ringShown: false,
  visibleTick: 0,
  focusedVisible: true,
  toastEl: null,
  toastTimer: null,
  scrubEl: null,
  shadowRoots: null,
  shadowRootsAt: 0,
};

// ------------------------------------------------------------------ mode

function setMode(mode) {
  if (S.mode === mode) return;
  S.mode = mode;
  if (IS_TOP) announceMode();
}

/** Frames forward or keep keys depending on the top frame's mode, so tell them. */
function announceMode() {
  broadcast(window, modeMessage());
}

function modeMessage() {
  return { type: 'mode', mode: S.shell ? 'shell' : S.mode, passthrough: S.baseMode === 'passthrough', upSeen: R.upSeen };
}

function restMode() {
  if (S.osk || S.picker) return;
  if (S.typing) return setMode('passthrough');
  if (IS_TOP) {
    const fe = fullscreenEl();
    if (fe instanceof HTMLIFrameElement && S.inFrame !== fe) {
      S.inFrame = fe; // a player iframe went fullscreen: it takes the remote
      post(fe.contentWindow, { type: 'enter' });
    }
    if (S.inFrame && S.inFrame.isConnected) return setMode('frame');
    S.inFrame = null;
  }
  setMode(S.baseMode);
}

function setPassthrough(on) {
  updateSiteSettings({ passthrough: on });
  S.baseMode = on ? 'passthrough' : 'nav';
  restMode();
  announceMode();
  toast(on ? 'Remote keys go to the site' : 'Remote navigation on');
}

// ------------------------------------------------------------------ DOM helpers

function parentOf(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode && el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** Shadow-DOM aware contains(). */
function contains(ancestor, el) {
  for (let n = el; n; n = parentOf(n)) if (n === ancestor) return true;
  return false;
}

function deepElementFromPoint(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function deepActiveElement() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** getBoundingClientRect in screen pixels, corrected for our page zoom where the engine needs it. */
function box(el) {
  const r = el.getBoundingClientRect();
  const f = S.zoomFix;
  if (f === 1) return r;
  return { left: r.left * f, top: r.top * f, right: r.right * f, bottom: r.bottom * f, width: r.width * f, height: r.height * f };
}

function rectOf(el) {
  let r = box(el);
  // Inline links that wrap block content can report a collapsed box.
  if ((r.width < 2 || r.height < 2) && el.firstElementChild) {
    const c = box(el.firstElementChild);
    if (c.width >= 2 && c.height >= 2) r = c;
  }
  return r;
}

function onScreen(r) {
  return r && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function sameBox(a, b) {
  return Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4 &&
    Math.abs(a.right - b.right) < 4 && Math.abs(a.bottom - b.bottom) < 4;
}

const cx = (r) => (r.left + r.right) / 2;
const cy = (r) => (r.top + r.bottom) / 2;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function isDisabled(el) {
  return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (el.tagName === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase()) && !el.readOnly && !el.disabled;
  return false;
}

function describe(el) {
  if (!el) return null;
  const id = el.id ? `#${el.id}` : '';
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
  const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40);
  return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''} ${text}`.trim();
}

/** A point inside el where a click would actually land on el (not on something covering it). */
function clickPoint(el, rect) {
  const r = rect || rectOf(el);
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, innerHeight);
  if (right - left < 1 || bottom - top < 1) return null;
  const w = right - left;
  const h = bottom - top;
  let last = null;
  for (const t of CLICK_TRIES) {
    const x = left + w * t[0];
    const y = top + h * t[1];
    S.hits.click++;
    const hit = deepElementFromPoint(x, y);
    if (hit && (contains(el, hit) || contains(hit, el))) return { x, y };
    if (t === CLICK_TRIES[0]) S.coverHit = hit; // for underPinned, saving it a hit test
    // The same thing on top twice running: covered whole (a stacked carousel slide), not just a corner.
    if (hit && hit === last) return null;
    last = hit;
  }
  return null;
}

const CLICK_TRIES = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];

function searchRoots(base) {
  const now = performance.now();
  if (!S.shadowRoots || now - S.shadowRootsAt > 5000) { // walks every element: not on every press
    const roots = [];
    const queue = [document];
    while (queue.length) {
      const root = queue.shift();
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    S.shadowRoots = roots;
    S.shadowRootsAt = now;
  }
  if (base === document) return [document].concat(S.shadowRoots);
  const inside = S.shadowRoots.filter((root) => contains(base, root.host));
  return [base].concat(base.shadowRoot ? [base.shadowRoot] : [], inside);
}

// ------------------------------------------------------------------ candidates

/**
 * What a remote can reach: real controls (by selector) plus elements made clickable
 * by script, which are only recognisable by looking clickable (cursor: pointer).
 */
/** area: limit screen sampling to this part of the viewport (all of it when omitted). */
function collect(scope, area) {
  const vw = innerWidth;
  const vh = innerHeight;
  const found = new Map();

  // Cheapest checks first: on a TV every getComputedStyle and hit test counts.
  const consider = (el, viaPointer) => {
    if (found.has(el) || el === S.host) return;
    const r = rectOf(el);
    if (r.width < 3 || r.height < 3) return;
    // Only what's within about a screen: a press never reaches further, and the page
    // scrolls along as focus moves.
    if (r.bottom < -vh || r.top > 2 * vh || r.right < -vw || r.left > 2 * vw) return;
    const media = el.tagName === 'VIDEO' || el.tagName === 'IFRAME';
    if (!media && r.width * r.height > (viaPointer ? 0.5 : 0.85) * vw * vh) return;
    if (isDisabled(el)) return;
    if (scope && !contains(scope, el)) return;
    if (!isVisible(el)) return; // cached styles: cheaper than the hit tests below
    // Covered by something else, unless it's a fixed bar that scrolling moves it out from
    // under, or a video's own player drawn over it (a click shield, hidden controls).
    S.coverHit = undefined;
    if (!viaPointer && onScreen(r) && !clickPoint(el, r) && !underPinned(el, r) &&
      !(el.tagName === 'VIDEO' && ownOverlay(el))) return;
    // Off to the side with nothing that scrolls it in (carousels paged by transforms).
    if ((r.right <= 0 || r.left >= vw) && !scrollerFor(parentOf(el), false, r.left >= vw ? 1 : -1)) return;
    found.set(el, { el, r, viaPointer });
  };

  for (const root of searchRoots(scope || document)) {
    for (const el of root.querySelectorAll(SELECTOR)) consider(el, false);
  }

  // Script-clickable elements, found by sampling the screen for cursor: pointer.
  // Hit tests are the costliest thing here (most of a key press on a big page), so
  // points inside controls already found are skipped: anything clickable in there is
  // dropped as a duplicate of that control anyway.
  const step = Math.max(POINTER_STEP_MIN, Math.min(vw, vh) / POINTER_GRID);
  const seen = new Set();
  const cursors = cursorCache();
  const known = [];
  for (const c of found.values()) if (onScreen(c.r)) known.push(c.r);
  const isKnown = (x, y) => {
    for (let i = 0; i < known.length; i++) if (pointInRect(x, y, known[i])) return true;
    return false;
  };
  const a = area || { left: 0, top: 0, right: vw, bottom: vh };
  for (let y = step / 2; y < vh; y += step) {
    if (y < a.top || y > a.bottom) continue;
    for (let x = step / 2; x < vw; x += step) {
      if (x < a.left || x > a.right || isKnown(x, y)) continue;
      S.hits.grid++;
      const hit = deepElementFromPoint(x, y);
      if (!hit || seen.has(hit)) continue;
      seen.add(hit);
      const target = pointerTarget(hit, cursors);
      if (target) consider(target.el, !target.native);
    }
  }

  // Drop duplicates: pointer targets nested in a control, and controls wrapped by an identical box.
  const list = [];
  for (const c of found.values()) {
    let dup = false;
    let p = parentOf(c.el);
    for (let depth = 0; p && depth < 8; depth++, p = parentOf(p)) {
      const outer = found.get(p);
      if (outer && (c.viaPointer || sameBox(outer.r, c.r))) {
        dup = true;
        break;
      }
    }
    if (!dup) list.push(c);
  }
  return list;
}

/** What covers this video (clickPoint's centre hit) belongs to its player: the wrapper around it. */
function ownOverlay(video) {
  const hit = S.coverHit;
  if (!hit) return false;
  let n = parentOf(video);
  for (let depth = 0; n && depth < 6 && n !== document.body; depth++, n = parentOf(n)) {
    if (!playerWide(box(n), video)) return false;
    if (contains(n, hit)) return true;
  }
  return false;
}

/** el is hidden behind a fixed/sticky element (a header bar), not behind page content. */
function underPinned(el, r) {
  // clickPoint(el) just failed, and its first try was this centre point: reuse that hit.
  let hit = S.coverHit;
  if (hit === undefined) {
    S.hits.pinned++;
    hit = deepElementFromPoint(clamp(cx(r), 0, innerWidth - 1), clamp(cy(r), 0, innerHeight - 1));
  }
  return !!hit && !contains(el, hit) && !contains(hit, el) && isPinned(hit) && !isPinned(el);
}

/** Computed cursors, kept for a few seconds: they rarely change, and sampling reads hundreds. */
function cursorCache() {
  const now = performance.now();
  if (!S.cursors || now - S.cursorsAt > 4000) {
    S.cursors = new Map();
    S.cursorsAt = now;
  }
  return S.cursors;
}

function pointerTarget(hit, cache) {
  let top = null;
  let el = hit;
  for (let depth = 0; el && depth < 14; depth++, el = parentOf(el)) {
    if (el === document.body || el === document.documentElement || el === S.host) break;
    if (el.matches(SELECTOR)) return { el, native: true };
    let cursor = cache.get(el);
    if (cursor === undefined) {
      cursor = getComputedStyle(el).cursor;
      cache.set(el, cursor);
    }
    if (cursor === 'pointer') top = el;
    else if (top) break;
  }
  return top && { el: top, native: false };
}

function findModal() {
  let modal = null;
  for (const d of document.querySelectorAll('dialog[open], [aria-modal="true"]')) {
    if (d.tagName === 'DIALOG' && !isModal(d)) continue;
    const r = d.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && isVisible(d)) modal = d;
  }
  return modal;
}

/** Where focus is confined: a fullscreen player or an open modal dialog. */
function activeScope() {
  const fe = fullscreenEl();
  if (fe && !(fe instanceof HTMLIFrameElement)) return fe;
  return findModal();
}

// ------------------------------------------------------------------ spatial navigation

function score(a, b, dir) {
  const vertical = dir === 'up' || dir === 'down';
  const tol = (vertical ? Math.min(a.height, b.height) : Math.min(a.width, b.width)) * 0.3;
  let primary;
  switch (dir) {
    case 'down':
      if (b.top < a.bottom - tol || cy(b) <= cy(a)) return null;
      primary = Math.max(0, b.top - a.bottom);
      break;
    case 'up':
      if (b.bottom > a.top + tol || cy(b) >= cy(a)) return null;
      primary = Math.max(0, a.top - b.bottom);
      break;
    case 'right':
      if (b.left < a.right - tol || cx(b) <= cx(a)) return null;
      primary = Math.max(0, b.left - a.right);
      break;
    default:
      if (b.right > a.left + tol || cx(b) >= cx(a)) return null;
      primary = Math.max(0, a.left - b.right);
  }
  const overlap = vertical
    ? Math.min(a.right, b.right) - Math.max(a.left, b.left)
    : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  // Left/right stay in the row: things that share no height with it are another row.
  if (!vertical && overlap <= 0) return null;
  const gap = Math.max(0, -overlap);
  const drift = vertical ? Math.abs(cx(a) - cx(b)) : Math.abs(cy(a) - cy(b));
  return { primary, total: primary + gap * 2 + drift * (overlap > 0 ? 0.05 : 0.3) };
}

function findBest(dir, from, cands, current) {
  let best = null;
  for (const c of cands) {
    if (current && (c.el === current || contains(c.el, current) || contains(current, c.el))) continue;
    const s = score(from, c.r, dir);
    if (s && (!best || s.total < best.total)) best = Object.assign({}, c, { total: s.total, primary: s.primary });
  }
  return best;
}

function pointInRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** A player wrapper is about as wide as its video; anything wider is page layout. */
function playerWide(b, video) {
  const vr = box(video);
  return Math.abs(b.width - vr.width) <= Math.max(40, vr.width * 0.15);
}

/** The video whose player this control belongs to, if any. */
function playerVideoOf(el) {
  let n = parentOf(el);
  for (let depth = 0; n && depth < 8 && n !== document.body; depth++, n = parentOf(n)) {
    const video = largestVideo(n);
    if (video) return !contains(el, video) && playerWide(box(n), video) ? video : null;
  }
  return null;
}

/** The outermost element wrapped tightly around a video: its player. */
function playerRoot(video) {
  let root = null;
  let n = parentOf(video);
  for (let depth = 0; n && depth < 6 && n !== document.body; depth++, n = parentOf(n)) {
    if (!playerWide(box(n), video)) break;
    root = n;
  }
  return root;
}

/** Wakes a player and focuses a control once they've appeared (controls usually sit along the bottom). */
function focusControlsSoon(video, root) {
  wakePlayer(video);
  setTimeout(() => {
    resetStyleCache(); // they were hidden when this key press started
    const controls = collect(root).filter((c) => c.el !== video && !contains(c.el, video));
    const pick = initialPick(controls, 'up');
    if (pick) focusEl(pick.el);
  }, 150);
}

/** The player around a video: its box and the controls in it. */
function playerOf(video, cands) {
  let n = parentOf(video);
  for (let depth = 0; n && depth < 6 && n !== document.body; depth++, n = parentOf(n)) {
    const b = box(n);
    if (!playerWide(b, video)) break;
    const controls = cands.filter((c) => c.el !== video && !contains(c.el, video) && contains(n, c.el));
    if (controls.length) return { box: b, controls };
  }
  // No wrapper: controls are whatever is drawn on top of the video.
  const b = box(video);
  return { box: b, controls: cands.filter((c) => c.el !== video && pointInRect(cx(c.r), cy(c.r), b)) };
}

/** First stop when nothing is focused yet: enter from the edge opposite to the pressed direction. */
function initialPick(cands, dir) {
  const visible = cands.filter((c) => onScreen(c.r));
  if (!visible.length) return null;
  const rank = {
    down: (r) => r.top + r.left * 0.3,
    right: (r) => r.left + r.top * 0.3,
    up: (r) => -r.bottom + r.left * 0.3,
    left: (r) => -r.right + r.top * 0.3,
  }[dir];
  return visible.reduce((a, b) => (rank(b.r) < rank(a.r) ? b : a));
}

function fullyOnScreen(r) {
  return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
}

/**
 * Focus was scrolled out of view and the press heads back into the page (down after the
 * focused item scrolled off the top, and so on): carry on from the edge it left by, in
 * its column or row. Fixed headers and bars are skipped: they're not "next".
 */
function reenter(dir, from, cands) {
  const vw = innerWidth;
  const vh = innerHeight;
  const edges = {
    down: from.bottom <= 0 && { left: from.left, right: from.right, top: -1, bottom: 0 },
    up: from.top >= vh && { left: from.left, right: from.right, top: vh, bottom: vh + 1 },
    right: from.right <= 0 && { left: -1, right: 0, top: from.top, bottom: from.bottom },
    left: from.left >= vw && { left: vw, right: vw + 1, top: from.top, bottom: from.bottom },
  };
  const edge = edges[dir];
  if (!edge) return null;
  edge.width = edge.right - edge.left;
  edge.height = edge.bottom - edge.top;
  return findBest(dir, edge, cands.filter((c) => onScreen(c.r) && !isPinned(c.el)), null);
}

/** The part of the screen a press in dir can land in, from r (generously: rows overlap). */
function aheadOf(r, dir) {
  const a = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  if (dir === 'down') a.top = r.top;
  else if (dir === 'up') a.bottom = r.bottom;
  else if (dir === 'right') a.left = r.left;
  else a.right = r.right;
  return a;
}

function move(dir) {
  const scope = activeScope();
  // A dialog that opened since: start inside it, not from what's behind it.
  const current = S.focused && S.focused.isConnected && (!scope || contains(scope, S.focused)) && isVisible(S.focused)
    ? S.focused : null;
  let from = current ? rectOf(current) : scope ? null : S.lastRect;
  // Only what lies ahead needs sampling for script-clickable elements.
  const area = from && onScreen(from) ? aheadOf(from, dir) : null;
  let cands = collect(scope, area);
  if (scope && !cands.length) cands = collect(null, area);
  if (!from || !onScreen(from)) {
    const pick = (from && reenter(dir, from, cands)) || initialPick(cands, dir);
    if (pick) return focusEl(pick.el);
    scrollStep(dir);
    return;
  }

  // Players draw their controls over the video, so they're never cleanly "below" it.
  // Treat the player as a unit: down from the video enters the control bar, up from
  // the bar returns to the video, and down from the bar leaves the player.
  const video = current && (current.tagName === 'VIDEO' ? current : playerVideoOf(current));
  if (video) {
    const player = playerOf(video, cands);
    if (current === video) {
      if (dir === 'down') {
        wakePlayer(video);
        if (player.controls.length) return focusEl(initialPick(player.controls, 'up').el);
        // Hidden while idle: they show after the wake-up, so focus one then. A player
        // with no controls of its own lets the next press move on below it.
        if (S.wokeVideo !== video || performance.now() - S.wokeAt > 1500) {
          S.wokeVideo = video;
          S.wokeAt = performance.now();
          return focusControlsSoon(video, playerRoot(video));
        }
      }
    } else {
      const inside = findBest(dir, from, player.controls, current);
      if (inside) return focusEl(inside.el);
      if (dir === 'up') return focusEl(video);
      if (dir === 'left' || dir === 'right') return; // end of the control bar
      from = player.box;
      cands = cands.filter((c) => player.controls.indexOf(c) < 0 && c.el !== video);
    }
  }

  let best = findBest(dir, from, cands, current);
  const span = dir === 'up' || dir === 'down' ? innerHeight : innerWidth;
  if (best && current && isPinned(best.el) && !isPinned(current)) {
    // A fixed header is "above" everything while the page is scrolled. Content comes
    // first; the header once the page can't scroll any further that way.
    const ahead = cands.filter((c) => c.el !== current && score(from, c.r, dir) && !isPinned(c.el));
    const content = findBest(dir, from, ahead, current);
    if (content && (content.primary <= span * FAR_JUMP || fullyOnScreen(content.r))) best = content;
    else if (scrollStep(dir)) return;
  }
  if (best && best.primary <= span * FAR_JUMP) return focusEl(best.el);
  // The nearest match is far off (a tall hero, long text). Something fully on screen in
  // that direction, even off to the side, comes first; otherwise scroll toward it.
  const near = findBest(dir, from, cands.filter((c) => fullyOnScreen(c.r)), current);
  if (near) return focusEl(near.el);
  if (scrollStep(dir)) return;
  if (best) focusEl(best.el);
}

function focusEl(el) {
  const previous = deepActiveElement();
  release();
  S.focused = el;
  S.focusedVisible = true;
  S.lastRect = rectOf(el);
  S.mouseActive = false;
  ensureUI();
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  S.ring.style.borderRadius = `${Math.min(Math.max(radius * S.zoomFix + 4, 6), 40)}px`;

  if (!isPinned(el)) reveal(el);
  if (!isTextField(el) && el.tabIndex >= 0 && typeof el.focus === 'function' && el.tagName !== 'IFRAME') {
    try {
      el.focus({ preventScroll: true });
    } catch (e) { /* not focusable */ }
  } else if (previous && previous !== el && isTextField(previous)) {
    previous.blur(); // don't leave an autofocused search box swallowing site shortcuts
  }
  // Hover only where it does something for a remote: it wakes player controls and opens
  // menus. Elsewhere it starts sites' hover previews (trailers, tooltips), which is slow.
  if (wantsHover(el)) {
    const token = ++S.hoverToken;
    setTimeout(() => {
      if (token !== S.hoverToken || S.focused !== el) return;
      if (el.tagName === 'VIDEO') wakePlayer(el); // its own player usually covers it
      else hover(el);
    }, 30);
  }
  raiseOverlay();
}

function wantsHover(el) {
  return el.tagName === 'VIDEO' || el.hasAttribute('aria-haspopup') || !!playerVideoOf(el);
}

/** Scrolls el into a comfortable spot, at once (smooth scrolling stutters on TVs). */
function reveal(el) {
  const r = rectOf(el);
  const vw = innerWidth;
  const vh = innerHeight;
  const needY = r.top < vh * 0.12 || r.bottom > vh * 0.88;
  const needX = r.left < vw * 0.04 || r.right > vw * 0.96;
  if (!needY && !needX) return false;
  el.scrollIntoView({
    behavior: 'instant', // not the default: sites set scroll-behavior: smooth
    block: needY ? (r.height > vh * 0.7 ? 'start' : 'center') : 'nearest',
    inline: needX ? 'center' : 'nearest',
  });
  return true;
}

function docScroller() {
  return document.scrollingElement || document.documentElement;
}

function canScroll(el, vertical, sign) {
  const doc = el === docScroller();
  const prop = vertical ? 'overflowY' : 'overflowX';
  if (doc) {
    if (getComputedStyle(document.documentElement)[prop] === 'hidden') return false;
    if (document.body && getComputedStyle(document.body)[prop] === 'hidden') return false;
  } else if (!/(auto|scroll|overlay)/.test(getComputedStyle(el)[prop])) {
    return false;
  }
  const pos = vertical ? el.scrollTop : el.scrollLeft;
  const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  return max > 2 && (sign > 0 ? pos < max - 2 : pos > 2);
}

function scrollerFor(start, vertical, sign) {
  for (let n = start; n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
    if (n.nodeType === 1 && canScroll(n, vertical, sign)) return n;
  }
  return canScroll(docScroller(), vertical, sign) ? docScroller() : null;
}

/** Fallback for app-like pages whose content scrolls inside a container, not the document. */
function largestScroller(vertical, sign) {
  let best = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (vertical ? el.scrollHeight <= el.clientHeight + 2 : el.scrollWidth <= el.clientWidth + 2) continue;
    const area = el.clientWidth * el.clientHeight;
    if (area > bestArea && canScroll(el, vertical, sign)) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function scrollStep(dir, amount) {
  const vertical = dir === 'up' || dir === 'down';
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  const focused = S.focused && S.focused.isConnected && onScreen(rectOf(S.focused)) ? S.focused : null;
  const start = focused || deepElementFromPoint(innerWidth / 2, innerHeight / 2);
  const target = (start && scrollerFor(start, vertical, sign)) || largestScroller(vertical, sign);
  if (!target) return false;
  const doc = target === docScroller();
  const size = vertical ? (doc ? innerHeight : target.clientHeight) : (doc ? innerWidth : target.clientWidth);
  const delta = Math.round(size * (amount || 0.6)) * sign;
  const opts = { behavior: 'instant' }; // not the default: sites set scroll-behavior: smooth
  opts[vertical ? 'top' : 'left'] = delta;
  (doc ? window : target).scrollBy(opts);
  return true;
}

// ------------------------------------------------------------------ synthetic input

const KEY_INFO = {
  Enter: { code: 'Enter', vk: 13 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
};

function fire(target, type, Ctor, init) {
  let event;
  try {
    event = new Ctor(type, init);
  } catch (e) {
    event = new MouseEvent(type, init); // no PointerEvent constructor
  }
  return target.dispatchEvent(event);
}

/** A key press the page can see. Untrusted, but most sites only read e.key / e.keyCode. */
function sendKey(target, key) {
  const info = KEY_INFO[key];
  const init = { key, code: info.code, keyCode: info.vk, which: info.vk, bubbles: true, cancelable: true, composed: true };
  const make = (type) => {
    const e = new KeyboardEvent(type, init);
    // Chromium ignores keyCode/which in the init dictionary; sites still check them.
    try {
      Object.defineProperty(e, 'keyCode', { get: () => info.vk });
      Object.defineProperty(e, 'which', { get: () => info.vk });
    } catch (err) { /* already defined */ }
    return e;
  };
  const allowed = target.dispatchEvent(make('keydown'));
  if (key === 'Enter') target.dispatchEvent(make('keypress'));
  target.dispatchEvent(make('keyup'));
  return allowed;
}

function hoverAt(el, pt) {
  if (!pt) return;
  const target = deepElementFromPoint(pt.x, pt.y) || el;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, view: window };
  const prev = S.hovered;
  S.synthMouseUntil = performance.now() + 400;
  if (prev && prev !== target && prev.isConnected) {
    fire(prev, 'pointerout', PointerEvent, init);
    fire(prev, 'mouseout', MouseEvent, init);
    fire(prev, 'mouseleave', MouseEvent, Object.assign({}, init, { bubbles: false }));
  }
  if (prev !== target) {
    fire(target, 'pointerover', PointerEvent, init);
    fire(target, 'mouseover', MouseEvent, init);
    fire(target, 'mouseenter', MouseEvent, Object.assign({}, init, { bubbles: false }));
  }
  S.hovered = target;
  fire(target, 'pointermove', PointerEvent, init);
  fire(target, 'mousemove', MouseEvent, init);
}

function hover(el) {
  hoverAt(el, clickPoint(el));
}

/**
 * Wakes a player's auto-hidden controls with a mouse move over it. Custom players
 * (flystream.net's) lay a click shield over the <video>, so the move goes to whatever is
 * on top in the middle of the picture: that's part of the player, and it bubbles there.
 */
function wakePlayer(video) {
  const r = box(video);
  hoverAt(video, { x: clamp(cx(r), 1, innerWidth - 2), y: clamp(cy(r), 1, innerHeight - 2) });
}

function anchorOf(el) {
  for (let n = el; n && n.nodeType === 1; n = parentOf(n)) if (n.tagName === 'A' && n.href) return n;
  return null;
}

/** Clicks el where a user would: pointer and mouse events at that spot, then click. */
function click(el) {
  const pt = clickPoint(el);
  const target = (pt && deepElementFromPoint(pt.x, pt.y)) || el;
  const a = anchorOf(target) || anchorOf(el);
  S.lastClick = { href: a ? a.href : null, at: Date.now() };
  hoverAt(el, pt);
  const init = {
    bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0, buttons: 1,
    clientX: pt ? pt.x : 0, clientY: pt ? pt.y : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
  };
  const up = Object.assign({}, init, { buttons: 0 });
  fire(target, 'pointerdown', PointerEvent, init);
  fire(target, 'mousedown', MouseEvent, init);
  fire(target, 'pointerup', PointerEvent, up);
  fire(target, 'mouseup', MouseEvent, up);
  // A dispatched click still runs default actions: links navigate, checkboxes toggle.
  fire(target, 'click', MouseEvent, up);
}

function activate(el) {
  if (isTextField(el)) return startEditing(el, true);
  if (sliderKind(el)) return engage(el);
  if (el.tagName === 'SELECT') return openPicker(el);
  if (el.tagName === 'VIDEO') return togglePlay(el);
  if (IS_TOP && el.tagName === 'IFRAME') {
    const r = rectOf(el);
    if (r.width * r.height >= PLAYER_FRAME_SHARE * innerWidth * innerHeight) return enterFrame(el);
  }
  // Search buttons often reveal and focus a text box: the focusin handler offers the
  // keyboard for a field focused this soon after OK.
  S.activatedAt = Date.now();
  click(el);
}

// ------------------------------------------------------------------ links and pop-ups

/** Opens url in this tab: one page at a time, like an app. */
function openInPlace(url) {
  if (!/^https?:/i.test(url)) return;
  if (IS_TOP) location.href = url;
  else post(window.top, { type: 'open', url });
}

// Links that would open a new tab open in place instead.
window.addEventListener('click', (e) => {
  if (e.defaultPrevented) return;
  const path = e.composedPath ? e.composedPath() : [e.target];
  const a = anchorOf(path[0]);
  if (!a || !a.target || /^_(self|parent|top)$/i.test(a.target)) return;
  if (!IS_TOP && a.target !== '_blank') return; // named frames
  e.preventDefault();
  openInPlace(a.href);
}, false);

// Ad tabs opened by click handlers are blocked: a link the user picked would carry a
// matching href. Everything else opens in place, since the TV has a single tab.
window.open = function (url, target, features) {
  let href;
  try {
    href = new URL(String(url || ''), location.href).href;
  } catch (e) {
    return null;
  }
  if (!/^https?:/i.test(href)) return null;
  const c = S.lastClick && Date.now() - S.lastClick.at < 1500 ? S.lastClick : null;
  const expected = (c && c.href && sameSite(href, c.href)) || sameSite(href, location.href);
  if (!expected && !(features && c)) {
    toast('Blocked a pop-up');
    return null;
  }
  openInPlace(href);
  return null;
};

// ------------------------------------------------------------------ embedded frames

/** Top frame: hands the remote to an iframe (typically a video player from another site). */
function enterFrame(frame) {
  S.inFrame = frame;
  post(frame.contentWindow, { type: 'enter' });
  try {
    frame.contentWindow.focus();
  } catch (e) { /* cross-origin focus refused */ }
  setMode('frame');
  toast('Player: ← → seek  ·  OK play/pause  ·  Back to leave', 2600);
}

/** Top frame: the entered iframe gave the remote back. */
function frameExited() {
  const frame = S.inFrame;
  S.inFrame = null;
  restMode();
  try {
    window.focus();
  } catch (e) { /* ignore */ }
  if (frame && frame.isConnected) focusEl(frame);
}

/** Top frame: an iframe claimed the remote (its player went fullscreen). */
function frameClaimed(source) {
  const frames = document.querySelectorAll('iframe');
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].contentWindow === source) {
      S.inFrame = frames[i];
      setMode('frame');
      return;
    }
  }
}

/** In an iframe: leave it and give the remote back to the top frame. */
function exitFrame() {
  S.active = false;
  S.focused = null;
  post(window.top, { type: 'frame-exit' });
}

// ------------------------------------------------------------------ video

function largestVideo(root) {
  let best = null;
  let bestArea = 0;
  for (const v of root.querySelectorAll('video')) {
    const r = box(v);
    if (r.width * r.height > bestArea) {
      best = v;
      bestArea = r.width * r.height;
    }
  }
  return best;
}

/** The video a control belongs to: the nearest player container's video, else the page's only one. */
function videoFor(el) {
  let n = el;
  for (let depth = 0; n && depth < 12; depth++, n = parentOf(n)) {
    if (n.tagName === 'VIDEO') return n;
    if (n.querySelector) {
      const v = largestVideo(n);
      if (v) return v;
    }
  }
  const all = document.querySelectorAll('video');
  return all.length === 1 ? all[0] : null;
}

/** 'seek' | 'volume' | 'slider' | null for the focused element. */
function sliderKind(el) {
  const role = el.getAttribute('role');
  const range = el.tagName === 'INPUT' && el.type === 'range';
  const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
  const looksLikeSeek = /progress|seek|scrub|timeline|time-?rail|playbar|position/.test(label);
  if (!range && role !== 'slider' && role !== 'progressbar' && !looksLikeSeek) return null;
  if (/volume|\bvol\b|sound|audio/.test(label)) return 'volume';
  const r = rectOf(el);
  if (!range && role !== 'slider' && r.width < r.height * 3) return null;
  if (looksLikeSeek || role === 'progressbar') return 'seek';
  // An unlabelled wide slider inside a player is almost always the seek bar.
  return r.width > innerWidth * 0.3 && videoFor(el) ? 'seek' : 'slider';
}

function seekableRange(video) {
  const s = video.seekable;
  if (s && s.length) return [s.start(0), s.end(s.length - 1)];
  return [0, isFinite(video.duration) ? video.duration : video.currentTime];
}

function formatTime(t) {
  if (!isFinite(t)) return '--:--';
  t = Math.max(0, t);
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function togglePlay(video) {
  if (video.paused) {
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    video.pause();
  }
  wakePlayer(video);
  toast(video.paused ? '❚❚  Paused' : '▶  Playing');
}

/**
 * Scrubbing: each press moves a preview marker; holding the key speeds it up.
 * The seek is applied once the presses stop (or on OK), so streams don't rebuffer per step.
 */
function scrub(video, sign) {
  const now = performance.now();
  let sc = S.scrub;
  if (!sc || sc.video !== video) {
    if (sc) commitScrub();
    sc = S.scrub = { video, target: video.currentTime, count: 0, last: 0, timer: null };
  }
  sc.count = now - sc.last < 600 ? sc.count + 1 : 0;
  sc.last = now;
  const step = SCRUB_STEPS[Math.min(sc.count, SCRUB_STEPS.length - 1)];
  const range = seekableRange(video);
  sc.target = clamp(sc.target + sign * step, range[0], Math.max(range[0], range[1] - 1));
  clearTimeout(sc.timer);
  sc.timer = setTimeout(commitScrub, SCRUB_COMMIT_MS);
  renderScrub();
  wakePlayer(video); // most players show their own controls on mouse movement
}

function commitScrub() {
  const sc = S.scrub;
  if (!sc) return;
  clearTimeout(sc.timer);
  S.scrub = null;
  sc.video.currentTime = sc.target;
  renderScrub(sc.video, sc.target);
  clearTimeout(S.scrubHideTimer);
  S.scrubHideTimer = setTimeout(() => S.scrubEl && S.scrubEl.classList.remove('on'), 1500);
}

function cancelScrub() {
  const sc = S.scrub;
  if (!sc) return false;
  clearTimeout(sc.timer);
  S.scrub = null;
  if (S.scrubEl) S.scrubEl.classList.remove('on');
  return true;
}

function renderScrub(committedVideo, committedTarget) {
  if (!ensureUI()) return;
  const sc = S.scrub;
  const video = sc ? sc.video : committedVideo;
  const target = sc ? sc.target : committedTarget;
  const range = seekableRange(video);
  const start = range[0];
  const span = Math.max(range[1] - start, 1);
  const pct = (t) => `${clamp(((t - start) / span) * 100, 0, 100)}%`;
  const el = S.scrubEl;
  let buffered = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime) buffered = Math.max(buffered, video.buffered.end(i));
  }
  const delta = target - video.currentTime;
  el.querySelector('.scrub-time').textContent = formatTime(target);
  el.querySelector('.scrub-delta').textContent = sc && Math.abs(delta) >= 1
    ? `${delta > 0 ? '+' : '−'}${formatTime(Math.abs(delta))}`
    : '';
  el.querySelector('.scrub-end').textContent = isFinite(video.duration) ? formatTime(video.duration) : 'LIVE';
  el.querySelector('.scrub-buffered').style.width = pct(buffered);
  el.querySelector('.scrub-played').style.width = pct(video.currentTime);
  const from = Math.min(video.currentTime, target);
  const spanEl = el.querySelector('.scrub-span');
  spanEl.style.left = pct(from);
  spanEl.style.width = `${clamp((Math.abs(delta) / span) * 100, 0, 100)}%`;
  el.querySelector('.scrub-knob').style.left = pct(target);
  placeScrubBar(el, video);
  el.classList.add('on');
  clearTimeout(S.scrubHideTimer);
  raiseOverlay();
}

/** Puts the preview bar over the lower part of the player it scrubs, clear of its control bar. */
function placeScrubBar(el, video) {
  const r = box(video);
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, innerWidth);
  const bottom = Math.min(r.bottom, innerHeight);
  const top = Math.max(r.top, 0);
  if (right - left < innerWidth * 0.3 || bottom - top < innerHeight * 0.2) {
    el.style.cssText = ''; // tiny or off-screen video: default spot along the bottom
    return;
  }
  const inset = (right - left) * 0.04;
  const height = el.offsetHeight || innerHeight * 0.12;
  const y = Math.max(top + 8, bottom - height - Math.max((bottom - top) * 0.16, 56));
  el.style.cssText = `left:${left + inset}px; right:auto; width:${right - left - inset * 2}px; top:${y}px; bottom:auto;`;
}

/** A video that's the main thing on screen: fullscreen, or a player iframe we were handed. */
function playerContext() {
  const fe = fullscreenEl();
  if (fe && !(fe instanceof HTMLIFrameElement)) {
    const video = fe instanceof HTMLVideoElement ? fe : largestVideo(fe);
    return video ? { root: fe, video } : null;
  }
  if (!fe && !IS_TOP) {
    const video = largestVideo(document);
    if (!video) return null;
    const r = box(video);
    if (r.width * r.height >= 0.4 * innerWidth * innerHeight) return { root: null, video };
  }
  return null;
}

/** Keys for a player with no control focused: scrub, play/pause, or reach the controls. */
function playerKey(key) {
  const ctx = playerContext();
  if (!ctx) return false;
  const root = ctx.root;
  const video = ctx.video;
  wakePlayer(video); // any key shows the player's controls, as a mouse move would
  // (A focused player box, which the site may focus itself, isn't a control.)
  const inControls = S.focused && S.focused !== video && !contains(S.focused, video) && S.focused.isConnected &&
    (!root || contains(root, S.focused));
  if (inControls) return false;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight':
      scrub(video, key === 'ArrowRight' ? 1 : -1);
      return true;
    case 'Enter':
      if (S.scrub) commitScrub();
      else togglePlay(video);
      return true;
    case 'ArrowUp':
    case 'ArrowDown':
      commitScrub();
      focusControlsSoon(video, root);
      return true;
    default:
      return false;
  }
}

/** Media keys on the remote: they act on the main video wherever focus is. */
function mediaKey(key) {
  const ctx = playerContext();
  const video = (ctx && ctx.video) || largestVideo(document);
  if (!video) {
    if (IS_TOP) broadcast(window, { type: 'media', key }); // the player may live in an iframe
    return;
  }
  switch (key) {
    case 'PlayPause':
      return togglePlay(video);
    case 'Play':
      if (video.paused) togglePlay(video);
      return;
    case 'Pause':
    case 'Stop':
      if (!video.paused) togglePlay(video);
      return;
    case 'Rewind':
    case 'FastForward':
      return scrub(video, key === 'FastForward' ? 1 : -1);
  }
}

/**
 * Sliders sit in rows with other controls, so arrows pass over them; OK takes one over
 * (ring turns gold): left/right adjust, OK keeps, Back undoes a pending scrub, up/down leave.
 */
function engage(el) {
  S.engaged = el;
  S.ring.classList.add('engaged');
  toast(sliderKind(el) === 'seek' ? '← → to scrub  ·  OK to jump there' : '← → to adjust  ·  OK when done', 2000);
}

function release() {
  S.engaged = null;
  if (S.ring) S.ring.classList.remove('engaged');
}

function engagedKey(key) {
  const el = S.engaged;
  if (!el.isConnected || el !== S.focused) {
    release();
    return false;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') return adjust(el, key === 'ArrowRight' ? 1 : -1);
  if (key === 'Enter') {
    commitScrub();
    release();
    return true;
  }
  if (key === 'Back') {
    cancelScrub();
    release();
    return true;
  }
  commitScrub();
  release();
  return false; // up/down: move on as usual
}

/** Left/right on a playing video that has focus scrub it (up/down still leave it). */
function videoKey(key) {
  const el = S.focused;
  if ((key !== 'ArrowLeft' && key !== 'ArrowRight') || !el || el.tagName !== 'VIDEO' || !el.isConnected) return false;
  if (el.currentTime === 0 && el.paused) return false; // not started: plain navigation
  scrub(el, key === 'ArrowRight' ? 1 : -1);
  return true;
}

function adjust(el, sign) {
  const kind = sliderKind(el);
  if (!kind) return false;
  if (kind === 'seek') {
    const video = videoFor(el);
    if (video) {
      scrub(video, sign);
      return true;
    }
  }
  if (el.tagName === 'INPUT') {
    const min = parseFloat(el.min) || 0;
    const max = el.max === '' ? 100 : parseFloat(el.max);
    const step = parseFloat(el.step) > 0 ? Math.max(parseFloat(el.step), (max - min) / 20) : (max - min) / 20;
    const value = clamp(parseFloat(el.value) + sign * step, min, max);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus({ preventScroll: true });
    sendKey(el, sign > 0 ? 'ArrowRight' : 'ArrowLeft'); // ARIA sliders handle arrow keys themselves
  }
  if (kind === 'volume') {
    const video = videoFor(el);
    if (video) setTimeout(() => toast(`Volume ${Math.round(video.volume * 100)}%`), 50);
  }
  return true;
}

function back() {
  if (S.engaged) {
    cancelScrub();
    release();
    return;
  }
  if (cancelScrub()) return;
  const fe = fullscreenEl();
  if (fe && !(fe instanceof HTMLIFrameElement)) {
    const hasVideo = fe instanceof HTMLVideoElement || !!fe.querySelector('video');
    if (hasVideo && S.focused && S.focused.tagName !== 'VIDEO' && contains(fe, S.focused)) {
      // Leave the controls, back to plain playback. Drop the page's focus as well, or a
      // site's own highlight (flystream's TV mode) stays on the control.
      const active = deepActiveElement();
      if (active && active !== document.body && contains(fe, active)) active.blur();
      S.focused = null;
      return;
    }
    leaveFullscreen();
    return;
  }
  const modal = findModal();
  if (modal && S.escapedModal !== modal) {
    // Most dialogs close on Escape. If this one ignores it, the next Back leaves the page.
    S.escapedModal = modal;
    sendKey(deepActiveElement() || document.body, 'Escape');
    return;
  }
  if (!IS_TOP) {
    const ctx = playerContext();
    if (ctx && S.focused && S.focused !== ctx.video) {
      S.focused = null; // controls -> plain playback, then out of the frame
      return;
    }
    exitFrame();
    return;
  }
  goBack();
}

// ------------------------------------------------------------------ on-screen keyboard

function enterLabel(el) {
  const hint = { search: 'Search', go: 'Go', send: 'Send', next: 'Next', done: 'Done', enter: '↵' }[el.enterKeyHint];
  if (hint) return hint;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return '↵';
  if (el.type === 'search' || (el.closest && el.closest('[role="search"]'))) return 'Search';
  return 'Go';
}

/**
 * Tizen opens its own on-screen keyboard for any focused editable field, on top of ours.
 * Read-only fields don't get it, so a field stays read-only while our keyboard edits it;
 * edits set the value directly, which read-only doesn't block.
 */
function guard(el) {
  if ((el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') || el.readOnly) return;
  el.readOnly = true;
  S.guarded = el;
}

function unguard() {
  const el = S.guarded;
  S.guarded = null;
  if (el) el.readOnly = false;
}

function startEditing(el, withClick) {
  stopEditing();
  guard(el);
  if (withClick) click(el);
  el.focus({ preventScroll: true });
  ensureUI();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const kind = type === 'email' ? 'email'
    : type === 'url' ? 'url'
      : type === 'number' || type === 'tel' || el.inputMode === 'numeric' || el.inputMode === 'decimal' ? 'number'
        : 'text';
  S.editing = el;
  const osk = new Keyboard(S.shadow, { kind, enterLabel: enterLabel(el), onKey: onKeyboardKey });
  S.osk = osk;
  setMode('osk');
  updatePreview();
  // Keep the field visible above the keyboard.
  const r = rectOf(el);
  if (!isPinned(el) && (r.bottom > innerHeight * 0.5 || r.top < 0)) {
    el.scrollIntoView({ behavior: 'instant', block: 'start' });
    window.scrollBy({ top: -innerHeight * 0.18, behavior: 'instant' });
  }
}

function stopEditing() {
  if (!S.osk) return;
  const el = S.editing;
  S.osk.destroy();
  S.osk = null;
  S.editing = null;
  // Leave the field before it becomes editable again, or the TV's keyboard opens for it.
  if (el && el === S.guarded && deepActiveElement() === el) el.blur();
  unguard();
  restMode();
}

function editTarget() {
  const el = S.editing;
  if (el && deepActiveElement() !== el) el.focus({ preventScroll: true });
  return el;
}

function setNativeValue(el, value, inputType, data) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // The prototype setter, so frameworks that wrap .value (React) notice the change.
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  let event;
  try {
    event = new InputEvent('input', { bubbles: true, inputType: inputType || 'insertText', data: data == null ? null : data });
  } catch (e) {
    event = new Event('input', { bubbles: true });
  }
  el.dispatchEvent(event);
}

function selection(el) {
  try {
    if (typeof el.selectionStart === 'number') return [el.selectionStart, el.selectionEnd];
  } catch (e) { /* email/number inputs have no selection API */ }
  return [el.value.length, el.value.length];
}

/** Replaces the selection with text (or deletes the character before the caret). */
function replaceSelection(el, text, deleteBack) {
  const sel = selection(el);
  const from = deleteBack && sel[0] === sel[1] ? Math.max(0, sel[0] - 1) : sel[0];
  let insert = text;
  if (el.maxLength > 0) insert = insert.slice(0, Math.max(0, el.maxLength - (el.value.length - (sel[1] - from))));
  if (!insert && !deleteBack) return;
  setNativeValue(el, el.value.slice(0, from) + insert + el.value.slice(sel[1]), insert ? 'insertText' : 'deleteContentBackward', insert || null);
  try {
    el.setSelectionRange(from + insert.length, from + insert.length);
  } catch (e) { /* no caret in this input type */ }
}

function editText(action, text) {
  const el = editTarget();
  if (!el) return;
  if (el.isContentEditable) {
    // Rich editors need execCommand. They can't be made read-only, so the TV's keyboard may show.
    if (action === 'clear') window.getSelection().selectAllChildren(el);
    document.execCommand(action === 'insert' ? 'insertText' : 'delete', false, text);
    return;
  }
  if (action === 'insert') replaceSelection(el, text, false);
  else if (action === 'delete') replaceSelection(el, '', true);
  else if (action === 'clear') setNativeValue(el, '', 'deleteContent');
}

function moveCaret(sign) {
  const el = editTarget();
  if (!el) return;
  if (el.isContentEditable) {
    window.getSelection().modify('move', sign < 0 ? 'backward' : 'forward', 'character');
    return;
  }
  try {
    const sel = selection(el);
    const pos = clamp(sign < 0 ? sel[0] - 1 : sel[1] + 1, 0, el.value.length);
    el.setSelectionRange(pos, pos);
  } catch (e) { /* no caret in this input type */ }
}

/** Submits like pressing Enter would, running the form's submit handlers (no requestSubmit in M69). */
function submitForm(form) {
  const submitter = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
  if (submitter && !submitter.disabled) return submitter.click();
  const tmp = document.createElement('input');
  tmp.type = 'submit';
  tmp.style.display = 'none';
  form.appendChild(tmp);
  tmp.click();
  form.removeChild(tmp);
}

function pressEnter() {
  const el = editTarget();
  if (!el) return;
  if (el.isContentEditable) {
    if (sendKey(el, 'Enter')) document.execCommand('insertParagraph', false);
    return;
  }
  if (el.tagName === 'TEXTAREA') {
    if (sendKey(el, 'Enter')) replaceSelection(el, '\n', false);
    return;
  }
  if (sendKey(el, 'Enter') && el.form) submitForm(el.form);
}

/** The TV's keyboard, if it does open (e.g. for a rich editor): Done submits, Cancel closes it. */
function imeKey(done) {
  const el = deepActiveElement();
  if (!el || !(isTextField(el) || el === S.guarded)) return;
  if (done && el.tagName === 'INPUT' && sendKey(el, 'Enter') && el.form) submitForm(el.form);
  el.blur();
}

function onKeyboardKey(action, value) {
  switch (action) {
    case 'char':
      editText('insert', value);
      break;
    case 'backspace':
      editText('delete');
      break;
    case 'clear':
      editText('clear');
      break;
    case 'left':
      moveCaret(-1);
      break;
    case 'right':
      moveCaret(1);
      break;
    case 'enter': {
      const el = S.editing;
      const multiline = el && (el.tagName === 'TEXTAREA' || el.isContentEditable);
      pressEnter();
      if (!multiline) stopEditing();
      break;
    }
    case 'done':
      stopEditing();
      break;
  }
  setTimeout(updatePreview, 40);
}

function updatePreview() {
  const el = S.editing;
  if (!S.osk || !el) return;
  let text = el.isContentEditable ? el.innerText : String(el.value == null ? '' : el.value);
  if (el.type === 'password') text = '•'.repeat(text.length);
  S.osk.setPreview(text, el.placeholder || el.getAttribute('aria-label') || '');
}

document.addEventListener('input', () => setTimeout(updatePreview, 0), true);

// ------------------------------------------------------------------ <select> picker

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function openPicker(sel) {
  const options = Array.prototype.slice.call(sel.options);
  if (!options.length) return;
  ensureUI();
  const wrap = h('div', 'picker');
  const panel = h('div', 'picker-panel');
  const label = sel.getAttribute('aria-label') || (sel.labels && sel.labels[0] && sel.labels[0].textContent.trim());
  panel.appendChild(h('div', 'picker-title', label || 'Choose an option'));
  const items = options.map((o, i) => {
    const item = h('div', 'picker-item');
    item.appendChild(h('span', '', o.label || o.textContent));
    item.appendChild(h('span', 'check', ''));
    item.addEventListener('click', () => {
      S.picker.index = i;
      choosePicked();
    });
    panel.appendChild(item);
    return item;
  });
  wrap.appendChild(panel);
  S.shadow.appendChild(wrap);
  S.picker = { sel, options, items, wrap, index: Math.max(0, sel.selectedIndex) };
  setMode('picker');
  renderPicker();
}

function renderPicker() {
  const p = S.picker;
  p.items.forEach((item, i) => {
    item.classList.toggle('on', i === p.index);
    item.classList.toggle('dis', p.options[i].disabled);
    item.lastChild.textContent = p.options[i].selected ? '✓' : '';
  });
  p.items[p.index].scrollIntoView({ block: 'nearest' });
}

function choosePicked() {
  const p = S.picker;
  const option = p.options[p.index];
  if (option.disabled) return;
  if (p.sel.multiple) {
    option.selected = !option.selected;
  } else {
    // Use the prototype setter so frameworks that wrap .value (React) notice the change.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(p.sel, option.value);
  }
  p.sel.dispatchEvent(new Event('input', { bubbles: true }));
  p.sel.dispatchEvent(new Event('change', { bubbles: true }));
  if (p.sel.multiple) renderPicker();
  else closePicker();
}

function closePicker() {
  if (!S.picker) return;
  S.picker.wrap.remove();
  S.picker = null;
  restMode();
}

function pickerKey(key) {
  const p = S.picker;
  if (key === 'Back') return closePicker();
  if (key === 'Enter') return choosePicked();
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    p.index = clamp(p.index + (key === 'ArrowDown' ? 1 : -1), 0, p.options.length - 1);
    renderPicker();
  }
}

// ------------------------------------------------------------------ key dispatch

const MEDIA_KEYS = { PlayPause: 1, Play: 1, Pause: 1, Stop: 1, Rewind: 1, FastForward: 1 };

function onKey(key, repeat) {
  const start = performance.now();
  // Held keys: a repeat that queued up while the last press was still being handled
  // (a slow TV) is dropped, or focus keeps running after the key is let go.
  if (repeat && start - S.lastKeyAt < REPEAT_MS) return;
  resetStyleCache(); // the page may have changed since the last press
  S.hits = { grid: 0, click: 0, pinned: 0 }; // hit tests this press, for debugging
  try {
    handleKey(key, repeat);
  } finally {
    S.lastKeyAt = performance.now();
    S.lastKeyMs = Math.round(S.lastKeyAt - start);
  }
}

function handleKey(key, repeat) {
  S.mouseActive = false;
  ensureUI();

  if (IS_TOP && S.mode === 'frame') {
    // Keys only reach us in frame mode when the frame went away.
    S.inFrame = null;
    restMode();
  }
  if (MEDIA_KEYS[key]) return mediaKey(key);
  if (S.picker) return pickerKey(key);
  if (S.osk) {
    if (key === 'Back') return stopEditing();
    if (key === 'Enter') return S.osk.press();
    if (DIRS[key]) S.osk.move(DIRS[key]);
    return;
  }
  if (key === 'Back') return back();
  // A player's controls hide when idle with focus still on one: the first key only
  // brings them back (as on TV apps), instead of navigating away from an invisible control.
  const shownBy = S.focused && S.focused.isConnected && S.focused.tagName !== 'VIDEO' && playerVideoOf(S.focused);
  if (shownBy && !isVisible(S.focused, true)) {
    wakePlayer(shownBy);
    return;
  }
  if (S.engaged && engagedKey(key)) return;
  if (S.scrub && key === 'Enter') return commitScrub();
  if (playerKey(key)) return;
  if (videoKey(key)) return;
  if (S.scrub) commitScrub();
  if (key === 'PageDown' || key === 'PageUp') {
    scrollStep(key === 'PageDown' ? 'down' : 'up', 0.85);
    return;
  }
  if (DIRS[key]) return move(DIRS[key]);
  if (key === 'Enter' && !repeat) {
    if (S.focused && S.focused.isConnected) activate(S.focused);
    else move('down');
  }
}

// A real pointer (Samsung's air-pointer remotes) takes over from the D-pad; typing into
// a field clicked with it should get the arrow keys too.
window.addEventListener('mousemove', (e) => {
  if (!e.isTrusted || performance.now() < S.synthMouseUntil) return;
  if (Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
  S.mouseActive = true;
}, { capture: true, passive: true });

document.addEventListener('focusin', () => {
  const active = deepActiveElement();
  if (S.osk || !active) return;
  if (!isTextField(active)) {
    // The site moved focus itself (a dialog's default button, its own TV mode): follow it.
    // Not a whole player or page section, though (flystream focuses its player box):
    // arrows find nothing from something the size of the screen.
    const r = rectOf(active);
    if (active !== S.focused && active !== document.body && !S.shell && !S.mouseActive && S.mode === 'nav' &&
      active.matches && active.matches(SELECTOR) && active.tagName !== 'IFRAME' && onScreen(r) &&
      r.width * r.height < 0.5 * innerWidth * innerHeight && !active.querySelector('video')) {
      release();
      S.focused = active;
      S.focusedVisible = true;
      S.lastRect = rectOf(active);
    }
    return;
  }
  if (S.mouseActive) {
    S.typing = active;
    restMode();
    return;
  }
  if (S.mode === 'passthrough' || S.shell) return; // the site drives itself
  // The site focused a field by itself, and the TV opens its keyboard for any focused
  // field. Right after OK (a search icon revealing a box) offer ours; otherwise let go.
  if (Date.now() - S.activatedAt < 1000 && onScreen(rectOf(active))) {
    focusEl(active);
    startEditing(active, false);
  } else {
    active.blur();
  }
}, true);

document.addEventListener('focusout', () => {
  if (!S.typing) return;
  setTimeout(() => {
    if (deepActiveElement() === S.typing) return;
    S.typing = null;
    restMode();
  }, 0);
}, true);

onFullscreenChange(() => {
  const fe = fullscreenEl();
  if (fe) {
    // Focus on one of the player's own controls (its fullscreen button) stays, so the
    // arrows move along the controls the viewer is looking at. Otherwise plain playback:
    // left/right scrub, OK plays/pauses, down reaches the controls.
    S.beforeFullscreen = S.focused;
    const onControl = S.focused && S.focused.isConnected && S.focused.tagName !== 'VIDEO' && contains(fe, S.focused);
    if (!onControl) S.focused = null;
  } else if (!S.focused || !S.focused.isConnected || !isVisible(S.focused, true)) {
    // Back where focus was before fullscreen (the fullscreen button), not nowhere.
    const back = S.beforeFullscreen;
    S.focused = back && back.isConnected && isVisible(back, true) ? back : null;
    if (S.focused) S.lastRect = rectOf(S.focused);
  }
  // A player iframe going fullscreen takes the remote with it.
  if (!IS_TOP && fe && !S.active) {
    S.active = true;
    post(window.top, { type: 'claim' });
  }
  restMode();
  placeHost();
  raiseOverlay();
});

// ------------------------------------------------------------------ zoom

/** Page zoom with CSS zoom on <body>, so our overlay (outside body) stays unzoomed. */
function applyZoom(zoom) {
  S.zoom = zoom;
  if (!document.body) return;
  document.body.style.zoom = zoom === 1 ? '' : String(zoom);
  S.zoomFix = measureZoomFix();
}

/**
 * Engines disagree on whether rects inside a zoomed element are in zoomed or screen
 * pixels (Chromium changed it in M128). Measure instead of guessing.
 */
function measureZoomFix() {
  if (S.zoom === 1 || !document.body) return 1;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:1px;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  return Math.abs(w - 100) < 1 ? S.zoom : 1;
}

function setZoom(delta) {
  const zoom = delta === 0 ? 1 : Math.round(clamp(S.zoom + delta, 0.5, 3) * 100) / 100;
  updateSiteSettings({ zoom });
  applyZoom(zoom);
  toast(`Page size ${Math.round(zoom * 100)}%`);
}

// ------------------------------------------------------------------ overlay UI

// No transitions or animations: on a TV they cost frames, and the remote should feel instant.
const UI_CSS = `
.ring {
  position: fixed; left: 0; top: 0; width: 0; height: 0; box-sizing: border-box;
  border-radius: 8px; display: none; pointer-events: none; will-change: transform;
  box-shadow: 0 0 0 3px #fff, 0 0 0 7px #3d8bff;
}
.ring.on { display: block; }
.ring.engaged { box-shadow: 0 0 0 3px #fff, 0 0 0 7px #ffc83d; }
.toast {
  position: fixed; left: 50%; top: 5vh; transform: translateX(-50%);
  padding: 1.4vh 3vh; border-radius: 99px; background: rgba(15, 17, 24, .92); color: #fff;
  font: 600 2.5vh "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif; white-space: nowrap;
  display: none; pointer-events: none; z-index: 3;
}
.toast.on { display: block; }
.scrub {
  position: fixed; left: 5vw; right: 5vw; bottom: 5vh; padding: 2.2vh 2.8vh 2.6vh;
  border-radius: 2.2vh; background: rgba(12, 14, 20, .92); color: #fff;
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif;
  display: none; pointer-events: none;
}
.scrub.on { display: block; }
.scrub-head { display: flex; align-items: baseline; margin-bottom: 1.8vh; font-variant-numeric: tabular-nums; }
.scrub-time { font-size: 3.6vh; font-weight: 700; }
.scrub-delta { margin-left: 1.6vh; font-size: 2.4vh; font-weight: 600; color: #6fb0ff; }
.scrub-end { margin-left: auto; font-size: 2.3vh; color: rgba(255, 255, 255, .6); }
.scrub-track { position: relative; height: 1vh; border-radius: 1vh; background: rgba(255, 255, 255, .18); }
.scrub-buffered, .scrub-played, .scrub-span { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 1vh; }
.scrub-buffered { background: rgba(255, 255, 255, .25); }
.scrub-played { background: rgba(255, 255, 255, .75); }
.scrub-span { background: #3d8bff; }
.scrub-knob {
  position: absolute; top: 50%; width: 2.8vh; height: 2.8vh; margin: -1.4vh 0 0 -1.4vh;
  border-radius: 50%; background: #fff; box-shadow: 0 0 0 .5vh #3d8bff;
}
.picker {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .55); pointer-events: auto;
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif; color: #f4f6fb;
}
.picker-panel {
  width: 64vw; max-width: 90vh; max-height: 78vh; overflow: auto; padding: 2.4vh; border-radius: 2.4vh;
  background: #161a23; box-shadow: 0 2vh 7vh rgba(0, 0, 0, .6);
}
.picker-panel::-webkit-scrollbar { display: none; }
.picker-title { font-size: 2.1vh; opacity: .6; margin: 0 1.6vh 1.4vh; text-transform: uppercase; letter-spacing: .1em; }
.picker-item {
  display: flex; justify-content: space-between; padding: 1.7vh 2.2vh;
  border-radius: 1.3vh; font-size: 2.9vh; cursor: pointer;
}
.picker-item.on { background: #fff; color: #0b0d12; }
.picker-item.dis { opacity: .35; }
.picker-item .check { margin-left: 2vh; color: #3d8bff; font-weight: 700; }
`;

const HOST_CSS = [
  'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh', 'max-width:none', 'max-height:none',
  'margin:0', 'padding:0', 'border:0', 'background:transparent', 'overflow:visible', 'display:block',
  'pointer-events:none', 'z-index:2147483647', 'transform:none', 'filter:none', 'opacity:1', 'zoom:1',
  'visibility:visible', 'color-scheme:normal',
].map((rule) => `${rule} !important`).join(';');

function buildScrubBar() {
  const bar = h('div', 'scrub');
  const head = h('div', 'scrub-head');
  head.append(h('span', 'scrub-time'), h('span', 'scrub-delta'), h('span', 'scrub-end'));
  const track = h('div', 'scrub-track');
  track.append(h('div', 'scrub-buffered'), h('div', 'scrub-played'), h('div', 'scrub-span'), h('div', 'scrub-knob'));
  bar.append(head, track);
  return bar;
}

function ensureUI() {
  if (!document.documentElement) return false;
  if (!S.host) {
    const host = document.createElement('browseros-remote');
    if (HAS_POPOVER) host.setAttribute('popover', 'manual');
    host.style.cssText = HOST_CSS;
    const shadow = host.attachShadow({ mode: 'closed' });
    addStyles(shadow, UI_CSS);
    S.ring = h('div', 'ring');
    S.toastEl = h('div', 'toast');
    S.scrubEl = buildScrubBar();
    shadow.append(S.ring, S.scrubEl, S.toastEl);
    S.host = host;
    S.shadow = shadow;
  }
  if (!S.host.isConnected) {
    document.documentElement.appendChild(S.host);
    placeHost();
    showOverlay();
  }
  return true;
}

/**
 * Without the top layer, a fullscreen element hides everything outside it, so the
 * overlay moves inside it. (A fullscreen <video> or <iframe> can't hold it.)
 */
function placeHost() {
  if (!S.host || HAS_POPOVER) return;
  const fe = fullscreenEl();
  const parent = fe && fe.tagName !== 'VIDEO' && fe.tagName !== 'IFRAME' ? fe : document.documentElement;
  if (parent && S.host.parentNode !== parent) parent.appendChild(S.host);
}

function showOverlay() {
  if (!HAS_POPOVER) return;
  try {
    S.host.showPopover(); // top layer: above the page's own z-index wars
  } catch (e) { /* not connected yet */ }
}

/** Re-enter the top layer so we stay above dialogs/fullscreen elements opened after us. */
function raiseOverlay() {
  if (!S.host || !S.host.isConnected) return;
  if (!HAS_POPOVER) {
    // Last child of its parent wins z-index ties with the page's own max-z overlays.
    if (S.host.nextSibling) S.host.parentNode.appendChild(S.host);
    return;
  }
  if (!fullscreenEl() && !hasOpenModal()) return;
  try {
    S.host.hidePopover();
  } catch (e) { /* already hidden */ }
  showOverlay();
}

function toast(text, ms) {
  if (!ensureUI()) return;
  S.toastEl.textContent = text;
  S.toastEl.classList.add('on');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => S.toastEl.classList.remove('on'), ms || 1400);
}

function tick() {
  requestAnimationFrame(tick);
  const ring = S.ring;
  if (!ring) return;
  const el = S.focused;
  let r = null;
  if (el && el.isConnected && !S.mouseActive && !S.shell && S.mode !== 'passthrough' && S.mode !== 'frame') {
    r = rectOf(el);
    if (r.width === 0 && r.height === 0) r = null;
    // Hidden since it was focused (a page swapped to a player)? No ring around nothing.
    // Checked every few frames: the fallback walks ancestors' styles.
    if (r && ++S.visibleTick % 8 === 0) S.focusedVisible = isVisible(el, true);
    if (r && S.focusedVisible === false) r = null;
  }
  if (!r) {
    if (S.ringShown) {
      ring.classList.remove('on');
      S.ringShown = false;
    }
    return;
  }
  S.lastRect = r;
  const pad = 4;
  const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
  if (key !== S.ringKey) {
    S.ringKey = key;
    ring.style.transform = `translate(${r.left - pad}px, ${r.top - pad}px)`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;
  }
  if (!S.ringShown) {
    ring.classList.add('on');
    S.ringShown = true;
  }
}

// ---- shell.js
// The TV shell: home screen, the in-page menu and the address/search screen (ported
// from the Electron build's src/shell/). It draws inside the top frame's overlay. The
// home screen is its own page (HOME_URL); the menu and address screen open over any site.

const SHELL_CSS = `
.shell {
  --text: #f4f6fb; --muted: #9aa3b5; --accent: #3d8bff;
  --card: rgba(255, 255, 255, .06); --card-hi: rgba(255, 255, 255, .15);
  display: none; position: fixed; top: 0; right: 0; bottom: 0; left: 0;
  color: var(--text); pointer-events: auto; user-select: none; cursor: default;
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif;
}
.shell * { box-sizing: border-box; }
.shell.open { display: block; }
.screen { display: none; position: absolute; top: 0; right: 0; bottom: 0; left: 0; }
.shell[data-mode="home"] .s-home,
.shell[data-mode="menu"] .s-menu,
.shell[data-mode="search"] .s-search { display: block; }
.shell svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

[data-nav].focused {
  background: var(--card-hi); box-shadow: 0 0 0 .45vh #fff, 0 0 0 .9vh #3d8bff; position: relative; z-index: 1;
}

.s-home {
  padding: 5vh 6vw 10vh; overflow-y: auto;
  background:
    radial-gradient(120vh 80vh at 12% -15%, #1c2a4d 0%, transparent 60%),
    radial-gradient(100vh 70vh at 105% 115%, #2b1d44 0%, transparent 55%),
    #0b0d12;
}
.s-home::-webkit-scrollbar { display: none; }
.top { display: flex; justify-content: space-between; align-items: center; }
.brand { display: flex; align-items: center; font-size: 3.2vh; font-weight: 700; letter-spacing: .02em; }
.logo { width: 3.8vh; height: 3.8vh; margin-right: 1.4vh; border-radius: 1.1vh; background: linear-gradient(135deg, #3d8bff, #9b5cff); }
.clock { font-size: 3.4vh; font-weight: 300; color: var(--muted); font-variant-numeric: tabular-nums; }
.search-pill {
  margin-top: 4.5vh; width: 95vh; max-width: 100%; height: 7.6vh; padding: 0 3.2vh;
  display: flex; align-items: center; border-radius: 99px;
  background: var(--card); color: var(--muted); font-size: 2.6vh;
}
.search-pill svg { width: 3.2vh; height: 3.2vh; margin-right: 1.8vh; flex: none; }
.search-pill.focused { color: var(--text); }
.shell h2 {
  margin: 5vh 0 2.2vh; font-size: 2vh; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted);
}
.continue {
  width: 95vh; max-width: 100%; display: flex; align-items: center;
  padding: 2.2vh 3vh; border-radius: 2.2vh; background: var(--card);
}
.continue .icon { width: 7.5vh; height: 7.5vh; margin-right: 2.6vh; border-radius: 1.8vh; }
.continue-text { min-width: 0; }
.continue-title, .continue-url { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.continue-title { font-size: 2.9vh; font-weight: 600; }
.continue-url { margin-top: .6vh; font-size: 2vh; color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-gap: 3vh; }
.tile {
  position: relative; display: flex; flex-direction: column; align-items: center;
  padding: 3.2vh 1.5vh 2.6vh; border-radius: 2.4vh; background: var(--card);
}
.tile .icon { width: 10vh; height: 10vh; margin-bottom: 1.8vh; border-radius: 2.6vh; }
.tile-name { max-width: 100%; font-size: 2.2vh; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile.add .icon { background: transparent; border: .35vh dashed rgba(255, 255, 255, .3); }
.tile.add svg { width: 4.4vh; height: 4.4vh; color: var(--muted); }
.tile.removing { background: #6b1f2a; }
.tile.removing::after {
  content: 'OK removes · Back cancels'; position: absolute; left: 0; right: 0; bottom: -3.6vh;
  text-align: center; font-size: 1.7vh; color: #ffb3bd; white-space: nowrap;
}
.icon {
  --hue: 220; flex: none; display: flex; align-items: center; justify-content: center;
  overflow: hidden; background: hsl(var(--hue), 42%, 28%);
}
.icon .letter { font-size: 4.4vh; font-weight: 700; color: hsl(var(--hue), 80%, 88%); }
.continue .icon .letter, .menu-info .icon .letter { font-size: 3.2vh; }
.icon img { width: 62%; height: 62%; object-fit: contain; }
.hint { margin-top: 5vh; font-size: 1.9vh; color: var(--muted); }

.s-menu {
  background: linear-gradient(to top, rgba(5, 6, 10, .97) 0%, rgba(5, 6, 10, .88) 34%, rgba(5, 6, 10, 0) 66%);
}
.menu-panel { position: absolute; left: 6vw; right: 6vw; bottom: 6vh; }
.menu-info { display: flex; align-items: center; margin-bottom: 3.6vh; }
.menu-info .icon { width: 6.4vh; height: 6.4vh; margin-right: 2.2vh; border-radius: 1.6vh; }
.menu-text { min-width: 0; }
.menu-title, .menu-url { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.menu-title { font-size: 3vh; font-weight: 600; }
.menu-url { margin-top: .5vh; font-size: 2vh; color: var(--muted); }
.menu-row { display: flex; flex-wrap: wrap; margin: -0.9vh; }
.mi {
  width: 13vh; margin: .9vh; padding: 2.2vh 0 1.8vh; display: flex; flex-direction: column; align-items: center;
  border-radius: 2vh; background: rgba(255, 255, 255, .09); font-size: 1.85vh; text-align: center;
}
.mi svg { width: 4vh; height: 4vh; margin-bottom: 1.3vh; }
.mi.disabled { opacity: .35; }
.mi.active svg { fill: currentColor; }
.mi.active { color: #ffd166; }
.menu-hint { margin-top: 2.6vh; min-height: 2.8vh; font-size: 2.1vh; color: var(--muted); }

.s-search { background: rgba(8, 10, 16, .95); }
.search-box { position: absolute; top: 12vh; left: 50%; transform: translateX(-50%); width: 90vw; max-width: 140vh; }
.search-label { margin-bottom: 1.8vh; font-size: 2.3vh; color: var(--muted); }
.search-input {
  width: 100%; height: 9vh; padding: 0 3vh; border: 0; border-radius: 1.8vh;
  outline: .4vh solid var(--accent); background: #1a1f2b; color: var(--text);
  caret-color: var(--accent); font-family: inherit; font-size: 3.4vh;
}
.search-input::placeholder { color: rgba(244, 246, 251, .35); }
`;

// Icons as [tag, attributes] lists: built with createElementNS, no innerHTML (Trusted Types).
const ICONS = {
  back: [['path', { d: 'M19 12H5M12 19l-7-7 7-7' }]],
  forward: [['path', { d: 'M5 12h14M12 5l7 7-7 7' }]],
  reload: [['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }], ['path', { d: 'M21 3v6h-6' }]],
  home: [['path', { d: 'M3 11l9-8 9 8' }], ['path', { d: 'M5 10v10h14V10' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
  smaller: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4M8 11h6' }]],
  bigger: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4M8 11h6M11 8v6' }]],
  star: [['path', { d: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z' }]],
  remote: [['rect', { x: 7, y: 2, width: 10, height: 20, rx: 3 }], ['circle', { cx: 12, cy: 8, r: 2 }], ['path', { d: 'M10 14h4M10 17h4' }]],
  power: [['path', { d: 'M12 3v9' }], ['path', { d: 'M6.3 6.3a8 8 0 1 0 11.4 0' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
};
const SHELL_LONG_PRESS_MS = 650;

const SH = {
  root: null,
  mode: null,
  prevMode: 'home',
  focused: null,
  osk: null,
  purpose: 'open',
  pressTimer: null,
  removing: null,
  favorites: [],
  clockTimer: null,
};

// ---------------------------------------------------------------- helpers

function svg(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const root = document.createElementNS(ns, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  for (const part of ICONS[name]) {
    const node = document.createElementNS(ns, part[0]);
    for (const attr of Object.keys(part[1])) node.setAttribute(attr, String(part[1][attr]));
    root.appendChild(node);
  }
  return root;
}

function bareHost(url) {
  return hostOf(url).replace(/^www\./, '');
}

function prettyUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

function hue(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) % 360;
  return n;
}

/** Site icon: a coloured letter, upgraded to the real favicon once it loads. */
function fillIcon(iconBox, url, title) {
  const host = bareHost(url);
  iconBox.style.setProperty('--hue', hue(host || title || '?'));
  replaceKids(iconBox, [h('span', 'letter', ((title || host || '?').trim()[0] || '?').toUpperCase())]);
  if (!host) return;
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    if (img.naturalWidth >= 32) replaceKids(iconBox, [img]);
  };
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
}

function nav(el, id, action) {
  el.setAttribute('data-nav', '');
  el.dataset.id = id;
  if (action) el.dataset.action = action;
  return el;
}

function q(sel) {
  return SH.root.querySelector(sel);
}

// ---------------------------------------------------------------- building

function buildShell() {
  ensureUI();
  addStyles(S.shadow, SHELL_CSS);
  const root = h('div', 'shell');

  const home = h('section', 'screen s-home');
  const top = h('header', 'top');
  const brand = h('div', 'brand');
  brand.append(h('span', 'logo'), document.createTextNode('BrowserOS'));
  top.append(brand, h('div', 'clock'));
  const pill = nav(h('div', 'search-pill'), 'search', 'search');
  pill.append(svg('search'), h('span', '', 'Search or type a web address'));
  const contWrap = h('div', 'continue-wrap');
  const cont = nav(h('div', 'continue'), 'continue', 'continue');
  const contText = h('div', 'continue-text');
  contText.append(h('div', 'continue-title'), h('div', 'continue-url'));
  cont.append(h('div', 'icon'), contText);
  contWrap.append(h('h2', '', 'Continue'), cont);
  home.append(top, pill, contWrap, h('h2', '', 'Your sites'), h('div', 'grid'),
    h('footer', 'hint', 'OK to open  ·  Hold OK on a site to remove it  ·  Hold OK (or Red) on any page for the menu'));

  const menu = h('section', 'screen s-menu');
  const panel = h('div', 'menu-panel');
  const info = h('div', 'menu-info');
  const text = h('div', 'menu-text');
  text.append(h('div', 'menu-title'), h('div', 'menu-url'));
  info.append(h('div', 'icon menu-icon'), text);
  panel.append(info, h('div', 'menu-row'), h('div', 'menu-hint'));
  menu.append(panel);

  const search = h('section', 'screen s-search');
  const sbox = h('div', 'search-box');
  const input = h('input', 'search-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.readOnly = true; // typed with our keyboard only; read-only keeps the TV's own keyboard away
  sbox.append(h('div', 'search-label'), input);
  search.append(sbox, h('div', 'osk-host'));

  root.append(home, menu, search);
  root.addEventListener('click', (e) => {
    const node = e.target.closest && e.target.closest('[data-nav]');
    if (node) activateShell(node);
  });
  S.shadow.appendChild(root);
  SH.root = root;
}

// ---------------------------------------------------------------- rendering

function pageState() {
  return {
    hasPage: !IS_HOME,
    url: IS_HOME ? '' : location.href,
    title: IS_HOME ? 'BrowserOS' : document.title,
    zoom: Math.round(S.zoom * 100),
    passthrough: S.baseMode === 'passthrough',
    isFavorite: !IS_HOME && isFavorite(location.href),
  };
}

function renderHome() {
  const last = carrier.last;
  q('.continue-wrap').hidden = !last;
  if (last) {
    fillIcon(q('.continue .icon'), last.url, last.title);
    q('.continue-title').textContent = last.title || bareHost(last.url);
    q('.continue-url').textContent = prettyUrl(last.url);
  }
  const tiles = SH.favorites.map((fav) => {
    const tile = nav(h('div', 'tile'), 'fav:' + fav.url);
    tile.dataset.url = fav.url;
    const icon = h('div', 'icon');
    fillIcon(icon, fav.url, fav.title);
    tile.append(icon, h('div', 'tile-name', fav.title));
    return tile;
  });
  const add = nav(h('div', 'tile add'), 'add', 'add');
  const addIcon = h('div', 'icon');
  addIcon.append(svg('plus'));
  add.append(addIcon, h('div', 'tile-name', 'Add site'));
  replaceKids(q('.grid'), tiles.concat([add]));
}

function menuItems(state) {
  if (!state.hasPage) {
    return [
      { id: 'search', icon: 'search', label: 'Address', hint: 'Type a new address or search' },
      { id: 'exit', icon: 'power', label: 'Exit', hint: 'Close BrowserOS' },
    ];
  }
  return [
    { id: 'back', icon: 'back', label: 'Back' },
    { id: 'forward', icon: 'forward', label: 'Forward' },
    { id: 'reload', icon: 'reload', label: 'Reload' },
    { id: 'home', icon: 'home', label: 'Home' },
    { id: 'search', icon: 'search', label: 'Address', hint: 'Type a new address or search' },
    { id: 'zoom-out', icon: 'smaller', label: 'Smaller', hint: `Page size ${state.zoom}% · remembered for this site` },
    { id: 'zoom-in', icon: 'bigger', label: 'Bigger', hint: `Page size ${state.zoom}% · remembered for this site` },
    {
      id: 'toggle-favorite', icon: 'star', label: state.isFavorite ? 'Pinned' : 'Pin to Home',
      active: state.isFavorite, hint: state.isFavorite ? 'Remove this site from the home screen' : 'Add this site to the home screen',
    },
    {
      id: 'toggle-passthrough', icon: 'remote', label: state.passthrough ? 'Keys: Site' : 'Keys: Browser',
      active: state.passthrough,
      hint: state.passthrough
        ? 'The site handles the arrow keys itself. Select to switch back to browser navigation.'
        : 'For games and TV-ready sites: let the site handle the arrow keys itself.',
    },
    { id: 'exit', icon: 'power', label: 'Exit', hint: 'Close BrowserOS' },
  ];
}

function renderMenu() {
  const state = pageState();
  fillIcon(q('.menu-icon'), state.url, state.title);
  q('.menu-title').textContent = state.title || bareHost(state.url) || 'BrowserOS';
  q('.menu-url').textContent = state.url ? `${prettyUrl(state.url)}  ·  ${state.zoom}%` : '';
  replaceKids(q('.menu-row'), menuItems(state).map((item) => {
    const node = nav(h('div', `mi${item.active ? ' active' : ''}`), item.id, item.id);
    node.dataset.hint = item.hint || '';
    node.append(svg(item.icon), h('span', '', item.label));
    return node;
  }));
}

function renderShell() {
  if (IS_HOME) renderHome();
  renderMenu();
  if (SH.focused && !SH.focused.isConnected) {
    const id = SH.focused.dataset.id;
    setShellFocus(navItems().filter((n) => n.dataset.id === id)[0] || null);
  }
}

// ---------------------------------------------------------------- focus

function navItems() {
  return Array.prototype.slice.call(SH.root.querySelectorAll(`.s-${SH.mode} [data-nav]`))
    .filter((n) => !n.closest('[hidden]'));
}

function setShellFocus(node) {
  if (SH.focused) SH.focused.classList.remove('focused');
  SH.focused = node;
  cancelRemove();
  if (!node) return;
  node.classList.add('focused');
  node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  if (SH.mode === 'menu') q('.menu-hint').textContent = node.dataset.hint || '';
}

function shellScore(a, b, dir) {
  const vertical = dir === 'up' || dir === 'down';
  const cA = vertical ? (a.left + a.right) / 2 : (a.top + a.bottom) / 2;
  const cB = vertical ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
  let primary;
  if (dir === 'down') primary = b.top - a.bottom;
  else if (dir === 'up') primary = a.top - b.bottom;
  else if (dir === 'right') primary = b.left - a.right;
  else primary = a.left - b.right;
  if (primary < -4) return null;
  return Math.max(0, primary) + Math.abs(cA - cB) * 0.6;
}

function shellMove(dir) {
  const items = navItems();
  if (!SH.focused) return setShellFocus(items[0] || null);
  const a = SH.focused.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const node of items) {
    if (node === SH.focused) continue;
    const s = shellScore(a, node.getBoundingClientRect(), dir);
    if (s !== null && s < bestScore) {
      best = node;
      bestScore = s;
    }
  }
  if (best) setShellFocus(best);
}

// ---------------------------------------------------------------- screens

function shellEnter(next, focusId) {
  if (next !== 'search') closeShellKeyboard();
  SH.mode = next;
  S.shell = next;
  SH.root.dataset.mode = next;
  SH.focused = null;
  const items = navItems();
  let target = focusId && items.filter((n) => n.dataset.id === focusId)[0];
  if (!target && next === 'home') target = carrier.last ? q('.continue') : items.filter((n) => n.classList.contains('tile'))[0];
  if (!target && next === 'menu') target = items[0];
  setShellFocus(target || items[0] || null);
}

function shellOpen(mode) {
  if (!document.documentElement) return;
  if (!SH.root) buildShell();
  if (IS_HOME) SH.favorites = loadHomeFavorites();
  const wasOpen = !!S.shell;
  if (!wasOpen) {
    pauseMedia(mode);
    SH.mode = null;
  }
  SH.root.classList.add('open');
  renderShell();
  if (mode === 'search') {
    openShellSearch('open');
  } else {
    shellEnter(mode);
  }
  tickClock();
  clearInterval(SH.clockTimer);
  SH.clockTimer = setInterval(tickClock, 10000);
  announceMode();
  raiseOverlay();
}

function shellClose() {
  if (!SH.root || IS_HOME) return;
  closeShellKeyboard();
  SH.root.classList.remove('open');
  SH.mode = null;
  S.shell = null;
  clearInterval(SH.clockTimer);
  announceMode();
}

/** The menu covers part of the page; the address screen covers all of it. */
function pauseMedia(mode) {
  if (mode !== 'search') return;
  for (const m of document.querySelectorAll('video, audio')) m.pause();
}

function openShellSearch(purpose) {
  SH.prevMode = SH.mode; // null when opened straight from a page
  SH.purpose = purpose;
  shellEnter('search');
  const input = q('.search-input');
  input.value = purpose === 'open' && SH.prevMode === 'menu' && !IS_HOME ? location.href : '';
  input.placeholder = purpose === 'add' ? 'e.g. netflix.com' : 'Search Google or type a URL';
  q('.search-label').textContent = purpose === 'add' ? 'Add a site to your home screen' : 'Search or type a web address';
  input.focus();
  input.select();
  SH.osk = new Keyboard(q('.osk-host'), {
    kind: 'url',
    preview: false,
    enterLabel: purpose === 'add' ? 'Add' : 'Go',
    onKey: onShellKeyboardKey,
  });
}

function closeShellKeyboard() {
  if (SH.osk) SH.osk.destroy();
  SH.osk = null;
}

function closeShellSearch() {
  closeShellKeyboard();
  if (!SH.prevMode) return shellClose(); // opened straight from a page (Yellow key)
  shellEnter(SH.prevMode, SH.prevMode === 'menu' ? 'search' : undefined);
}

function onShellKeyboardKey(action, value) {
  const input = q('.search-input');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const edit = (from, to, text) => {
    input.value = input.value.slice(0, from) + text + input.value.slice(to);
    input.setSelectionRange(from + text.length, from + text.length);
  };
  switch (action) {
    case 'char':
      edit(start, end, value);
      break;
    case 'backspace':
      if (start !== end) edit(start, end, '');
      else if (start > 0) edit(start - 1, start, '');
      break;
    case 'clear':
      input.value = '';
      break;
    case 'left':
      input.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1));
      break;
    case 'right':
      input.setSelectionRange(end + 1, end + 1);
      break;
    case 'enter':
      return submitShellSearch();
    case 'done':
      return closeShellSearch();
  }
  input.focus();
}

function submitShellSearch() {
  const value = q('.search-input').value.trim();
  if (!value) return;
  if (SH.purpose === 'add') {
    shellAction('add-favorite', value);
    closeShellSearch();
  } else {
    closeShellKeyboard();
    shellAction('open', value);
  }
}

// ---------------------------------------------------------------- actions

function goHome() {
  if (IS_HOME) return shellOpen('home');
  rememberPage();
  location.href = HOME_URL;
}

/** History back; with nothing to go back to, the home screen. */
function goBack() {
  if (IS_HOME) return;
  const before = location.href;
  let left = false;
  window.addEventListener('pagehide', () => { left = true; }, { once: true });
  history.back();
  setTimeout(() => {
    if (!left && location.href === before) goHome();
  }, 600);
}

function exitApp() {
  try {
    tizen.application.getCurrentApplication().exit();
    return;
  } catch (e) { /* no Tizen API on this page */ }
  try {
    window.close();
  } catch (e) { /* ignore */ }
  toast('Press Exit on the remote to close');
}

function shellAction(name, arg) {
  switch (name) {
    case 'resume':
      return shellClose();
    case 'home':
      return goHome();
    case 'continue':
      if (carrier.last) location.href = carrier.last.url;
      return;
    case 'open': {
      const url = toUrl(arg);
      if (!url) return;
      shellClose();
      location.href = url;
      return;
    }
    case 'back':
      shellClose();
      return goBack();
    case 'forward':
      shellClose();
      return history.forward();
    case 'reload':
      return location.reload();
    case 'zoom-in':
      setZoom(0.1);
      break;
    case 'zoom-out':
      setZoom(-0.1);
      break;
    case 'toggle-favorite':
      toast(togglePin(location.href, document.title) ? 'Pinned to Home' : 'Removed from Home');
      break;
    case 'toggle-passthrough':
      setPassthrough(S.baseMode !== 'passthrough');
      break;
    case 'add-favorite': {
      const url = toUrl(arg);
      if (!url) return;
      SH.favorites = SH.favorites.concat([{ title: bareHost(url) || arg, url }]);
      saveHomeFavorites(SH.favorites);
      break;
    }
    case 'remove-favorite':
      SH.favorites = SH.favorites.filter((f) => f.url !== arg);
      saveHomeFavorites(SH.favorites);
      break;
    case 'exit':
      return exitApp();
  }
  renderShell();
}

function activateShell(node) {
  if (!node) return;
  if (SH.removing === node) {
    SH.removing = null;
    shellAction('remove-favorite', node.dataset.url);
    return;
  }
  const action = node.dataset.action;
  if (node.dataset.url) return shellAction('open', node.dataset.url);
  if (action === 'search') return openShellSearch('open');
  if (action === 'add') return openShellSearch('add');
  if (action) shellAction(action);
}

function shellLongPress() {
  if (SH.mode === 'home' && SH.focused && SH.focused.dataset.url) {
    SH.removing = SH.focused;
    SH.focused.classList.add('removing');
  } else if (SH.mode === 'search') {
    if (SH.osk) SH.osk.press();
  } else {
    activateShell(SH.focused);
  }
}

function cancelRemove() {
  if (SH.removing) SH.removing.classList.remove('removing');
  SH.removing = null;
}

function shellOk() {
  if (SH.mode === 'search') return SH.osk && SH.osk.press();
  activateShell(SH.focused);
}

function shellBack() {
  if (SH.mode === 'search') return closeShellSearch();
  if (SH.removing) return cancelRemove();
  if (SH.mode === 'menu') return IS_HOME ? shellEnter('home') : shellClose();
  if (SH.mode === 'home' && carrier.last) history.back();
}

/** Remote keys while the shell is open (it gets key-ups too, for hold-OK). */
function shellDown(name, repeat) {
  if (DIRS[name]) {
    if (SH.mode === 'search') {
      if (SH.osk) SH.osk.move(DIRS[name]);
    } else {
      shellMove(DIRS[name]);
    }
    return;
  }
  if (repeat) return; // repeats of Back/Menu are the tail of the hold that opened the menu
  switch (name) {
    case 'Enter':
      if (!R.upSeen.Enter) return shellOk(); // no release reported for OK yet: no hold gestures
      if (!SH.pressTimer) {
        SH.pressTimer = setTimeout(() => {
          SH.pressTimer = 'fired';
          shellLongPress();
        }, SHELL_LONG_PRESS_MS);
      }
      return;
    case 'Back':
      return shellBack();
    case 'Menu':
      if (SH.mode === 'menu') return IS_HOME ? shellEnter('home') : shellClose();
      return shellEnter('menu');
    case 'Home':
      return goHome();
    case 'Address':
      return SH.mode === 'search' ? closeShellSearch() : openShellSearch('open');
  }
}

function shellUp(name) {
  if (name !== 'Enter') return;
  const timer = SH.pressTimer;
  SH.pressTimer = null;
  if (timer && timer !== 'fired') {
    clearTimeout(timer);
    shellOk();
  }
}

function tickClock() {
  const clock = SH.root && q('.clock');
  if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---- remote.js
// Remote keys. Tizen sends key codes: Back is 10009, and media/colour keys only arrive
// once registered (TizenBrew registers the "keys" listed in package.json).
// Every frame listens, because keys go to whichever frame has focus. A frame that isn't
// in control forwards them to the top frame, which handles them, opens the shell, or
// hands them to the iframe it entered (an embedded player).

const KEY_CODES = {
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter',
  10009: 'Back', 27: 'Escape', 8: 'Backspace',
  33: 'PageUp', 34: 'PageDown', 427: 'PageUp', 428: 'PageDown',
  10252: 'PlayPause', 415: 'Play', 19: 'Pause', 413: 'Stop', 412: 'Rewind', 417: 'FastForward',
  179: 'PlayPause', 178: 'Stop', // desktop media keys
  403: 'Menu', 93: 'Menu', 112: 'Menu', // Red, ContextMenu, F1
  404: 'Home', 36: 'Home', // Green, Home (desktop testing)
  405: 'Address', // Yellow
};
const SHELL_KEYS = { Menu: 1, Home: 1, Address: 1 }; // always handled by the top frame
const ALWAYS_TAKEN = { Back: 1, Menu: 1, Home: 1, Address: 1 }; // even in "Keys: Site" mode
const HOLD_MS = 700;
const IME_DONE = 65376; // the TV's own keyboard: Done / Cancel
const IME_CANCEL = 65385;

const R = {
  down: {}, // keyCode -> name, for keys currently held
  // name -> true once a key-up came for it (some TV keys report press and release
  // together). Kept for the tab in window.name, so every new page doesn't relearn it.
  upSeen: Object.assign({}, carrier.upSeen),
  topMode: 'nav', // iframes: the top frame's mode, as announced
  holding: null, // 'Enter' | 'Back' while a press might turn into a hold
  holdTimer: null,
};

/** The mode that decides which keys this frame takes from the page. */
function keyMode() {
  if (IS_TOP) return S.shell ? 'shell' : S.mode || 'nav';
  return S.active ? S.mode || 'nav' : R.topMode;
}

function nameFor(e, mode) {
  const name = KEY_CODES[e.keyCode];
  // Escape still reaches sites that drive themselves; Backspace is Back only while navigating.
  if (name === 'Escape') return mode === 'passthrough' ? null : 'Back';
  if (name === 'Backspace') return mode === 'nav' || (mode === 'shell' && S.shell !== 'search') ? 'Back' : null;
  if (name === 'Home' && e.keyCode === 36 && mode !== 'nav') return null;
  return name || null;
}

function onKeyDown(e) {
  if (!e.isTrusted) return; // our own synthetic keys
  if (e.keyCode === IME_DONE || e.keyCode === IME_CANCEL) return imeKey(e.keyCode === IME_DONE);
  const mode = keyMode();
  const name = nameFor(e, mode);
  if (!name) return;
  if (mode === 'passthrough' && !ALWAYS_TAKEN[name]) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const repeat = e.repeat || R.down[e.keyCode] === name;
  R.down[e.keyCode] = name;
  if (!IS_TOP && !S.active) post(window.top, { type: 'down', name, repeat });
  else remoteDown(name, repeat);
}

function onKeyUp(e) {
  if (!e.isTrusted) return;
  const name = R.down[e.keyCode];
  if (!name) return;
  delete R.down[e.keyCode];
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!IS_TOP && !S.active) post(window.top, { type: 'up', name });
  else remoteUp(name);
}

/**
 * A key press in the frame in control. Holding OK or Back opens the menu, so those act
 * on release. Samsung remotes report Back's release right away however long it's held,
 * so on a TV it's hold OK (or Red) that works. Until a key's release has been seen,
 * it acts on press: a remote that never reports one must not leave OK dead.
 */
function remoteDown(name, repeat) {
  if (IS_TOP && S.shell) return shellDown(name, repeat);
  const holdable = name === 'Back' || (name === 'Enter' && !S.osk && !S.picker);
  if (!holdable) return deliver(name, repeat);
  if (repeat) return;
  if (!R.upSeen[name]) return deliver(name, false);
  clearTimeout(R.holdTimer);
  R.holding = name;
  R.holdTimer = setTimeout(() => {
    R.holdTimer = null;
    R.holding = null;
    deliver('Menu', false);
  }, HOLD_MS);
}

function remoteUp(name) {
  if (!R.upSeen[name]) {
    R.upSeen[name] = true;
    if (IS_TOP) {
      carrier.upSeen = R.upSeen;
      saveCarrier();
    }
  }
  if (IS_TOP && S.shell) return shellUp(name);
  if (R.holdTimer && R.holding === name) {
    clearTimeout(R.holdTimer);
    R.holdTimer = null;
    R.holding = null;
    deliver(name, false);
  }
}

function deliver(name, repeat) {
  if (SHELL_KEYS[name]) {
    if (IS_TOP) return topKey(name);
    return post(window.top, { type: 'shell-key', name });
  }
  if (IS_TOP && S.mode === 'frame' && S.inFrame && S.inFrame.isConnected && S.inFrame.contentWindow) {
    return post(S.inFrame.contentWindow, { type: 'key', name, repeat });
  }
  try {
    onKey(name, repeat);
  } catch (err) {
    console.error('[browserOS]', err);
  }
}

/** Top frame: keys that belong to the shell rather than the page. */
function topKey(name) {
  if (name === 'Home') return goHome();
  if (S.osk) stopEditing();
  if (S.picker) closePicker();
  shellOpen(name === 'Address' ? 'search' : 'menu');
}

window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object' || m.browserOS !== MSG) return;
  if (IS_TOP) {
    switch (m.type) {
      case 'down':
        return remoteDown(m.name, m.repeat);
      case 'up':
        return remoteUp(m.name);
      case 'shell-key':
        return topKey(m.name);
      case 'open':
        return openInPlace(String(m.url));
      case 'claim':
        return frameClaimed(e.source);
      case 'frame-exit':
        if (S.inFrame && e.source === S.inFrame.contentWindow) frameExited();
        return;
      case 'hello':
        return post(e.source, modeMessage());
    }
    return;
  }
  if (e.source !== window.top) return; // frames only take orders from the top frame
  switch (m.type) {
    case 'mode':
      R.topMode = m.mode || 'nav';
      Object.assign(R.upSeen, m.upSeen);
      S.baseMode = m.passthrough ? 'passthrough' : 'nav';
      if (!S.osk && !S.picker && !S.typing) S.mode = S.baseMode;
      return;
    case 'enter':
      S.active = true;
      S.focused = null;
      restMode();
      return;
    case 'key':
      if (!S.active) S.active = true;
      try {
        onKey(m.name, m.repeat);
      } catch (err) {
        console.error('[browserOS]', err);
      }
      return;
    case 'media':
      return mediaKey(m.key);
  }
});

// ---- boot.js
// Start-up. TizenBrew may evaluate us before the page has a <body>, so DOM work waits.

if (IS_TOP) {
  S.baseMode = sitePassthrough() ? 'passthrough' : 'nav';
  restMode();
  window.addEventListener('pagehide', rememberPage);
  window.addEventListener('blur', rememberPage); // pagehide is unreliable on some TV firmware
} else {
  S.mode = 'nav';
  post(window.top, { type: 'hello' });
}

onReady(() => {
  if (IS_TOP && !IS_HOME) applyZoom(siteZoom());
  if (IS_HOME) {
    // TizenBrew's server answers this URL with a bit of text; the shell is the page.
    document.title = 'BrowserOS';
    replaceKids(document.body, []);
    document.documentElement.style.background = '#0b0d12';
    shellOpen('home');
  } else if (IS_TOP) {
    ensureUI();
    rememberPage();
    if (!carrier.hinted) {
      carrier.hinted = true; // once per TizenBrew session: window.name lives as long as the tab
      saveCarrier();
      setTimeout(() => toast('Hold OK for the menu', 3000), 1500);
    }
  }
});

requestAnimationFrame(tick);

function debugRect(r) {
  return r && { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/** Debugging: what a press in dir would consider from the focused element. */
window.__browserOSCandidates = (dir) => {
  const from = S.focused && S.focused.isConnected ? rectOf(S.focused) : null;
  return collect(activeScope()).map((c) => {
    const s = from && dir ? score(from, c.r, dir) : null;
    return { el: describe(c.el), rect: debugRect(c.r), pointer: c.viaPointer, score: s && Math.round(s.total), primary: s && Math.round(s.primary) };
  }).filter((c) => !dir || c.score !== null).sort((a, b) => a.score - b.score);
};

// For test/run.js and on-device debugging (TizenBrew's remote DevTools console).
window.__browserOSDebug = () => {
  const video = largestVideo(document);
  return {
    top: IS_TOP,
    home: IS_HOME,
    mode: S.mode,
    active: S.active,
    shell: S.shell,
    shellFocused: SH.focused && SH.focused.dataset.id,
    address: SH.root ? q('.search-input').value : null,
    focused: describe(S.focused),
    focusedRect: S.focused && S.focused.isConnected ? debugRect(rectOf(S.focused)) : null,
    ringRect: S.ringShown ? debugRect(S.ring.getBoundingClientRect()) : null,
    scrollY: Math.round(window.scrollY),
    video: video && { time: video.currentTime, paused: video.paused, volume: video.volume },
    osk: !!S.osk,
    oskRect: S.osk ? debugRect(S.osk.el.getBoundingClientRect()) : null,
    picker: !!S.picker,
    scrubbing: !!S.scrub,
    inFrame: !!S.inFrame,
    keyMs: S.lastKeyMs, // how long the last key took to handle
    hits: S.hits, // and the hit tests it made
    zoom: S.zoom,
    zoomFix: S.zoomFix,
    favorites: IS_HOME ? SH.favorites.map((f) => f.url) : knownFavorites().map((f) => f.url),
    carrier: IS_TOP ? carrier : null,
  };
};

})();
