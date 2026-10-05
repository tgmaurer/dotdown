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
const HOME_KEY = 'dwindle:home'; // home screen only: { link in the icon: latest link }

const VERSION = 1;
const MAX_NAME = 60;
const MAX_GOAL = 120;
const MAX_GOALS = 20;
const MAX_DOTS = 730; // beyond this, one dot stands for several days
const DAY_MS = 86400000;

const $ = (id) => document.getElementById(id);

let state = null; // the current countdown { v, t, d, c, g }, or null
let timer = 0; // id of the pending tick
let shownDay = ''; // the day the dot grid was last drawn for
let backTo = ''; // encoded countdown the create form can return to
let iconLink = null; // home screen only: the link the icon was made from
let pendingHint = ''; // hint text waiting for the editor to close
let dragged = null; // the goal row being dragged to a new place

// ---------- Dates ----------
// Dates are plain "YYYY-MM-DD" strings. They only become Date objects at the
// last moment, and never by adding milliseconds to another date (DST).

const pad2 = (n) => String(n).padStart(2, '0');

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

function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// The moment a countdown was created: "YYYY-MM-DDTHH:MM", local time, to the
// minute. A plain date is accepted too and read as midnight.
// Returns { day, minutes (after midnight), hasTime }, or null if unreadable.
function parseCreated(text) {
  const match = typeof text === 'string' && /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text);
  if (!match || !parseDate(match[1])) return null;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  if (hours > 23 || minutes > 59) return null;
  return { day: match[1], minutes: hours * 60 + minutes, hasTime: match[2] !== undefined };
}

