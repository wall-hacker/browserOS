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
const POINTER_GRID = 26; // sample points along the short side of the viewport
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
  broadcast(window, { type: 'mode', mode: S.shell ? 'shell' : S.mode, passthrough: S.baseMode === 'passthrough' });
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

function isPinned(el) {
  for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 30; n = parentOf(n), depth++) {
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') return true;
  }
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
function clickPoint(el) {
  const r = rectOf(el);
  const left = Math.max(r.left, 0);
  const right = Math.min(r.right, innerWidth);
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, innerHeight);
  if (right - left < 1 || bottom - top < 1) return null;
  const w = right - left;
  const h = bottom - top;
  const tries = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];
  for (const t of tries) {
    const x = left + w * t[0];
    const y = top + h * t[1];
    const hit = deepElementFromPoint(x, y);
    if (hit && (contains(el, hit) || contains(hit, el))) return { x, y };
  }
  return null;
}

function searchRoots(base) {
  const now = performance.now();
  if (!S.shadowRoots || now - S.shadowRootsAt > 1500) {
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
function collect(scope) {
  const vw = innerWidth;
  const vh = innerHeight;
  const found = new Map();

  const consider = (el, viaPointer) => {
    if (found.has(el) || el === S.host) return;
    if (scope && !contains(scope, el)) return;
    const r = rectOf(el);
    if (r.width < 3 || r.height < 3) return;
    const media = el.tagName === 'VIDEO' || el.tagName === 'IFRAME';
    if (!media && r.width * r.height > (viaPointer ? 0.5 : 0.85) * vw * vh) return;
    if (isDisabled(el)) return;
    if (!isVisible(el)) return;
    if (!viaPointer && onScreen(r) && !clickPoint(el)) return; // covered by something else
    found.set(el, { el, r, viaPointer });
  };

  for (const root of searchRoots(scope || document)) {
    for (const el of root.querySelectorAll(SELECTOR)) consider(el, false);
  }

  const step = Math.max(28, Math.min(vw, vh) / POINTER_GRID);
  const seen = new Set();
  const cursors = new Map();
  for (let y = step / 2; y < vh; y += step) {
    for (let x = step / 2; x < vw; x += step) {
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

function move(dir) {
  const scope = activeScope();
  let cands = collect(scope);
  if (scope && !cands.length) cands = collect(null);

  const current = S.focused && S.focused.isConnected ? S.focused : null;
  let from = current ? rectOf(current) : S.lastRect;
  if (!from || !onScreen(from)) {
    const pick = initialPick(cands, dir);
    if (pick) return focusEl(pick.el);
    if (!scrollStep(dir)) bump();
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
        hover(video); // wakes auto-hidden controls
        if (player.controls.length) return focusEl(initialPick(player.controls, 'up').el);
      }
    } else {
      const inside = findBest(dir, from, player.controls, current);
      if (inside) return focusEl(inside.el);
      if (dir === 'up') return focusEl(video);
      if (dir === 'left' || dir === 'right') return bump();
      from = player.box;
      cands = cands.filter((c) => player.controls.indexOf(c) < 0 && c.el !== video);
    }
  }

  const best = findBest(dir, from, cands, current);
  const span = dir === 'up' || dir === 'down' ? innerHeight : innerWidth;
  if (best && best.primary <= span * FAR_JUMP) return focusEl(best.el);
  // Nothing close in that direction (e.g. long text): scroll and let the next press pick up.
  if (scrollStep(dir)) return;
  if (best) return focusEl(best.el);
  bump();
}

function focusEl(el) {
  const previous = deepActiveElement();
  release();
  S.focused = el;
  S.lastRect = rectOf(el);
  S.mouseActive = false;
  ensureUI();
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  S.ring.style.borderRadius = `${Math.min(Math.max(radius * S.zoomFix + 4, 6), 40)}px`;
  S.ring.classList.add('glide');
  clearTimeout(S.glideTimer);
  S.glideTimer = setTimeout(() => S.ring.classList.remove('glide'), 220);

  const revealed = isPinned(el) ? false : reveal(el);
  if (!isTextField(el) && el.tabIndex >= 0 && typeof el.focus === 'function' && el.tagName !== 'IFRAME') {
    try {
      el.focus({ preventScroll: true });
    } catch (e) { /* not focusable */ }
  } else if (previous && previous !== el && isTextField(previous)) {
    previous.blur(); // don't leave an autofocused search box swallowing site shortcuts
  }
  const token = ++S.hoverToken;
  setTimeout(() => {
    if (token === S.hoverToken && S.focused === el) hover(el);
  }, revealed ? 380 : 40);
  raiseOverlay();
}

/** Scrolls el into a comfortable spot; returns true when it had to scroll. */
function reveal(el) {
  const r = rectOf(el);
  const vw = innerWidth;
  const vh = innerHeight;
  const needY = r.top < vh * 0.12 || r.bottom > vh * 0.88;
  const needX = r.left < vw * 0.04 || r.right > vw * 0.96;
  if (!needY && !needX) return false;
  el.scrollIntoView({
    behavior: 'smooth',
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
  const opts = { behavior: 'smooth' };
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
  flash('press');
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
  hover(video); // most players show their own controls on mouse movement
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
  const inControls = S.focused && S.focused !== video && S.focused.isConnected && (!root || contains(root, S.focused));
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
    case 'ArrowDown': {
      commitScrub();
      hover(video);
      setTimeout(() => {
        const controls = collect(root).filter((c) => c.el !== video && !contains(c.el, video));
        const pick = initialPick(controls, 'up'); // controls usually sit along the bottom
        if (pick) focusEl(pick.el);
      }, 150);
      return true;
    }
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
      S.focused = null; // leave the controls, back to plain playback
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
  setTimeout(() => {
    const r = rectOf(el);
    if (!isPinned(el) && (r.bottom > innerHeight * 0.5 || r.top < 0)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => window.scrollBy({ top: -innerHeight * 0.18, behavior: 'smooth' }), 350);
    }
  }, 60);
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
  const now = performance.now();
  if (repeat && now - S.lastKeyAt < REPEAT_MS) return;
  S.lastKeyAt = now;
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
  if (S.osk || !isTextField(active)) return;
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
  if (fe) S.focused = null; // start in plain playback
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

const UI_CSS = `
.ring {
  position: fixed; left: 0; top: 0; width: 0; height: 0; box-sizing: border-box;
  border-radius: 8px; opacity: 0; pointer-events: none; will-change: transform;
  box-shadow: 0 0 0 3px #fff, 0 0 0 7px #3d8bff, 0 8px 30px 8px rgba(0, 0, 0, .45);
  transition: opacity .15s;
}
.ring.on { opacity: 1; }
.ring.glide { transition: opacity .15s, transform .16s cubic-bezier(.2, .8, .2, 1),
  width .16s cubic-bezier(.2, .8, .2, 1), height .16s cubic-bezier(.2, .8, .2, 1); }
.ring.press { animation: ring-press .22s ease-out; }
.ring.bump { animation: ring-bump .3s ease-out; }
@keyframes ring-press { 40% { box-shadow: 0 0 0 3px #fff, 0 0 0 14px #3d8bff, 0 8px 30px 8px rgba(0, 0, 0, .45); } }
.ring.engaged { box-shadow: 0 0 0 3px #fff, 0 0 0 7px #ffc83d, 0 8px 30px 8px rgba(0, 0, 0, .45); }
@keyframes ring-bump { 30% { box-shadow: 0 0 0 3px #fff, 0 0 0 7px #ff8a3d, 0 8px 30px 8px rgba(0, 0, 0, .45); } }
.toast {
  position: fixed; left: 50%; top: 5vh; transform: translate(-50%, -1.5vh);
  padding: 1.4vh 3vh; border-radius: 99px; background: rgba(15, 17, 24, .92); color: #fff;
  font: 600 2.5vh "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif; white-space: nowrap;
  box-shadow: 0 1vh 4vh rgba(0, 0, 0, .5); opacity: 0; pointer-events: none;
  transition: opacity .2s, transform .2s; z-index: 3;
}
.toast.on { opacity: 1; transform: translate(-50%, 0); }
.scrub {
  position: fixed; left: 5vw; right: 5vw; bottom: 5vh; padding: 2.2vh 2.8vh 2.6vh;
  border-radius: 2.2vh; background: rgba(12, 14, 20, .9); color: #fff;
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif; box-shadow: 0 1.5vh 5vh rgba(0, 0, 0, .55);
  opacity: 0; transform: translateY(2vh); transition: opacity .18s, transform .18s; pointer-events: none;
}
.scrub.on { opacity: 1; transform: none; }
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
  border-radius: 50%; background: #fff; box-shadow: 0 0 0 .5vh #3d8bff, 0 .5vh 1.5vh rgba(0, 0, 0, .5);
  transition: left .12s ease-out;
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
    S.ring.addEventListener('animationend', () => S.ring.classList.remove('press', 'bump'));
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

function flash(kind) {
  if (!S.ring) return;
  S.ring.classList.remove('press', 'bump');
  void S.ring.offsetWidth;
  S.ring.classList.add(kind);
}

function bump() {
  flash('bump');
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
