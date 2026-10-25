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
