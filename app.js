/*
 * Dwindle: a countdown to one date.
 *
 * There is no backend. The whole countdown (name, dates, goals) is encoded in
 * the URL, so a link IS a countdown. localStorage only remembers the last link
 * so that opening the bare URL brings it back.
 */
'use strict';

// ---------- Config ----------

// Where the state lives in the URL: 'hash' (#...) or 'query' (?s=...).
// Flip to 'query' if iOS standalone (home screen) mode drops the hash.
const STATE_MODE = 'hash';
const QUERY_KEY = 's';
const STORAGE_KEY = 'dwindle:last';

const VERSION = 1;
const MAX_NAME = 60;
const MAX_GOAL = 120;
const MAX_GOALS = 20;
const MAX_DOTS = 730; // beyond this, one dot stands for several days
const DAY_MS = 86400000;

const HINT_CREATED = 'Link created. Bookmark it to keep this countdown.';
const HINT_UPDATED = 'Link updated. Re-bookmark to keep this version.';

const $ = (id) => document.getElementById(id);

let state = null; // the current countdown { v, t, d, c, g }, or null
let timer = 0; // id of the pending tick
let shownDay = ''; // the day the dot grid was last drawn for
let backTo = ''; // encoded countdown the create form can return to

// ---------- Dates ----------
// Dates are plain "YYYY-MM-DD" strings. They only become Date objects at the
// last moment, and never by adding milliseconds to another date (DST).

// "YYYY-MM-DD" -> { y, m, d }, or null if it is not a real calendar date.
function parseDate(text) {
  const match = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Date rolls impossible dates over (30 Feb becomes 2 Mar), so check it back.
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return { y, m, d };
}

function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Local midnight at the START of the given day.
function localMidnight(iso) {
  const { y, m, d } = parseDate(iso);
  return new Date(y, m - 1, d);
}

// Whole calendar days from a to b. Counted in UTC, where every day has
// exactly 24 hours, so DST changes cannot make a day go missing.
function daysBetween(a, b) {
  const dayNumber = (iso) => {
    const { y, m, d } = parseDate(iso);
    return Date.UTC(y, m - 1, d) / DAY_MS;
  };
  return Math.round(dayNumber(b) - dayNumber(a));
}

// ---------- State format ----------
// JSON -> UTF-8 bytes -> base64url without padding. See README.md.

// Cut by code point, so an emoji is never split in half.
function clip(text, max) {
  return Array.from(text).slice(0, max).join('');
}

function encode(payload) {
  // btoa only understands code points 0-255, so go through UTF-8 bytes first.
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Throws on anything it cannot read. Callers use tryDecode().
function decode(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return normalize(migrate(JSON.parse(json)));
}

function tryDecode(encoded) {
  try {
    return encoded ? decode(encoded) : null;
  } catch (err) {
    return null;
  }
}

// Links live forever, so every payload passes through here and comes out in
// the current format. When v2 arrives: turn `case 1` into an upgrade step
// (payload = v1ToV2(payload)) that falls through to `case 2`.
function migrate(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Not a countdown');
  switch (payload.v) {
    case 1:
      return payload;
    default:
      throw new Error('Unknown version');
  }
}

// Trust nothing in a link: check the types, apply the limits, drop the rest.
function normalize(payload) {
  const name = typeof payload.t === 'string' ? clip(payload.t.trim(), MAX_NAME) : '';
  if (!name) throw new Error('Missing name');
  if (!parseDate(payload.d) || !parseDate(payload.c)) throw new Error('Bad date');
  const goals = (Array.isArray(payload.g) ? payload.g : [])
    .map((goal) => (goal && typeof goal.t === 'string' ? clip(goal.t.trim(), MAX_GOAL) : ''))
    .filter(Boolean)
    .slice(0, MAX_GOALS)
    .map((t) => ({ t }));
  return { v: VERSION, t: name, d: payload.d, c: payload.c, g: goals };
}

// ---------- Reading and writing the URL ----------
// Only these two functions know where the state lives in the URL.

// The encoded countdown in the URL, or '' if there is none.
function readState() {
  const fromHash = location.hash.slice(1);
  const fromQuery = new URLSearchParams(location.search).get(QUERY_KEY) || '';
  // Read the other place too, so links made before STATE_MODE was flipped
  // keep working.
  return STATE_MODE === 'query' ? fromQuery || fromHash : fromHash || fromQuery;
}

// replaceState, not pushState or location.hash: no history entry per edit.
function writeState(encoded) {
  let url = location.pathname;
  if (encoded) url += STATE_MODE === 'query' ? `?${QUERY_KEY}=${encoded}` : `#${encoded}`;
  try {
    history.replaceState(null, '', url);
  } catch (err) {
    // Safari throws if replaceState is called too often. The next edit retries.
  }
}

// ---------- localStorage (may be unavailable, e.g. in private mode) ----------

function readLast() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (err) {
    return '';
  }
}

