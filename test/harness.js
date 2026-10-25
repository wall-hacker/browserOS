'use strict';
// Runs dist/browseros.js the way TizenBrew does on the TV, and drives it with remote keys.
//   - Injection: a DevTools client evaluates the bundle on every Runtime.executionContextCreated,
//     like TizenBrew's service (service-nextgen/service/utils/debugger.js).
//   - Frames share one process (site isolation off), as on the TV, so iframes get the script too.
//   - Keys are trusted DevTools key events with Tizen key codes (Back = 10009, Red = 403...).
//   - Unless --modern, APIs newer than Chromium 69 that the bundle has fallbacks for are
//     removed from each page first, so the fallbacks are what gets tested.
// Ported from the Electron build's src/selftest.js; checks that need trusted input are adapted.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'dist', 'browseros.js'), 'utf8');
const ELECTRON_TESTS = path.join(__dirname, '..', '..', 'browserOS', 'test');
const STREAMING_DIR = path.join(ELECTRON_TESTS, 'streaming');
const HOME_URL = 'http://127.0.0.1:8081/browseros/home';
const PORT = 8090; // the site is on localhost:PORT; players and ads on 127.0.0.1:PORT+1
const MODERN = process.argv.includes('--modern');
const SUITE_ARG = process.argv.find((a) => a.startsWith('--suite='));
const SUITES = SUITE_ARG ? SUITE_ARG.slice(8).split(',') : ['basic', 'layout', 'shell', 'streaming'];
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
// Explore a real site as the TV would see it:
//   --explore=URL --keys=ArrowDown*3,Enter --shots=DIR [--cookie=name=value]
const EXPLORE = arg('explore');
const TIZEN_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.5 TV Safari/537.36';

const OLD_CHROME = `(function () {
  if (/challenges\\.cloudflare\\.com|hcaptcha\\.com|recaptcha/.test(location.href)) return; // they notice
  var gone = [[HTMLElement.prototype, 'showPopover'], [HTMLElement.prototype, 'hidePopover'],
    [Element.prototype, 'checkVisibility'], [Element.prototype, 'replaceChildren'],
    [Document.prototype, 'adoptedStyleSheets'], [ShadowRoot.prototype, 'adoptedStyleSheets']];
  gone.forEach(function (g) { try { delete g[0][g[1]]; } catch (e) {} });
})();`;

const KEYS = {
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13,
  Back: 10009, Red: 403, Green: 404, Yellow: 405, PlayPause: 10252,
};

app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- servers

function silentWav(seconds) {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples, 128);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  return buf;
}

function startServers() {
  const wav = silentWav(600);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const site = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/media/movie.wav') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : wav.length - 1;
        res.writeHead(206, {
          'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': end - start + 1,
        });
        return res.end(wav.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': wav.length });
      return res.end(wav);
    }
    if (url.pathname === '/ad.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<title>AD</title><h1>Congratulations, you won!</h1>');
    }
    const dir = url.pathname === '/remote-test.html' ? ELECTRON_TESTS
      : url.pathname === '/layout.html' ? path.join(__dirname, 'pages') : STREAMING_DIR;
    const file = path.join(dir, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };
  // Like TizenBrew's local server: any path that isn't a module file gets the TV's IP as text.
  const tizenbrew = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('192.168.1.50');
  };
  const servers = [
    http.createServer(tizenbrew).listen(8081, '127.0.0.1'),
    http.createServer(site).listen(PORT, 'localhost'),
    http.createServer(site).listen(PORT + 1, '127.0.0.1'),
  ];
  return () => servers.forEach((s) => s.close());
}

// ---------------------------------------------------------------- harness

