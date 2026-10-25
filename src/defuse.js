// TizenBrew drives the page through a DevTools connection, with Runtime and Debugger
// enabled. Anti-DevTools scripts (disable-devtool and the like) read that as DevTools
// being open: logging gets slow because every console call is reported to the client.
// They then run a `debugger;` trap, and with TizenBrew's debugger attached and nothing
// to resume it, the page freezes for good. flystream.net's home page never fills in.
// Console output isn't visible on the TV, so the methods those detectors probe go quiet.
// Errors and warnings still get through.

(function quietConsole() {
  const quiet = function () {};
  for (const name of ['log', 'debug', 'info', 'table', 'dir', 'dirxml', 'clear', 'trace']) {
    try {
      if (typeof console[name] === 'function') console[name] = quiet;
    } catch (e) { /* read-only console */ }
  }
})();
