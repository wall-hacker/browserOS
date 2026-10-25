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

function isVisible(el) {
  if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  if (getComputedStyle(el).visibility === 'hidden') return false;
  for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 12; n = parentOf(n), depth++) {
    if (getComputedStyle(n).opacity === '0') return false;
  }
  return true;
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
