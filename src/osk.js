// On-screen keyboard driven by a D-pad, used by page text fields and the shell's address
// screen. Ported from the Electron build's src/osk.js: same layout and behaviour, with
// DOM and CSS that Chromium 69 understands (no flex gap, min() or replaceChildren).

const OSK_CSS = `
.osk {
  position: fixed; left: 50%; bottom: 2.5vh; transform: translateX(-50%);
  width: 94vw; max-width: 150vh; box-sizing: border-box; padding: 1.6vh 1.6vh 1.2vh;
  border-radius: 2.2vh; background: rgba(18, 21, 30, .97); color: #f4f6fb;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06);
  font-family: "Samsung One", "SamsungOne", "Segoe UI", Roboto, sans-serif;
  pointer-events: auto; z-index: 1;
}
.osk-preview {
  height: 6.4vh; padding: 0 2.2vh; margin-bottom: .6vh; border-radius: 1.2vh;
  background: rgba(255, 255, 255, .07); font-size: 2.9vh; line-height: 6.4vh;
  white-space: pre; overflow: hidden;
}
.osk-preview.empty { color: rgba(244, 246, 251, .4); }
.osk-preview::after {
  content: ''; display: inline-block; width: .3vh; height: 3.6vh; margin-left: .3vh;
  vertical-align: -0.7vh; background: #3d8bff;
}
.osk-preview.empty::after { margin: 0 .3vh 0 0; }
.osk-row { display: flex; margin-top: .9vh; }
.osk-key {
  flex: 1 1 0; min-width: 0; height: 7vh; border-radius: 1.1vh;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, .09); font-size: 3vh; font-weight: 500;
  cursor: pointer; user-select: none;
}
.osk-key + .osk-key { margin-left: .9vh; }
.osk-key.fn { background: rgba(255, 255, 255, .16); font-size: 2.3vh; }
.osk-key.accent { background: #2f6fd6; }
.osk-key.lit { color: #6fb0ff; }
.osk-key.on { background: #fff; color: #0b0d12; position: relative; z-index: 1; }
`;

function oskKey(label, action, w, cls, value) {
  return { label, action: action || 'char', w: w || 1, cls: cls || '', value: value === undefined ? label : value };
}

function oskChars(s) {
  return s.split(' ').map((c) => oskKey(c));
}

function oskRows(page, shift, enterLabel, kind) {
  const bottom = (toggle) => [
    oskKey(toggle, 'page', 2, 'fn'),
    oskKey('‹', 'left', 1, 'fn'),
    oskKey('space', 'space', 4, 'fn', ' '),
    oskKey('›', 'right', 1, 'fn'),
    kind === 'url' || kind === 'email' ? oskKey('.com', 'char', 2, 'fn') : oskKey('Done', 'done', 2, 'fn'),
  ];
  if (page === 'symbols') {
    return [
      oskChars('1 2 3 4 5 6 7 8 9 0 -').concat([oskKey('⌫', 'backspace', 1, 'fn')]),
      oskChars('! @ # $ % ^ & * ( ) _').concat([oskKey('Clear', 'clear', 1, 'fn')]),
      oskChars('+ = / \\ : ; " \' ? ~').concat([oskKey(enterLabel, 'enter', 2, 'accent')]),
      oskChars('[ ] { } < > | ` , . € £'),
      bottom('ABC'),
    ];
  }
  const letters = (s) => s.split(' ').map((c) => oskKey(shift ? c.toUpperCase() : c));
  return [
    oskChars('1 2 3 4 5 6 7 8 9 0 -').concat([oskKey('⌫', 'backspace', 1, 'fn')]),
    letters('q w e r t y u i o p').concat([oskKey('@'), oskKey('Clear', 'clear', 1, 'fn')]),
    letters('a s d f g h j k l').concat([oskKey("'"), oskKey(enterLabel, 'enter', 2, 'accent')]),
    [oskKey('⇧', 'shift', 2, shift ? 'fn lit' : 'fn')].concat(letters('z x c v b n m'), oskChars(', . /')),
    bottom('&123'),
  ];
}

class Keyboard {
  /**
   * @param {Element|ShadowRoot} container where the keyboard is appended
   * @param {{onKey: (action: string, value?: string) => void, kind?: string,
   *          enterLabel?: string, preview?: boolean}} opts
   */
  constructor(container, opts) {
    this.opts = opts;
    this.kind = opts.kind || 'text';
    this.page = this.kind === 'number' ? 'symbols' : 'letters';
    this.shift = false;
    this.row = 1;
    this.col = 0;
    addStyles(container.getRootNode ? container.getRootNode() : container, OSK_CSS);
    this.el = document.createElement('div');
    this.el.className = 'osk';
    if (opts.preview !== false) {
      this.previewEl = document.createElement('div');
      this.previewEl.className = 'osk-preview';
      this.el.appendChild(this.previewEl);
    }
    this.keysEl = document.createElement('div');
    this.el.appendChild(this.keysEl);
    // Keep focus in the text field when the keyboard is clicked with a pointer.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    container.appendChild(this.el);
    this.render();
  }

  get rows() {
    return oskRows(this.page, this.shift, this.opts.enterLabel || 'Go', this.kind);
  }

  render() {
    const rows = this.rows;
    this.row = Math.min(this.row, rows.length - 1);
    this.col = Math.min(this.col, rows[this.row].length - 1);
    replaceKids(this.keysEl, rows.map((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      row.forEach((k, c) => {
        const el = document.createElement('div');
        el.className = `osk-key ${k.cls}${r === this.row && c === this.col ? ' on' : ''}`;
        el.style.flex = `${k.w} 1 0px`;
        el.textContent = k.label;
        el.addEventListener('click', () => {
          this.row = r;
          this.col = c;
          this.press();
        });
        rowEl.appendChild(el);
      });
      return rowEl;
    }));
  }

  /** Moves the highlight. Returns false when already at that edge (up/down). */
  move(dir) {
    const rows = this.rows;
    const row = rows[this.row];
    if (dir === 'left' || dir === 'right') {
      const n = row.length;
      this.col = (this.col + (dir === 'right' ? 1 : n - 1)) % n;
    } else {
      const target = this.row + (dir === 'down' ? 1 : -1);
      if (target < 0 || target >= rows.length) return false;
      // Land on the key in the next row whose centre is closest to the current one.
      const center = (r, c) => rows[r].slice(0, c).reduce((s, k) => s + k.w, 0) + rows[r][c].w / 2;
      const x = center(this.row, this.col);
      let best = 0;
      rows[target].forEach((_, c) => {
        if (Math.abs(center(target, c) - x) < Math.abs(center(target, best) - x)) best = c;
      });
      this.row = target;
      this.col = best;
    }
    this.render();
    return true;
  }

  press() {
    const k = this.rows[this.row][this.col];
    switch (k.action) {
      case 'shift':
        this.shift = !this.shift;
        this.render();
        return;
      case 'page':
        this.page = this.page === 'letters' ? 'symbols' : 'letters';
        this.render();
        return;
      case 'space':
      case 'char':
        this.opts.onKey('char', k.value);
        if (this.shift && k.action === 'char') {
          this.shift = false;
          this.render();
        }
        return;
      default:
        this.opts.onKey(k.action);
    }
  }

  setPreview(text, placeholder) {
    if (!this.previewEl) return;
    const value = text.replace(/\s*\n\s*/g, ' ⏎ ');
    const shown = value.length > 70 ? '…' + value.slice(-69) : value;
    this.previewEl.textContent = shown || placeholder || '';
    this.previewEl.classList.toggle('empty', !shown);
  }

  destroy() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