function saveLast(encoded) {
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
  } catch (err) {
    // The URL still holds the state, so there is nothing to do.
  }
}

// ---------- Rendering ----------

// The interface is English, so the date is too. en-GB reads day-month-year
// with a 24-hour clock ("Sun, 14 Mar 2027, 00:00"), which is hard to misread.
// Pass undefined instead to follow each visitor's own locale.
const targetFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// Draws everything for the current state, then starts the clock.
function render() {
  document.title = state.t;
  $('intro').hidden = true;
  $('notice').hidden = true;
  $('view').hidden = false;
  $('name').textContent = state.t;

  $('goals').hidden = state.g.length === 0;
  $('goal-list').replaceChildren(
    ...state.g.map((goal) => {
      const item = document.createElement('li');
      item.textContent = goal.t;
      return item;
    })
  );

  shownDay = ''; // make tick() redraw the dot grid
  tick();
}

// Runs about once a second. Everything is derived from the clock on each run
// (never from a counter), so a tab that slept in the background cannot drift.
function tick() {
  clearTimeout(timer);
  if (!state) return;

  const target = localMidnight(state.d);
  const remaining = target.getTime() - Date.now();
  const passed = remaining <= 0;
  const today = todayISO();

  // The dot grid only changes when the calendar day does.
  if (today !== shownDay) {
    shownDay = today;
    renderDots(today);
  }

  $('ticker').hidden = passed;
  $('passed').hidden = !passed;
  $('target').textContent =
    `${passed ? 'since' : 'until'} ${targetFormat.format(target)} (your local time)`;

  if (passed) {
    const ago = daysBetween(state.d, today);
    $('passed').textContent =
      ago < 1 ? 'Today is the day.' : `Deadline passed ${ago} ${ago === 1 ? 'day' : 'days'} ago`;
    return; // nothing left to count, so stop ticking
  }

  const seconds = Math.floor(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const pad = (n) => String(n).padStart(2, '0');
  $('t-days').textContent = days;
  $('t-days').classList.toggle('long', days > 99999);
  $('t-days-label').textContent = days === 1 ? 'day' : 'days';
  $('t-hours').textContent = pad(Math.floor(seconds / 3600) % 24);
  $('t-minutes').textContent = pad(Math.floor(seconds / 60) % 60);
  $('t-seconds').textContent = pad(seconds % 60);

  // Wake up just after the next whole second of `remaining` ticks over.
  timer = setTimeout(tick, (remaining % 1000) + 20);
}

// One dot per calendar day from the creation date up to the target date.
function renderDots(today) {
  const total = Math.max(1, daysBetween(state.c, state.d)); // guards created >= target
  const left = Math.min(total, Math.max(0, daysBetween(today, state.d)));
  const gone = total - left;
  const perDot = Math.ceil(total / MAX_DOTS);
  const count = Math.ceil(total / perDot);

  const dots = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('i');
    // This dot covers the days numbered firstDay..lastDay; today is day `gone`.
    const firstDay = i * perDot;
    const lastDay = Math.min(total, firstDay + perDot) - 1;
    if (lastDay < gone) dot.className = 'gone';
    else if (firstDay <= gone) dot.className = 'today';
    dots.append(dot);
  }

  const grid = $('dots');
  grid.replaceChildren(dots);
  grid.classList.toggle('few', count <= 90);
  grid.setAttribute('aria-label', `${gone} of ${total} days gone, ${left} left`);
  $('percent').textContent = `${Math.floor((gone / total) * 100)}% gone`;
  $('scale').textContent = perDot > 1 ? `· each dot is ${perDot} days` : '';
}

