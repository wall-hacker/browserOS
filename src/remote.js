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
