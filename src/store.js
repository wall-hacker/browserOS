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

function loadCarrier() {
  const empty = { favorites: null, pending: [], last: null };
  if (!IS_TOP) return empty;
  try {
    if (window.name.indexOf(NAME_PREFIX) === 0) return Object.assign(empty, JSON.parse(window.name.slice(NAME_PREFIX.length)));
  } catch (e) { /* a site's own window.name */ }
  return empty;
}

function saveCarrier() {
  if (!IS_TOP) return;
  try {
    window.name = NAME_PREFIX + JSON.stringify(carrier);
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
