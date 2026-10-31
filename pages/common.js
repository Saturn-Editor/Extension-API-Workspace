function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'className') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showInvalid(error) {
  let cover = document.getElementById('invalid');
  if (!cover) {
    cover = el('div', { id: 'invalid' });
    document.body.append(cover);
  }
  cover.replaceChildren(
    el('div', { className: 'empty' },
      el('p', { className: 'error' }, "This file can't be read, so it isn't shown here."),
      el('p', { className: 'mono muted' }, error),
      el('p', { className: 'muted' }, 'It may have git conflict markers or a typing mistake. Fix it as text, and this view will come back. Nothing has been changed.')),
  );
}

function hideInvalid() {
  document.getElementById('invalid')?.remove();
}

function readReload(text, onValid) {
  if (!String(text ?? '').trim()) {
    hideInvalid();
    onValid({});
    return;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file should hold a JSON object.');
    hideInvalid();
    onValid(value);
  } catch (error) {
    showInvalid(error.message);
  }
}

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.box.remove();
  document.removeEventListener('mousedown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.keys, true);
  openMenu.anchor.focus();
  openMenu = null;
}

function showMenu(anchor, items, onPick) {
  closeMenu();
  const buttons = [];
  const box = el('div', { className: 'menu', role: 'menu' });
  for (const item of items) {
    if (item === '-') {
      box.append(el('div', { className: 'menu-sep' }));
      continue;
    }
    const button = el('button', {
      className: `menu-item${item.current ? ' current' : ''}`,
      role: 'menuitem',
      onclick: () => { closeMenu(); onPick(item.value); },
    }, item.label);
    buttons.push(button);
    box.append(button);
  }
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom;
  box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4))}px`;
  box.style.top = below < box.offsetHeight + 8 && r.top > box.offsetHeight + 8 ? `${r.top - box.offsetHeight - 2}px` : `${r.bottom + 2}px`;
  const outside = e => { if (!box.contains(e.target) && e.target !== anchor) closeMenu(); };
  const keys = e => {
    const at = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(at + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length].focus(); }
  };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', keys, true);
  openMenu = { box, anchor, outside, keys };
  (buttons.find(b => b.classList.contains('current')) || buttons[0])?.focus();
}

function picker(options, value, onPick, className) {
  const button = el('button', { className: `picker${className ? ` ${className}` : ''}`, type: 'button' });
  let current = value;
  const label = () => {
    const found = options().find(o => o !== '-' && o.value === current);
    button.replaceChildren(el('span', {}, found ? found.label : current || 'None'), el('span', { className: 'caret' }, '▾'));
  };
  button.addEventListener('click', () => {
    if (openMenu && openMenu.anchor === button) return closeMenu();
    showMenu(button, options().map(o => (o === '-' ? o : { ...o, current: o.value === current })), onPick);
  });
  button.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); button.click(); }
  });
  button.set = v => { current = v; label(); };
  label();
  return button;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createEditor(initial, render) {
  let doc = clone(initial);
  let stack = [JSON.stringify(doc)];
  let index = 0;
  let timer = null;

  function commit() {
    clearTimeout(timer);
    timer = null;
    if (document.getElementById('invalid')) return;
    const text = JSON.stringify(doc);
    if (text === stack[index]) return;
    stack = stack.slice(0, index + 1);
    stack.push(text);
    if (stack.length > 200) stack.shift();
    index = stack.length - 1;
    saturn.postMessage({ type: 'change', doc: clone(doc) });
  }

  function step(delta) {
    if (document.getElementById('invalid')) return;
    if (timer) commit();
    const next = index + delta;
    if (next < 0 || next >= stack.length) return;
    index = next;
    doc = JSON.parse(stack[index]);
    render();
    saturn.postMessage({ type: 'change', doc: clone(doc) });
  }

  return {
    get doc() { return doc; },
    edit(change, now) {
      change(doc);
      clearTimeout(timer);
      if (now) commit();
      else timer = setTimeout(commit, 350);
    },
    flush() { if (timer) commit(); },
    undo() { step(-1); },
    redo() { step(1); },
    replace(next) {
      clearTimeout(timer);
      timer = null;
      doc = clone(next);
      stack = [JSON.stringify(doc)];
      index = 0;
      render();
    },
  };
}

function rowsTable(rows, { onEdit, onStructure, namePlaceholder = 'Name', valuePlaceholder = 'Value', toggle = true, secret = false }) {
  const body = el('tbody');
  rows.forEach((row, i) => {
    const valueInput = el('input', {
      type: secret ? 'password' : 'text',
      value: row.value,
      placeholder: valuePlaceholder,
      spellcheck: 'false',
      oninput: e => onEdit(r => { r[i].value = e.target.value; }),
    });
    body.append(
      el('tr', { className: toggle && row.enabled === false ? 'off' : '' },
        toggle
          ? el('td', { className: 'check' },
              el('input', {
                type: 'checkbox',
                checked: row.enabled !== false,
                title: 'Include',
                onchange: e => onStructure(r => { r[i].enabled = e.target.checked; }),
              }))
          : null,
        el('td', {},
          el('input', {
            type: 'text',
            value: row.name,
            placeholder: namePlaceholder,
            spellcheck: 'false',
            oninput: e => onEdit(r => { r[i].name = e.target.value; }),
          })),
        el('td', {}, valueInput),
        el('td', { className: 'del' },
          el('button', { className: 'ghost', title: 'Remove', onclick: () => onStructure(r => { r.splice(i, 1); }) }, '×')),
      ),
    );
  });
  const add = el('button', {
    className: 'ghost',
    onclick: () => onStructure(r => { r.push(toggle ? { name: '', value: '', enabled: true } : { name: '', value: '' }); }, true),
  }, '+ Add');
  return el('div', {}, el('table', { className: 'grid' }, body), add);
}

function focusLastRow(container) {
  const inputs = container.querySelectorAll('table.grid tr:last-child input[type="text"]');
  if (inputs[0]) inputs[0].focus();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