// ---------- Create / edit form ----------

const editor = $('editor');
const nameInput = $('f-name');
const dateInput = $('f-date');
const goalRows = $('f-goals');

// source: a countdown to edit, or null for a blank create form.
function fillForm(source) {
  nameInput.value = source ? source.t : '';
  dateInput.value = source ? source.d : '';
  nameInput.setCustomValidity('');
  dateInput.setCustomValidity('');
  goalRows.replaceChildren();
  (source ? source.g : [{ t: '' }]).forEach((goal) => addGoalRow(goal.t));
  $('f-submit').textContent = source ? 'Done' : 'Start countdown';
  $('f-new').hidden = !source;
  $('f-back').hidden = Boolean(source) || !backTo;
}

function addGoalRow(text) {
  const row = document.createElement('li');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = MAX_GOAL;
  input.autocomplete = 'off';
  input.placeholder = 'Book flights';
  input.setAttribute('aria-label', 'Goal');
  input.value = text;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove goal');
  row.append(input, remove);
  goalRows.append(row);
  $('f-add').disabled = goalRows.children.length >= MAX_GOALS;
  return input;
}

// Builds a countdown from the form, or returns null if name or date is unusable.
function formToState() {
  const name = clip(nameInput.value.trim(), MAX_NAME);
  if (!name || !parseDate(dateInput.value)) return null;
  const goals = Array.from(goalRows.querySelectorAll('input'))
    .map((input) => clip(input.value.trim(), MAX_GOAL))
    .filter(Boolean)
    .slice(0, MAX_GOALS)
    .map((t) => ({ t }));
  // The creation date is set once, when the countdown is made, and then kept.
  const created = state ? state.c : todayISO();
  return { v: VERSION, t: name, d: dateInput.value, c: created, g: goals };
}

// The one path every change takes: URL, storage, screen, hint.
function commit(next, hint) {
  const encoded = encode(next);
  writeState(encoded);
  saveLast(encoded);
  state = next;
  render();
  showHint(hint);
}

// Saves the form while editing, if it is valid and something really changed.
function saveEdits() {
  const next = formToState();
  if (next && encode(next) !== encode(state)) commit(next, HINT_UPDATED);
}

function openEditor() {
  fillForm(state);
  editor.hidden = false;
  $('edit-toggle').textContent = 'Close';
  $('edit-toggle').setAttribute('aria-expanded', 'true');
}

function closeEditor() {
  editor.hidden = true;
  $('edit-toggle').textContent = 'Edit';
  $('edit-toggle').setAttribute('aria-expanded', 'false');
}

// ---------- The two screens ----------

function showCountdown(next) {
  state = next;
  closeEditor();
  render();
}

// message: optional friendly note. fallback: encoded countdown to offer a way
// back to (defaults to the last saved one).
function showCreate(message, fallback) {
  clearTimeout(timer);
  state = null;
  document.title = 'Dwindle';
  $('view').hidden = true;
  $('hint').hidden = true;
  $('intro').hidden = false;
  $('notice').textContent = message || '';
  $('notice').hidden = !message;

  const previous = tryDecode(fallback) ? fallback : readLast();
  const known = tryDecode(previous);
  backTo = known ? previous : '';
  if (known) $('f-back').textContent = `Back to “${known.t}”`;

  fillForm(null);
  editor.hidden = false;
}

// Decides what to show from the URL (and, for a bare URL, from storage).
function load() {
  const encoded = readState();
  if (encoded) {
    const decoded = tryDecode(encoded);
    if (decoded) showCountdown(decoded);
    else showCreate('This link is damaged or from a newer version, so it can’t be read. You can start a new countdown below.');
    return;
  }
  const last = readLast();
  const decoded = tryDecode(last);
  if (decoded) {
    writeState(last);
    showCountdown(decoded);
  } else {
    showCreate();
  }
}

