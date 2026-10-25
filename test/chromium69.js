'use strict';
// Loads a URL in real Chromium 69, the Tizen 5.5 engine, attached the way TizenBrew
// attaches to its app window (Runtime and Debugger enabled), optionally injecting
// dist/browseros.js into every execution context. Reports page errors, debugger pauses
// and what rendered. The Electron harness runs a modern engine, so problems that only
// show up on Chromium 69 or only under TizenBrew's debugger need this instead.
//
//   node test/chromium69.js <url> [--inject] [--plain] [--shot=file.png] [--wait=ms] [--count=selector]
//     --inject  run BrowserOS in every context, like TizenBrew
//     --plain   don't enable the Debugger domain (like the TV's own browser)
//
// Chromium 69: set CHROME69 to its chrome.exe, or unpack it into test/.chromium69/:
//   https://commondatastorage.googleapis.com/chromium-browser-snapshots/Win_x64/576753/chrome-win32.zip

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME69 || path.join(__dirname, '.chromium69', 'chrome-win32', 'chrome.exe');
const BUNDLE = fs.readFileSync(path.join(__dirname, '..', 'dist', 'browseros.js'), 'utf8');
const UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106.1/5.5 TV Safari/537.36';
const url = process.argv[2];
const inject = process.argv.includes('--inject');
const plain = process.argv.includes('--plain');
const opt = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!url || !fs.existsSync(CHROME)) {
  console.error(!url ? 'usage: node test/chromium69.js <url> [--inject] ...' : `Chromium 69 not found at ${CHROME}`);
  process.exit(1);
}

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium69-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1920,1080', `--user-agent=${UA}`, '--disable-site-isolation-trials', '--disable-features=site-per-process',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

async function main() {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) {
    await wait(200);
    try {
      targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page');
    } catch (e) { /* not up yet */ }
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const notes = [];
  let pauses = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result || m.error);
      pending.delete(m.id);
      return;
    }
    const p = m.params;
    if (m.method === 'Runtime.executionContextCreated' && inject) {
      send('Runtime.evaluate', { expression: BUNDLE, contextId: p.context.id }).then((r) => {
        const ex = r && r.exceptionDetails;
        if (ex) notes.push(`INJECTION FAILED in ${p.context.origin}: ${(ex.exception && ex.exception.description) || ex.text}`);
      });
    } else if (m.method === 'Debugger.paused') {
      // Nobody resumes under TizenBrew: the page is frozen from here on.
      if (++pauses <= 3) notes.push(`PAUSED (${p.reason}) at ${p.callFrames[0] && p.callFrames[0].url}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      notes.push(`exception: ${((d.exception && d.exception.description) || d.text || '').split('\n')[0].slice(0, 200)}  @ ${d.url || ''}`);
    }
  };
  await send('Runtime.enable');
  if (!plain) await send('Debugger.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await wait(Number(opt('wait') || 15000));
  const count = opt('count') || 'a[href], button';
  const res = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({ url: location.href, title: document.title, ready: document.readyState,
      matches: document.querySelectorAll(${JSON.stringify(count)}).length, browserOS: !!window.__browserOSDebug })`,
  });
  console.log(`${inject ? 'with' : 'without'} BrowserOS${plain ? '' : ', TizenBrew debugger attached'}:`,
    res.result ? JSON.stringify(res.result.value) : 'NO ANSWER (frozen)', `pauses=${pauses}`);
  for (const note of notes.slice(0, 20)) console.log('  ' + note);
  const shot = opt('shot');
  if (shot) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) fs.writeFileSync(shot, Buffer.from(s.data, 'base64'));
  }
}

main().catch((err) => console.error(err)).then(() => {
  chrome.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (e) { /* still locked */ }
  process.exit(0);
});
