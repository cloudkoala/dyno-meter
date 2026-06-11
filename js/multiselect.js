// A token/tag multi-select with a "+" button that opens a searchable,
// scrollable popup of all options (click to toggle) plus an add-new row.
// Values and options are plain string arrays — structured this way so saved
// sessions can be filtered/searched by material later without reparsing text.

export class MultiSelect {
  constructor(root, { onChange = () => {}, onAddOption = () => {} } = {}) {
    this.root = root;
    this.onChange = onChange;       // (values: string[]) => void
    this.onAddOption = onAddOption; // (value, options: string[]) => void
    this.values = [];
    this.options = [];
    this.disabled = false;
    this._render();
    document.addEventListener('click', (e) => { if (!this.root.contains(e.target)) this._close(); });
  }

  _render() {
    this.root.classList.add('multiselect');
    this.control = document.createElement('div');
    this.control.className = 'ms-control';
    this.addBtn = document.createElement('button');
    this.addBtn.type = 'button';
    this.addBtn.className = 'ms-add-btn';
    this.addBtn.textContent = '+';
    this.addBtn.title = 'Add material';
    this.addBtn.onclick = (e) => { e.stopPropagation(); this._toggle(); };
    // Clicking the control's empty space (not a chip) opens the picker too.
    this.control.addEventListener('click', (e) => { if (e.target === this.control) this._open(); });
    this.control.appendChild(this.addBtn);

    this.popup = document.createElement('div');
    this.popup.className = 'ms-popup';
    this.popup.hidden = true;
    this.search = document.createElement('input');
    this.search.className = 'ms-search';
    this.search.type = 'text';
    this.search.placeholder = 'Search or add…';
    this.list = document.createElement('div');
    this.list.className = 'ms-list';
    this.popup.append(this.search, this.list);
    this.root.append(this.control, this.popup);

    this.search.addEventListener('input', () => this._renderList());
    this.search.addEventListener('keydown', (e) => this._onKey(e));
    this._renderChips();
  }

  setOptions(options) {
    this.options = [...new Set((options || []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (!this.popup.hidden) this._renderList();
  }
  setValues(values) {
    const arr = Array.isArray(values) ? values : (values ? [values] : []);
    this.values = [...new Set(arr.filter(Boolean))];
    this._renderChips();
    if (!this.popup.hidden) this._renderList();
  }
  getValues() { return [...this.values]; }
  setDisabled(d) {
    this.disabled = d;
    this.addBtn.disabled = d;
    this.root.classList.toggle('ms-disabled', d);
    this._renderChips();
    if (d) this._close();
  }

  _renderChips() {
    this.control.querySelectorAll('.ms-chip').forEach((c) => c.remove());
    for (const v of this.values) {
      const chip = document.createElement('span');
      chip.className = 'ms-chip';
      chip.textContent = v;
      if (!this.disabled) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ms-chip-x';
        x.textContent = '×';
        x.onclick = (e) => { e.stopPropagation(); this._remove(v); };
        chip.appendChild(x);
      }
      this.control.insertBefore(chip, this.addBtn);
    }
  }

  _open() {
    if (this.disabled || !this.popup.hidden) return;
    this.popup.hidden = false;
    this.search.value = '';
    this._renderList();
    this.search.focus();
  }
  _toggle() {
    if (this.disabled) return;
    if (this.popup.hidden) this._open();
    else this._close();
  }
  _close() { this.popup.hidden = true; }

  _renderList() {
    const q = this.search.value.trim().toLowerCase();
    const matches = this.options.filter((o) => o.toLowerCase().includes(q));
    this.list.innerHTML = '';
    for (const o of matches) {
      const selected = this.values.includes(o);
      const item = document.createElement('div');
      item.className = 'ms-option' + (selected ? ' selected' : '');
      const check = document.createElement('span');
      check.className = 'ms-check';
      check.textContent = selected ? '✓' : '';
      const label = document.createElement('span');
      label.textContent = o;
      item.append(check, label);
      item.onclick = () => this._toggleValue(o);
      this.list.appendChild(item);
    }
    const typed = this.search.value.trim();
    if (typed && !this.options.some((o) => o.toLowerCase() === typed.toLowerCase())) {
      const add = document.createElement('div');
      add.className = 'ms-option ms-add';
      add.textContent = `Add “${typed}”`;
      add.onclick = () => this._add(typed, true);
      this.list.appendChild(add);
    } else if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'ms-empty';
      empty.textContent = this.options.length ? 'No matches' : 'No materials yet — type to add';
      this.list.appendChild(empty);
    }
  }

  _onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const typed = this.search.value.trim();
      if (!typed) return;
      const match = this.options.find((o) => o.toLowerCase() === typed.toLowerCase());
      this._add(match || typed, !match);
    } else if (e.key === 'Escape') {
      this._close();
    }
  }

  _toggleValue(v) { if (this.values.includes(v)) this._remove(v); else this._addValue(v); }
  _addValue(v) {
    if (!this.values.includes(v)) {
      this.values.push(v);
      this._renderChips();
      this.onChange([...this.values]);
      this._renderList();
    }
  }
  _remove(v) {
    this.values = this.values.filter((x) => x !== v);
    this._renderChips();
    this.onChange([...this.values]);
    if (!this.popup.hidden) this._renderList();
  }
  _add(value, isNew) {
    this._addValue(value);
    if (isNew && !this.options.some((o) => o.toLowerCase() === value.toLowerCase())) {
      this.options.push(value);
      this.options.sort((a, b) => a.localeCompare(b));
      this.onAddOption(value, [...this.options]);
    }
    this.search.value = '';
    this._renderList();
    this.search.focus();
  }
}
