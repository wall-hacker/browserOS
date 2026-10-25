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