// ---------- Hint and copy link ----------

function showHint(text) {
  $('hint').hidden = false;
  $('hint-text').textContent = text;
}

async function copyLink(button) {
  const url = location.href;
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch (err) {
    copied = copyBySelection(url); // no clipboard API, or permission denied
  }
  if (!copied) {
    window.prompt('Copy this link:', url); // last resort: the user copies by hand
    return;
  }
  button.textContent = 'Copied';
  setTimeout(() => {
    button.textContent = 'Copy link';
  }, 1500);
}

// Fallback for browsers or contexts (plain http) without navigator.clipboard.
function copyBySelection(text) {
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, text.length); // iOS needs an explicit range
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    copied = false;
  }
  field.remove();
  return copied;
}

// ---------- Events ----------

editor.addEventListener('submit', (event) => {
  event.preventDefault();
  nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Give the countdown a name.');
  dateInput.setCustomValidity(parseDate(dateInput.value) ? '' : 'Pick a real date (YYYY-MM-DD).');
  if (!editor.reportValidity()) return;
  if (state) saveEdits();
  else commit(formToState(), HINT_CREATED);
  closeEditor();
});

// While editing, each field saves as soon as it is left. (`change`, not
// `input`: one URL update per field instead of one per keystroke.)
editor.addEventListener('change', () => {
  if (state) saveEdits();
});

// Clear old error bubbles as soon as the user types again.
editor.addEventListener('input', (event) => {
  event.target.setCustomValidity('');
});

$('f-add').addEventListener('click', () => addGoalRow('').focus());

goalRows.addEventListener('click', (event) => {
  const remove = event.target.closest('.remove');
  if (!remove) return;
  remove.parentElement.remove();
  $('f-add').disabled = false;
  $('f-add').focus();
  if (state) saveEdits();
});

// Enter in a goal moves on to the next goal (adding one after the last)
// instead of submitting the form.
goalRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
  event.preventDefault();
  const nextRow = event.target.parentElement.nextElementSibling;
  if (nextRow) nextRow.querySelector('input').focus();
  else if (event.target.value.trim() && !$('f-add').disabled) addGoalRow('').focus();
  else event.target.blur();
});

$('edit-toggle').addEventListener('click', () => {
  if (editor.hidden) openEditor();
  else closeEditor();
});

// Starting over only clears the URL. Storage keeps the old countdown until a
// new one is actually created, so "Back to ..." (or a reload) undoes this.
$('f-new').addEventListener('click', () => {
  const current = encode(state);
  writeState('');
  showCreate('', current);
  nameInput.focus();
});

$('f-back').addEventListener('click', () => {
  const previous = tryDecode(backTo);
  if (!previous) return;
  writeState(backTo);
  showCountdown(previous);
});

$('copy').addEventListener('click', (event) => copyLink(event.currentTarget));
$('hint-copy').addEventListener('click', (event) => copyLink(event.currentTarget));
$('hint-close').addEventListener('click', () => {
  $('hint').hidden = true;
});

// The placeholder links point at "#TODO". Following one would overwrite the
// hash, which is the countdown itself, so swallow those clicks.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[href="#TODO"]')) event.preventDefault();
});

// A link pasted or edited by hand in the address bar.
window.addEventListener('hashchange', load);

// ---------- No zoom ----------
// Deliberate: zooming is switched off wherever a page is able to. Touch
// screens are handled by the viewport tag and `touch-action` in style.css;
// the rest is here. The browser's own menu zoom and the operating system's
// accessibility zoom cannot be blocked by a page.

// Safari: pinch on a touch screen or trackpad.
document.addEventListener('gesturestart', (event) => event.preventDefault());

// Other browsers: a trackpad pinch and Ctrl/Cmd + wheel both arrive as a
// wheel event with the modifier key set. Plain scrolling is not affected.
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  },
  { passive: false }
);

// Ctrl/Cmd with +, - or 0.
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) {
    event.preventDefault();
  }
});

// Timers are throttled in background tabs, so catch up the moment we are back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

load();
