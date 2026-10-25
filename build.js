'use strict';
// Bundles src/ into dist/browseros.js, the single script TizenBrew injects into every
// page and frame. The sources share one function scope, so order matters only for
// top-level code that runs immediately (boot.js runs last).
// The bundle must parse on Chromium 69 (Tizen 5.5): it is checked as ES2019, which
// rejects ?., ??, numeric separators and class fields.

const fs = require('fs');
const path = require('path');

const ORDER = ['compat.js', 'osk.js', 'store.js', 'page.js', 'shell.js', 'remote.js', 'boot.js'];
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist', 'browseros.js');

const { version } = require('./package.json');
const parts = ORDER.map((name) => `// ---- ${name}\n${fs.readFileSync(path.join(SRC, name), 'utf8').trim()}\n`);
const bundle = `// BrowserOS TV ${version} for TizenBrew. Built from src/ by build.js; don't edit.
(function () {
  'use strict';
  // TizenBrew evaluates the module in every new execution context; run once per document.
  if (window.__browserOS) return;
  // Anti-bot checks (Cloudflare Turnstile, reCAPTCHA, hCaptcha) fail if anything touches
  // their frame, and sites then refuse to play or log in. Leave them alone.
  if (/(^|\\.)(challenges\\.cloudflare\\.com|hcaptcha\\.com|recaptcha\\.net)$/.test(location.hostname) ||
    (/(^|\\.)google\\.com$/.test(location.hostname) && /^\\/recaptcha\\//.test(location.pathname))) return;
  window.__browserOS = true;

${parts.join('\n')}
})();
`;

try {
  require('acorn').parse(bundle, { ecmaVersion: 2019, sourceType: 'script' });
} catch (err) {
  const line = err.loc ? bundle.split('\n')[err.loc.line - 1] : '';
  console.error(`dist/browseros.js would not parse on Chromium 69: ${err.message}\n  ${line.trim()}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bundle);
console.log(`built ${path.relative(__dirname, OUT)} (${(bundle.length / 1024).toFixed(1)} KB)`);
