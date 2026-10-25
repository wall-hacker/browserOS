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

[data-nav] { transition: transform .14s ease, box-shadow .14s ease, background .14s ease; }
[data-nav].focused {
  transform: scale(1.06); background: var(--card-hi);
  box-shadow: 0 0 0 .45vh #fff, 0 2vh 5vh rgba(0, 0, 0, .55); position: relative; z-index: 1;
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
.search-pill.focused { color: var(--text); transform: scale(1.03); }
.shell h2 {
  margin: 5vh 0 2.2vh; font-size: 2vh; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted);
}
.continue {
  width: 95vh; max-width: 100%; display: flex; align-items: center;
  padding: 2.2vh 3vh; border-radius: 2.2vh; background: var(--card);
}
.continue.focused { transform: scale(1.03); }
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
  animation: fade-in .16s ease-out;
}
@keyframes fade-in { from { opacity: 0; } }
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

.s-search { background: rgba(8, 10, 16, .95); animation: fade-in .16s ease-out; }
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
    h('footer', 'hint', 'OK to open  ·  Hold OK on a site to remove it  ·  Hold Back (or Red) on any page for the menu'));

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
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      if (!R.sawKeyUp) return shellOk(); // no key-ups from this remote: no hold gestures
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