function nowStamp() {
  const now = new Date();
  return `${todayISO(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
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
  if (!parseDate(payload.d) || !parseCreated(payload.c)) throw new Error('Bad date');
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

// Edits replace the current history entry, so Back does not step through
// every change. Starting a new countdown is the one exception: pass `from`
// (the countdown being left) and a new entry is added, so Back returns to it.
// That entry's state { create: true, from } marks the create form, so going
// back or forward to it shows the form again instead of the last countdown.
function writeState(encoded, from = '') {
  let url = location.pathname;
  if (encoded) url += STATE_MODE === 'query' ? `?${QUERY_KEY}=${encoded}` : `#${encoded}`;
  try {
    if (from) history.pushState({ create: true, from }, '', url);
    else history.replaceState(null, '', url);
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

// Returns whether it worked. The URL holds the state either way.
function saveLast(encoded) {
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
    return true;
  } catch (err) {
    return false;
  }
}

// ---------- Home screen ----------
// A page opened from a home screen icon has no address bar and no browser
// menu, and the icon keeps opening the link it was made from: it cannot be
// updated or re-added from in here. So edits made in this mode are remembered
// against the icon's link, and the next launch carries on from the latest one.

function isHomeScreen() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

function readHomeEdits() {
  try {
    const edits = JSON.parse(localStorage.getItem(HOME_KEY));
    return edits && typeof edits === 'object' ? edits : {};
  } catch (err) {
    return {};
  }
}

// Returns whether it worked.
function saveHomeEdit(encoded) {
  try {
    const edits = readHomeEdits();
    edits[iconLink] = encoded;
    localStorage.setItem(HOME_KEY, JSON.stringify(edits));
    return true;
  } catch (err) {
    return false;
  }
}

// ---------- Rendering ----------

// The interface is English, so the date is too. en-GB reads day-month-year
// with a 24-hour clock ("Sun, 14 Mar 2027, 00:00"), which is hard to misread.
// Pass undefined instead to follow each visitor's own locale.
const dateTimeOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', dateTimeOptions);

// The target also names the visitor's time zone as an offset ("GMT+2"):
// short enough to stay on one line on a phone, and the same style everywhere.
// It is the offset on the target date, so across a daylight saving change it
// can differ from today's. Browsers without 'shortOffset' (Safari before 15.4)
// fall back to their usual short name.
function zoneFormat(timeZoneName) {
  return new Intl.DateTimeFormat('en-GB', { ...dateTimeOptions, timeZoneName });
}
let targetFormat;
try {
  targetFormat = zoneFormat('shortOffset');
} catch {
  targetFormat = zoneFormat('short');
}

// For a start that is only a date (a link without a creation time).
const startFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

// Draws everything for the current state, then starts the clock.
function render() {
  document.title = state.t;
  $('corner').hidden = true; // under "More" instead
  $('intro').hidden = true;
  $('notice').hidden = true;
  $('view').hidden = false;
  $('name').textContent = state.t;
  const created = parseCreated(state.c);
  const { y, m, d } = parseDate(created.day);
  $('start').textContent = (created.hasTime ? dateTimeFormat : startFormat).format(
    new Date(y, m - 1, d, 0, created.minutes)
  );
  $('target').textContent = targetFormat.format(localMidnight(state.d));

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

// Seconds until the target, counted the way a wall clock is read: the whole
// calendar days after today, plus the time left until midnight tonight.
// Splitting the real elapsed time instead would be an hour out whenever the
// clocks change between now and the target (a 25-hour or a 23-hour day):
// at 4 pm it would say "9 hours" to midnight instead of 8.
function clockSecondsLeft(now, today) {
  const sinceMidnight =
    ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  const tonight = Math.floor((DAY_MS - sinceMidnight) / 1000);
  const daysAfterToday = daysBetween(today, state.d) - 1;
  return Math.max(0, daysAfterToday * 86400 + tonight);
}

// Calendar days from the creation day to the target day, at least 1.
function spanDays() {
  return Math.max(1, daysBetween(parseCreated(state.c).day, state.d));
}

// How near the end is: '' (normal), 'close' or 'final'.
// final: the last tenth of the span, at most 7 days, at least the last day.
// close: the last quarter of the span, at most 30 days.
// A 180-day countdown is 'close' for its last 30 days and 'final' for its
// last 7; a 30-day one for its last 8 and 3. A very short countdown has no
// 'close' stage, because 'final' already covers it.
function stage(today) {
  const span = spanDays();
  const left = daysBetween(today, state.d);
  if (left <= Math.min(7, Math.max(1, Math.round(span / 10)))) return 'final';
  if (left <= Math.min(30, Math.round(span / 4))) return 'close';
  return '';
}

// Seconds from the minute the countdown was created to the target, by the clock.
function spanSeconds() {
  const created = parseCreated(state.c);
  return daysBetween(created.day, state.d) * 86400 - created.minutes * 60;
}

// How much of the span is gone, from 0 to 1.
function shareGone(secondsLeft) {
  const total = spanSeconds();
  if (total <= 0) return 0; // created at or after the target
  return Math.min(1, Math.max(0, (total - secondsLeft) / total));
}

// "34% gone". Rounded down, so it reads 100 only once the target is reached.
// Under 1% reads "<1%" once anything is gone, so a long countdown does not
// sit at "0%" for its first days.
function percentText(share) {
  const percent = Math.min(99, Math.floor(share * 100));
  return percent === 0 && share > 0 ? '<1% gone' : `${percent}% gone`;
}

// Marks in the span. Three quarters is left out: the "Getting close" tag
// marks about the same moment.
const MILESTONES = [
  [1 / 4, 'a quarter'],
  [1 / 3, 'a third'],
  [1 / 2, 'half'],
  [2 / 3, 'two thirds'],
];

// Around each mark the caption names it: while the percentage reads one
// below, at or one above it (24, 25 and 26% for a quarter). On a long
// countdown, where that would last more than 3 days, for 3 days centred on
// the mark.
function milestone(share) {
  const total = spanSeconds();
  if (total <= 0) return '';
  const cap = (1.5 * 86400) / total; // 1.5 days, as a share of the span
  for (const [at, text] of MILESTONES) {
    const percent = Math.floor(at * 100) / 100; // as the caption shows it
    const from = Math.max(percent - 0.01, at - cap);
    const to = Math.min(percent + 0.02, at + cap);
    if (share >= from && share < to) return text;
  }
  return '';
}

// Runs about once a second. Everything is derived from the clock on each run
// (never from a counter), so a tab that slept in the background cannot drift.
function tick() {
  clearTimeout(timer);
  if (!state) return;

  const now = new Date();
  const target = localMidnight(state.d);
  const passed = now.getTime() >= target.getTime(); // the real moment, exactly
  const today = todayISO(now);

  // The dot grid only changes when the calendar day does.
  if (today !== shownDay) {
    shownDay = today;
    renderDots(today);
  }

  $('ticker').hidden = passed;
  $('passed').hidden = !passed;
  $('target-label').textContent = passed ? 'ended' : 'until';

  if (passed) {
    $('percent').textContent = '100% gone';
    $('milestone').textContent = '';
    const ago = daysBetween(state.d, today);
    $('passed').textContent =
      ago < 1 ? 'Today is the day.' : `Deadline passed ${ago} ${ago === 1 ? 'day' : 'days'} ago`;
    return; // nothing left to count, so stop ticking
  }

  const phase = stage(today);
  $('ticker').classList.toggle('urgent', phase === 'final');
  $('soon').hidden = !phase;
  $('soon').classList.toggle('close', phase === 'close');
  $('soon').textContent = phase === 'close' ? 'Getting close' : 'Time is almost up';

  const seconds = clockSecondsLeft(now, today);
  const share = shareGone(seconds);
  $('percent').textContent = percentText(share);
  const mark = milestone(share);
  $('milestone').textContent = mark ? `· ${mark}` : '';
  const days = Math.floor(seconds / 86400);
  $('t-days').textContent = days;
  $('t-days').classList.toggle('long', days > 99999);
  $('t-days-label').textContent = days === 1 ? 'day' : 'days';
  $('t-hours').textContent = pad2(Math.floor(seconds / 3600) % 24);
  $('t-minutes').textContent = pad2(Math.floor(seconds / 60) % 60);
  $('t-seconds').textContent = pad2(seconds % 60);

  // Wake up just after the clock reaches its next whole second.
  timer = setTimeout(tick, ((1000 - now.getMilliseconds()) % 1000) + 20);
}

// One dot per calendar day from the creation date up to the target date.
function renderDots(today) {
  const total = spanDays();
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
  input.name = 'goal';
  input.maxLength = MAX_GOAL;
  input.autocomplete = 'off';
  input.placeholder = 'Book flights';
  input.setAttribute('aria-label', 'Goal');
  input.value = text;
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'grip';
  grip.setAttribute('aria-label', 'Move goal: drag, or use the up and down arrow keys');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove goal');
  row.append(grip, input, remove);
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
  // The creation time is set once, when the countdown is made, and then kept.
  const created = state ? state.c : nowStamp();
  return { v: VERSION, t: name, d: dateInput.value, c: created, g: goals };
}

// The one path every change takes: URL, storage, screen, hint.
// created: true for a brand-new countdown, false for an edit.
function commit(next, created) {
  const encoded = encode(next);
  writeState(encoded);
  let saved = saveLast(encoded);
  if (iconLink) saved = saveHomeEdit(encoded);
  state = next;
  render();
  // While the editor is open the hint waits. It appears at the bottom of the
  // screen, right where the Done button can be, and popping up between the
  // press and the release of a click would swallow that click.
  pendingHint = hintText(created, saved);
  if (editor.hidden) showPendingHint();
}

// Saves the form while editing, if it is valid and something really changed.
function saveEdits() {
  const next = formToState();
  if (next && encode(next) !== encode(state)) commit(next, false);
}

function openEditor() {
  fillForm(state);
  editor.hidden = false;
  $('edit-toggle').textContent = 'Close';
  $('edit-toggle').setAttribute('aria-expanded', 'true');
  // The form opens below the countdown, often out of sight on a phone.
  editor.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}

function closeEditor() {
  window.scrollTo({ top: 0 });
  editor.hidden = true;
  $('edit-toggle').textContent = 'Edit';
  $('edit-toggle').setAttribute('aria-expanded', 'false');
  showPendingHint();
}

// ---------- The two screens ----------

function showCountdown(next) {
  state = next;
  pendingHint = ''; // a different link is being shown, the old hint is stale
  closeEditor();
  render();
}

// message: optional friendly note. fallback: encoded countdown to offer a way
// back to (defaults to the last saved one).
function showCreate(message, fallback) {
  clearTimeout(timer);
  state = null;
  pendingHint = '';
  document.title = 'Dwindle';
  $('view').hidden = true;
  $('corner').hidden = false;
  setMenu(false);
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
  let encoded = readState();

  // First load from a home screen icon: note the icon's link, and if the
  // countdown has been changed in here since, show the latest version.
  if (iconLink === null && isHomeScreen()) {
    iconLink = encoded;
    const latest = readHomeEdits()[iconLink];
    if (tryDecode(latest)) {
      encoded = latest;
      writeState(latest);
    }
  }

  if (encoded) {
    const decoded = tryDecode(encoded);
    if (decoded) showCountdown(decoded);
    else showCreate('This link is damaged or from a newer version, so it can’t be read. You can start a new countdown below.');
    return;
  }
  // Back or Forward to a create form: show the form, not the last countdown.
  if (history.state && history.state.create) {
    showCreate('', history.state.from);
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

// Where the page is running, which decides how a link is best kept.
function device() {
  if (isHomeScreen()) return 'home-screen';
  // Phones and tablets: touch is the main input and nothing can hover.
  if (!matchMedia('(hover: none) and (pointer: coarse)').matches) return 'desktop';
  // An iPad calls itself a Mac, so a "Mac" with a touch screen counts too.
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return apple ? 'apple-touch' : 'touch';
}

// A browser cannot update a bookmark or a home screen icon, so after every
// change the hint says how to keep the new link on this kind of device.
// created: a new countdown rather than an edit. saved: storage worked.
function hintText(created, saved) {
  const start = created ? 'Link created.' : 'Link updated.';
  const bookmark = created ? 'Bookmark it' : 'Re-bookmark it';
  const again = created ? '' : ' again';
  switch (device()) {
    case 'home-screen':
      // Here the app itself keeps the change (see "Home screen" above).
      if (saved) return `${start} This icon now opens this ${created ? 'countdown' : 'version'}.`;
      return `${start} Copy it to keep this ${created ? 'countdown' : 'version'}.`;
    case 'apple-touch':
      return `${start} ${bookmark}, or Share then Add to Home Screen${again}, to keep it.`;
    case 'touch':
      return `${start} ${bookmark}, or browser menu then Add to Home screen${again}, to keep it.`;
    default:
      return created
        ? 'Link created. Bookmark it to keep this countdown.'
        : 'Link updated. Re-bookmark to keep this version.';
  }
}

function showPendingHint() {
  if (!pendingHint) return;
  showHint(pendingHint);
  pendingHint = '';
}

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
  else commit(formToState(), true);
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

// ---------- Reordering goals ----------
// A goal is dragged by its grip, with mouse, finger or pen (Pointer Events).
// The dragged row itself never moves in the page: its neighbours are moved
// around it. That keeps the pointer attached to the grip for the whole drag.

const middle = (row) => {
  const box = row.getBoundingClientRect();
  return box.top + box.height / 2;
};

goalRows.addEventListener('pointerdown', (event) => {
  const grip = event.target.closest('.grip');
  if (!grip || dragged) return;
  // Leave any field being typed in first, so its text is saved before rows move.
  if (editor.contains(document.activeElement)) document.activeElement.blur();
  dragged = grip.parentElement;
  dragged.classList.add('dragging');
  grip.setPointerCapture(event.pointerId);
});

goalRows.addEventListener('pointermove', (event) => {
  if (!dragged) return;
  // Swap places with a neighbour once the pointer has passed its middle.
  let above = dragged.previousElementSibling;
  while (above && event.clientY < middle(above)) {
    dragged.after(above);
    above = dragged.previousElementSibling;
  }
  let below = dragged.nextElementSibling;
  while (below && event.clientY > middle(below)) {
    dragged.before(below);
    below = dragged.nextElementSibling;
  }
  // Near the top or bottom edge of the screen, scroll, but only while more
  // of the list lies beyond that edge. Lets a long list be crossed in one go.
  const list = goalRows.getBoundingClientRect();
  if (event.clientY < 48 && list.top < 0) scrollBy(0, -12);
  else if (event.clientY > innerHeight - 48 && list.bottom > innerHeight) scrollBy(0, 12);
});

function endDrag() {
  if (!dragged) return;
  dragged.classList.remove('dragging');
  dragged = null;
  if (state) saveEdits();
}

goalRows.addEventListener('pointerup', endDrag);
goalRows.addEventListener('pointercancel', endDrag);

// Keyboard: with the grip focused, the arrow keys move the goal up or down.
goalRows.addEventListener('keydown', (event) => {
  if (!event.target.classList.contains('grip')) return;
  const row = event.target.parentElement;
  const other = event.key === 'ArrowUp' ? row.previousElementSibling
    : event.key === 'ArrowDown' ? row.nextElementSibling
    : null;
  if (!other) return;
  event.preventDefault();
  if (event.key === 'ArrowUp') row.after(other);
  else row.before(other);
  if (state) saveEdits();
});

$('edit-toggle').addEventListener('click', () => {
  if (editor.hidden) openEditor();
  else closeEditor();
});

// Starting over only clears the URL. Storage keeps the old countdown until a
// new one is actually created, so "Back to ..." (or a reload) undoes this.
function startNew() {
  const current = encode(state);
  writeState('', current); // a new history entry: Back returns to this countdown
  showCreate('', current);
  nameInput.focus();
}

$('f-new').addEventListener('click', startNew);
$('new-top').addEventListener('click', startNew);

$('f-back').addEventListener('click', () => {
  // Came here with "New countdown": step back in history, as Back would.
  if (history.state && history.state.create) {
    history.back();
    return;
  }
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

// ---------- More menu ----------
// On a countdown, the corner links live behind "More". They are copied from
// #corner, so each link is written once in index.html.

const moreMenu = $('more-menu');
moreMenu.append(...[...$('corner').querySelectorAll('a')].map((link) => link.cloneNode(true)));

function setMenu(open) {
  moreMenu.hidden = !open;
  $('more-toggle').setAttribute('aria-expanded', String(open));
}

$('more-toggle').addEventListener('click', () => setMenu(moreMenu.hidden));

// Closes on a link (it opens in a new tab), a click anywhere else, or Escape.
document.addEventListener('click', (event) => {
  if (!moreMenu.hidden && (event.target.closest('#more-menu a') || !event.target.closest('.more'))) {
    setMenu(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !moreMenu.hidden) {
    setMenu(false);
    $('more-toggle').focus();
  }
});

// The placeholder links point at "#TODO". Following one would overwrite the
// hash, which is the countdown itself, so swallow those clicks.
document.addEventListener('click', (event) => {
  if (event.target.closest('a[href="#TODO"]')) event.preventDefault();
});

// A link pasted or edited by hand in the address bar.
window.addEventListener('hashchange', load);

// Back and Forward between a countdown and a create form opened from it.
window.addEventListener('popstate', load);

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

// Keep the app's files on the device for fast, offline launches (see sw.js).
// Not available on file:// or plain http other than localhost; that is fine.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load();