async function run() {
  const stopServers = startServers();
  const win = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, show: false, backgroundColor: '#000', enableLargerThanScreen: true,
    webPreferences: { backgroundThrottling: false, partition: 'harness' },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
  const wc = win.webContents;
  await wc.loadURL('about:blank');
  const dbg = wc.debugger;
  dbg.attach('1.3');
  dbg.on('message', (_e, method, params) => {
    if (method !== 'Runtime.executionContextCreated' || process.argv.includes('--no-inject')) return;
    const expression = (MODERN ? '' : OLD_CHROME) + BUNDLE;
    dbg.sendCommand('Runtime.evaluate', { expression, contextId: params.context.id }).catch(() => {});
  });
  await dbg.sendCommand('Runtime.enable');

  const results = [];
  const check = (name, ok, detail) => {
    results.push(!!ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };
  const info = (text) => console.log(`info  ${text}`);

  const frame = () => wc.mainFrame.frames[0] || null;
  const evalIn = async (target, js) => {
    try {
      return await (target || wc.mainFrame).executeJavaScript(js);
    } catch (e) {
      return null;
    }
  };
  const debug = async (target) => (await evalIn(target, 'window.__browserOSDebug ? window.__browserOSDebug() : {}')) || {};

  const sendKey = (type, name) => {
    const vk = KEYS[name];
    const key = name === 'Enter' || name.indexOf('Arrow') === 0 ? name : 'Unidentified';
    return dbg.sendCommand('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const press = async (name, times, delay) => {
    for (let i = 0; i < (times || 1); i++) {
      await sendKey('rawKeyDown', name);
      await sendKey('keyUp', name);
      await wait(delay || 450);
      if (process.env.TRACE) {
        const d = await debug();
        console.log(`   ${name.padEnd(10)} -> ${d.shell || d.mode} ${d.shell ? d.shellFocused : d.focused}`);
      }
    }
  };
  const hold = async (name, ms) => {
    await sendKey('rawKeyDown', name);
    await wait(ms);
    await sendKey('keyUp', name);
    await wait(450);
  };
  const pressUntil = async (name, match, max, target) => {
    for (let i = 0; i < (max || 12); i++) {
      const d = await debug(target);
      if (d.focused && match.test(d.focused)) return d;
      await press(name);
    }
    return debug(target);
  };
  const load = async (url) => {
    await wc.loadURL(url).catch(() => {});
    await wait(900);
  };
  const pageLog = async () => (await evalIn(null, 'window.__log ? window.__log.join("\\n") : ""')) || '';
  const videoTime = (target) => evalIn(target, 'document.querySelector("video").currentTime');
  const base = `http://localhost:${PORT}`;

  // -------------------------------------------------------------- basic page

  async function basic() {
    await load(`${base}/remote-test.html`);
    await press('ArrowDown');
    let d = await debug();
    check('first press focuses the first link', /nav-home/.test(d.focused), d.focused);
    check('the focus ring sits on the focused element', ringOn(d), JSON.stringify([d.ringRect, d.focusedRect]));

    await press('ArrowRight', 2);
    d = await debug();
    check('right moves along the nav bar', /nav-c/.test(d.focused), d.focused);

    await press('ArrowDown');
    d = await debug();
    check('down reaches a script-clickable card (cursor:pointer div)', /card-/.test(d.focused), d.focused);
    await press('Enter');
    check('OK clicks it (a synthetic click on the TV)', /click card-\d/.test(await pageLog()));

    d = await pressUntil('ArrowDown', /slide-/);
    check('down reaches the carousel', /slide-/.test(d.focused), d.focused);
    await press('ArrowRight', 7, 350);
    d = await debug();
    const scrolled = await evalIn(null, 'document.getElementById("carousel").scrollLeft');
    check('right scrolls the carousel', /slide-[6-9]|slide-1\d/.test(d.focused) && scrolled > 0, `${d.focused}, scrollLeft=${scrolled}`);

    await press('ArrowDown');
    d = await debug();
    check('down from the carousel lands on the form row', /input#q|select#sel|open-modal/.test(d.focused), d.focused);
    d = await pressUntil('ArrowLeft', /input#q/, 4);
    check('left reaches the search input', /input#q/.test(d.focused), d.focused);
    await press('Enter', 1, 600);
    d = await debug();
    check('OK on a text field opens the keyboard', d.osk && d.mode === 'osk', `mode=${d.mode}`);
    const kb = d.oskRect || {};
    check('the keyboard is styled (wide, along the bottom)', kb.width > 900 && kb.top > 300, JSON.stringify(kb));
    check('the field is read-only while ours is open (no TV keyboard)', await evalIn(null, 'document.getElementById("q").readOnly'));
    await press('Enter'); // keyboard starts on "q"
    await press('ArrowRight');
    await press('Enter'); // "w"
    const value = await evalIn(null, 'document.getElementById("q").value');
    check('keyboard types into the field', value === 'qw', JSON.stringify(value));
    await press('ArrowDown');
    await press('ArrowRight', 9, 120); // to the Search key at the end of the row
    await press('Enter', 1, 600);
    d = await debug();
    check('Search key submits and closes the keyboard', /submit q=qw/.test(await pageLog()) && !d.osk, `osk=${d.osk}`);
    const after = await evalIn(null, '[document.getElementById("q").readOnly, document.activeElement && document.activeElement.id]');
    check('afterwards the field is editable again and no longer focused', after[0] === false && after[1] !== 'q', JSON.stringify(after));
    await evalIn(null, 'document.getElementById("q").focus()');
    await wait(200);
    d = await debug();
    const active = await evalIn(null, 'document.activeElement && document.activeElement.id');
    check('a field the site focuses by itself is let go (no TV keyboard)', active !== 'q' && !d.osk, `active=${active} osk=${d.osk}`);

    d = await pressUntil('ArrowRight', /select#sel/, 3);
    check('right reaches the select', /select#sel/.test(d.focused), d.focused);
    await press('Enter');
    d = await debug();
    check('OK on a select opens the picker', d.picker);
    await press('ArrowDown');
    await press('Enter');
    check('picker changes the value', /change sel=b/.test(await pageLog()));

    await pressUntil('ArrowRight', /button#open-modal/, 3);
    await press('Enter', 1, 600);
    await press('ArrowDown');
    d = await debug();
    check('focus is confined to the open dialog', /dlg-/.test(d.focused), d.focused);
    await press('Back', 1, 600);
    check('Back closes the dialog with Escape', /modal closed by Escape/.test(await pageLog()));

    const before = (await debug()).scrollY;
    await press('ArrowDown', 6, 500);
    d = await debug();
    check('down scrolls through text without links', d.scrollY > before + 300, `scrollY ${before} -> ${d.scrollY}`);
  }

  function ringOn(d) {
    const r = d.ringRect;
    const f = d.focusedRect;
    return !!r && !!f && Math.abs(r.left + 4 - f.left) <= 3 && Math.abs(r.top + 4 - f.top) <= 3 &&
      Math.abs(r.width - 8 - f.width) <= 3;
  }

  // -------------------------------------------------------------- shell

  async function shell() {
    await load(HOME_URL);
    let d = await debug();
    check('home: the home screen draws on the TizenBrew URL', d.home && d.shell === 'home', `home=${d.home} shell=${d.shell}`);
    check('home: default favourites are listed', d.favorites && d.favorites.length === 6, String(d.favorites && d.favorites.length));
    await press('ArrowRight');
    d = await debug();
    check('home: arrows move between tiles', /^fav:/.test(d.shellFocused || ''), d.shellFocused);
    await press('Red');
    d = await debug();
    check('home: Red opens the menu', d.shell === 'menu', d.shell);
    await press('Back');
    d = await debug();
    check('home: Back closes the menu', d.shell === 'home', d.shell);
    // The Add tile starts the last grid row: down until focus stops moving, then left.
    for (let i = 0, last = null; i < 4; i++) {
      const id = (await debug()).shellFocused;
      if (id === last || id === 'add') break;
      last = id;
      await press('ArrowDown', 1, 300);
    }
    for (let i = 0; i < 6 && (await debug()).shellFocused !== 'add'; i++) await press('ArrowLeft', 1, 200);
    d = await debug();
    check('home: down reaches the "Add site" tile', d.shellFocused === 'add', d.shellFocused);
    await press('Enter', 1, 600);
    d = await debug();
    check('home: "Add site" opens the address screen', d.shell === 'search', d.shell);
    await press('Enter'); // the keyboard starts on "q"
    d = await debug();
    check('home: our keyboard types into the address box', d.address === 'q', JSON.stringify(d.address));
    await press('ArrowDown');
    await press('ArrowRight', 10, 120); // along the "a s d ..." row to its Add key
    await press('Enter', 1, 600);
    d = await debug();
    check('home: the Add (Go) key adds the site', d.shell === 'home' && d.favorites.length === 7, `shell=${d.shell} favourites=${d.favorites.length}`);

    await load(`${base}/title.html`);
    await press('ArrowDown');
    d = await debug();
    const focusedBefore = d.focused;
    await hold('Enter', 1000);
    d = await debug();
    check('page: holding OK opens the menu', d.shell === 'menu', d.shell);
    check('page: the hold did not also click', /title\.html/.test(wc.getURL()) && focusedBefore, `${wc.getURL()} focused=${focusedBefore}`);
    await press('Back');
    await hold('Back', 1000);
    d = await debug();
    check('page: holding Back opens the menu too (where the remote reports it)', d.shell === 'menu', d.shell);
    check('page: the hold did not also go back', /title\.html/.test(wc.getURL()), wc.getURL());
    await press('ArrowRight', 7, 200); // back, forward, reload, home, address, smaller, bigger, pin
    d = await debug();
    check('page: menu reaches "Pin to Home"', d.shellFocused === 'toggle-favorite', d.shellFocused);
    await press('Enter');
    d = await debug();
    check('page: pinning is queued for the home page', d.carrier.pending.length === 1 && d.favorites.some((u) => /title\.html/.test(u)), JSON.stringify(d.carrier.pending));
    await press('ArrowRight', 1, 200);
    await press('Enter');
    d = await debug();
    check('page: "Keys: Site" switches the remote to the site', d.mode === 'passthrough', d.mode);
    await press('Enter');
    d = await debug();
    check('page: and back to browser navigation', d.mode === 'nav', d.mode);
    await press('ArrowLeft', 2, 200); // to "Bigger"
    await press('Enter');
    d = await debug();
    check('page: "Bigger" zooms the page', Math.abs(d.zoom - 1.1) < 0.001, String(d.zoom));
    await press('Back');
    await press('ArrowDown');
    d = await debug();
    check('page: the ring still fits when zoomed', ringOn(d), JSON.stringify([d.ringRect, d.focusedRect]));
    info(`zoom correction factor here: ${d.zoomFix}`);
    await evalIn(null, 'window.name = "fsLegacyTried|" + window.name'); // what flystream.net does
    await load(`${base}/title.html`);
    d = await debug();
    check('page: zoom is remembered for the site', Math.abs(d.zoom - 1.1) < 0.001, String(d.zoom));
    check('page: a site prefixing window.name keeps the pin', d.carrier.pending.length === 1, JSON.stringify(d.carrier.pending));
    await press('Red');
    await press('ArrowLeft', 9, 150);
    await press('ArrowRight', 5, 150); // "Smaller"
    await press('Enter');
    await press('Back');

    await press('Green', 1, 1200);
    d = await debug();
    check('Green goes to the home screen', d.home && d.shell === 'home', wc.getURL());
    check('home: the pinned site was added', d.favorites.some((u) => /title\.html/.test(u)) && d.carrier.pending.length === 0, d.favorites.join(' '));
    check('home: "Continue" offers the last page', d.shellFocused === 'continue' && /title\.html/.test(d.carrier.last && d.carrier.last.url), d.shellFocused);
    await press('Enter', 1, 1200);
    check('home: Continue opens it', /title\.html/.test(wc.getURL()), wc.getURL());

    await press('Yellow');
    d = await debug();
    check('page: Yellow opens the address screen', d.shell === 'search', d.shell);
    await press('Back');
    d = await debug();
    check('page: Back closes it back to the page', !d.shell, d.shell);
  }

  // -------------------------------------------------------------- layouts from real sites

  async function layout() {
    await load(`${base}/layout.html`);
    let d = await pressUntil('ArrowDown', /#banner/, 4);
    check('layout: down from the header reaches the banner', /#banner/.test(d.focused), d.focused);
    await press('ArrowDown');
    d = await debug();
    check('layout: down from the banner picks the visible button off to the side, not a far card', /#play/.test(d.focused), d.focused);
    await press('ArrowDown');
    d = await debug();
    check('layout: down from the hero reaches the card row', /#r1-/.test(d.focused), d.focused);
    await press('ArrowDown');
    d = await debug();
    check('layout: down reaches the wide spotlight', /#spotlight/.test(d.focused), d.focused);
    await press('ArrowRight');
    d = await debug();
    check('layout: right from the spotlight stays in its row', /#spotlight/.test(d.focused), d.focused);
    await press('ArrowUp');
    d = await debug();
    check('layout: up from the spotlight goes to the row above', /#r1-/.test(d.focused), d.focused);
    // Far up: a press may scroll first, but it must land on content, never the fixed header.
    for (let i = 0; i < 3 && !/#play|#banner|#nav-/.test(d.focused); i++) {
      await press('ArrowUp');
      d = await debug();
    }
    check('layout: up goes back to page content, not to the fixed header', /#play|#banner/.test(d.focused), d.focused);
    check('layout: it is scrolled out from under the fixed header', d.focusedRect && d.focusedRect.top >= 70, JSON.stringify(d.focusedRect));
  }

  // -------------------------------------------------------------- streaming-style site

  async function streaming() {
    await load(`${base}/index.html`);
    let d = await pressUntil('ArrowDown', /poster-0-/, 6);
    check('home: down from the hero reaches the first poster row', /poster-0-/.test(d.focused), d.focused);
    const col = Number((/poster-0-(\d+)/.exec(d.focused || '') || [])[1] || 0);
    await press('ArrowRight', 3, 300);
    d = await debug();
    check('home: right walks along the row', (d.focused || '').indexOf(`poster-0-${col + 3}`) >= 0, d.focused);
    await press('ArrowDown');
    d = await debug();
    const below = Number((/poster-1-(\d+)/.exec(d.focused || '') || [])[1] || -9);
    check('home: down goes to the poster straight below', Math.abs(below - (col + 3)) <= 1, d.focused);
    await press('ArrowUp');
    await press('Enter', 1, 1200);
    check('home: OK opens the title page', wc.getURL().indexOf(`title.html?id=0-${col + 3}`) >= 0, wc.getURL());
    check('home: the ad tab was blocked', !/ad\.html/.test(wc.getURL()) && BrowserWindow.getAllWindows().length === 1);

    await load(`${base}/index.html`);
    await press('ArrowDown');
    await pressUntil('ArrowRight', /search-btn/, 6);
    await press('Enter', 1, 900);
    d = await debug();
    check('home: search button opens the keyboard on the revealed field', d.osk, d.focused);
    await press('Back');

    await load(`${base}/title.html`);
    await pressUntil('ArrowDown', /a\.btn/, 4);
    d = await pressUntil('ArrowLeft', /a#watch/, 3);
    check('title: reaches "Watch now"', /a#watch/.test(d.focused), d.focused);
    await press('Enter', 1, 1200);
    check('title: OK opens the watch page', /watch\.html/.test(wc.getURL()), wc.getURL());

    await wait(500);
    d = await pressUntil('ArrowDown', /^video/, 3);
    check('watch: down from the header reaches the video', /^video/.test(d.focused || ''), d.focused);
    await press('Enter', 1, 800);
    d = await debug();
    check('watch: OK on the video starts playback', d.video && !d.video.paused, JSON.stringify(d.video));
    await press('ArrowDown');
    d = await debug();
    check('watch: down from the video enters its control bar', /button\.play/.test(d.focused || ''), d.focused);
    await press('ArrowUp');
    d = await debug();
    check('watch: up from the control bar returns to the video', /^video/.test(d.focused || ''), d.focused);
    await press('ArrowDown');

    await press('ArrowRight');
    d = await debug();
    check('watch: right reaches the seek bar', /progress/.test(d.focused), d.focused);
    await press('ArrowRight');
    d = await debug();
    check('watch: arrows pass over the seek bar until it is engaged', /time|vol/.test(d.focused), d.focused);
    await press('ArrowLeft');
    const t0 = await videoTime();
    await press('Enter', 1, 300);
    await press('ArrowRight', 4, 120); // 10 + 10 + 10 + 20 = +50 s
    d = await debug();
    check('watch: OK then right previews a scrub', d.scrubbing);
    await press('Enter', 1, 600);
    const t1 = await videoTime();
    check('watch: OK commits the scrub', t1 - t0 > 40 && t1 - t0 < 60, `${t0.toFixed(1)} -> ${t1.toFixed(1)}`);
    check('watch: the seek bar was not clicked at its middle', (await evalIn(null, 'window.__seekClicks || 0')) === 0);
    await press('ArrowRight');
    d = await debug();
    check('watch: after committing, right moves on again', /time|vol/.test(d.focused), d.focused);

    await pressUntil('ArrowRight', /input\.vol/, 3);
    await press('Enter');
    await press('ArrowLeft', 4, 150);
    await press('Enter');
    d = await debug();
    check('watch: volume slider adjusts', d.video && d.video.volume < 0.9, `volume=${d.video && d.video.volume}`);

    const p0 = (await debug()).video.paused;
    await press('PlayPause', 1, 500);
    check('watch: the Play/Pause key toggles playback', (await debug()).video.paused !== p0);
    if (!(await debug()).video.paused) await press('PlayPause', 1, 500);
    await press('PlayPause', 1, 500); // playing again

    await pressUntil('ArrowRight', /button\.fs/, 3);
    await press('Enter', 1, 1000);
    const fullscreen = await evalIn(null, '!!document.fullscreenElement');
    check('watch: fullscreen button works', fullscreen);
    const t2 = await videoTime();
    await press('ArrowRight', 2, 150);
    await wait(1100);
    const t3 = await videoTime();
    check('watch: in fullscreen, right scrubs directly', t3 - t2 > 15 && t3 - t2 < 26, `${t2.toFixed(1)} -> ${t3.toFixed(1)}`);
    await press('ArrowUp', 1, 700);
    d = await debug();
    check('watch: up in fullscreen reaches the player controls', /button|progress|vol|time/.test(d.focused || ''), d.focused);
    await press('Back');
    await press('Back', 1, 800);
    check('watch: Back twice leaves fullscreen', !(await evalIn(null, '!!document.fullscreenElement')));

    await load(`${base}/embed.html`);
    await wait(600);
    d = await pressUntil('ArrowDown', /iframe#player-frame/, 6);
    check('embed: down reaches the player iframe', /iframe#player-frame/.test(d.focused), d.focused);
    await press('Enter', 1, 900);
    d = await debug();
    const fd = await debug(frame());
    check('embed: OK hands the remote to the player frame', d.mode === 'frame' && fd.active, `mode=${d.mode} frame active=${fd.active}`);
    await press('Enter', 1, 600); // no entering click on the TV: OK starts it
    const playing = !(await evalIn(frame(), 'document.querySelector("video").paused'));
    check('embed: OK inside the frame starts playback', playing);
    const f0 = await videoTime(frame());
    await press('ArrowRight', 3, 150);
    await wait(1100);
    const f1 = await videoTime(frame());
    check('embed: right scrubs the video inside the frame', f1 - f0 > 25 && f1 - f0 < 36, `${f0.toFixed(1)} -> ${f1.toFixed(1)}`);
    await press('ArrowDown', 1, 700);
    d = await debug(frame());
    check('embed: down reaches the controls inside the frame', /button|progress|vol|time/.test(d.focused || ''), d.focused);
    await press('Enter', 1, 600);
    const paused = await evalIn(frame(), 'document.querySelector("video").paused');
    check('embed: OK on a control inside the frame clicks it', /button\.play/.test(d.focused) ? paused : true, d.focused);
    await press('Back');
    await press('Back', 1, 600);
    d = await debug();
    check('embed: Back twice returns the remote to the page', d.mode === 'nav' && /iframe/.test(d.focused || ''), `mode=${d.mode} focused=${d.focused}`);
    await press('ArrowDown');
    d = await debug();
    check('embed: page navigation resumes below the player', /Server/.test(d.focused || ''), d.focused);
  }

  // -------------------------------------------------------------- explore a real site

  async function explore() {
    const shots = arg('shots');
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const cookie = arg('cookie');
    if (cookie) {
      const eq = cookie.indexOf('=');
      await wc.session.cookies.set({ url: EXPLORE, name: cookie.slice(0, eq), value: cookie.slice(eq + 1) });
    }
    wc.setUserAgent(TIZEN_UA);
    await load(EXPLORE);
    await wait(Number(arg('wait') || 2500)); // let the site's scripts build the page
    const steps = (arg('keys') || '').split(',').filter(Boolean);
    let n = 0;
    const report = async (label) => {
      const d = await debug();
      const r = d.focusedRect;
      console.log(`${String(n).padStart(2, '0')} ${label.padEnd(12)} ${d.shell ? 'shell:' + d.shell + ' ' + d.shellFocused : (d.mode || '?') + ' ' + d.focused}` +
        `${r ? `  @${r.left},${r.top} ${r.width}x${r.height}` : ''}  scrollY=${d.scrollY}  ${wc.getURL()}`);
      if (shots) fs.writeFileSync(path.join(shots, `${String(n).padStart(2, '0')}.png`), (await wc.capturePage()).toPNG());
      if (process.env.CANDIDATES) {
        const list = await evalIn(null, `window.__browserOSCandidates(${JSON.stringify(process.env.CANDIDATES)})`);
        for (const c of (list || []).slice(0, 8)) console.log(`     ${String(c.score).padStart(5)} p=${c.primary} ${c.pointer ? 'ptr' : 'sel'} ${JSON.stringify(c.rect)} ${c.el.replace(/\s+/g, ' ').slice(0, 60)}`);
      }
      n++;
    };
    await report('start');
    for (const step of steps) {
      const m = /^(\w+)(?:\*(\d+))?$/.exec(step);
      for (let i = 0; i < Number(m[2] || 1); i++) {
        await press(m[1], 1, 600);
        await report(m[1]);
      }
    }
  }

  if (EXPLORE) {
    win.setContentSize(1920, 1080);
    await explore();
    stopServers();
    return app.exit(0);
  }

  const all = { basic, layout, shell, streaming };
  console.log(MODERN ? 'Modern APIs left in place.' : 'Chromium 69 fallbacks forced (popover, adoptedStyleSheets, checkVisibility removed).');
  try {
    for (const name of SUITES) {
      console.log(`\n# ${name}`);
      await all[name]();
    }
  } catch (err) {
    console.error(err);
    results.push(false);
  }
  stopServers();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  app.exit(1);
});
app.on('window-all-closed', () => {});
