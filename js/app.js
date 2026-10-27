import * as db from './db.js';
import * as ai from './ai.js';
import {
  MEAL_TYPES, mealType, today, addDays, weekStart, nowTime, fmtDay, weekStats, mealLines, calorieTarget,
} from './stats.js';

const APP_VERSION = '1.0.2';
const BACKUP_REMINDER_DAYS = 14;

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { tab: 'today', date: today(), week: weekStart(today()), chat: [], estimating: new Set() };

// ---------- small helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Very small markdown subset for AI replies: headings, bullets, bold, paragraphs.
function md(text) {
  const out = [];
  let list = false;
  for (const raw of esc(text).split('\n')) {
    const line = raw.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const bullet = line.match(/^[-*•]\s+(.*)/);
    if (bullet) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    if (list) out.push('</ul>');
    list = false;
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) out.push(`<h3>${h[1]}</h3>`);
    else if (line) out.push(`<p>${line}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

async function resizeImage(file, max = 640, quality = 0.75) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function requestPersistence() {
  if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
}

// ---------- AI estimation ----------

async function estimate(meal, { quiet = false } = {}) {
  if (meal.skipped || state.estimating.has(meal.id)) return;
  state.estimating.add(meal.id);
  render();
  try {
    meal.estimate = await ai.estimateMeal({ ...meal, mealType: mealType(meal.mealType).label });
    delete meal.estimateError;
    if (!meal.text) meal.text = meal.estimate.description;
    await db.put('meals', meal);
    if (meal.saveFavorite) {
      await saveFavorite(meal);
      delete meal.saveFavorite;
      await db.put('meals', meal);
    }
    if (!quiet && meal.estimate.tip) toast('💡 ' + meal.estimate.tip, 6000);
  } catch (err) {
    meal.estimateError = err.message;
    await db.put('meals', meal);
    if (!quiet) toast(err.message, 6000);
  } finally {
    state.estimating.delete(meal.id);
    render();
  }
}

async function estimatePending() {
  if (!navigator.onLine || !(await db.setting('apiKey'))) return;
  const meals = (await db.all('meals')).filter((m) => !m.skipped && !m.estimate);
  for (const m of meals) await estimate(m, { quiet: true });
}

async function saveFavorite(meal) {
  const favs = await db.all('favorites');
  const existing = favs.find((f) => f.text.toLowerCase() === meal.text.toLowerCase() && f.size === meal.size);
  await db.put('favorites', {
    id: existing?.id || db.uid(),
    text: meal.text,
    size: meal.size,
    portion: meal.portion,
    estimate: meal.estimate,
    uses: existing?.uses || 0,
  });
}

// ---------- meal dialog ----------

const dialog = $('#meal-dialog');
const form = $('#meal-form');
let editing = null; // meal being edited, or null for a new one
let photoData = null;
let favEstimate = null; // estimate copied from a quick-pick, so no AI call is needed

$('#f-mealType').innerHTML = MEAL_TYPES.map((t) => `<option value="${t.id}">${t.icon} ${t.label}</option>`).join('');

async function openMealDialog({ meal = null, type = 'breakfast' } = {}) {
  editing = meal;
  photoData = meal?.photo || null;
  favEstimate = null;
  $('#meal-dialog-title').textContent = meal ? 'Edit meal' : 'Add meal';
  form.mealType.value = meal?.mealType || type;
  form.text.value = meal?.text || '';
  form.portion.value = meal?.portion || '';
  form.size.value = meal?.size || 'regular';
  form.time.value = meal?.time || (state.date === today() ? nowTime() : mealType(type).time);
  $('#f-fav').checked = false;
  $('#f-delete').hidden = !meal;
  showPhoto();

  const favs = (await db.all('favorites')).sort((a, b) => b.uses - a.uses).slice(0, 12);
  $('#fav-chips').innerHTML = favs.length
    ? favs.map((f) => `<button type="button" class="chip" data-fav="${f.id}">⭐ ${esc(f.text)}</button>`).join('')
    : '';
  $('#fav-chips').onclick = async (e) => {
    const id = e.target.closest('[data-fav]')?.dataset.fav;
    if (!id) return;
    const fav = await db.get('favorites', id);
    form.text.value = fav.text;
    form.size.value = fav.size || 'regular';
    form.portion.value = fav.portion || '';
    favEstimate = fav.estimate;
    fav.uses += 1;
    await db.put('favorites', fav);
  };
  dialog.showModal();
}

function showPhoto() {
  const img = $('#f-photo-preview');
  img.hidden = !photoData;
  $('#f-photo-clear').hidden = !photoData;
  if (photoData) img.src = photoData;
}

$('#f-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    photoData = await resizeImage(file);
    favEstimate = null;
    showPhoto();
  } catch {
    toast('Could not read that photo.');
  }
});
$('#f-photo-clear').addEventListener('click', () => {
  photoData = null;
  showPhoto();
});
dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
// Typing something different from the quick-pick means we need a fresh estimate.
form.text.addEventListener('input', () => (favEstimate = null));
form.portion.addEventListener('input', () => (favEstimate = null));
form.addEventListener('change', (e) => {
  if (e.target.name === 'size') favEstimate = null;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = form.text.value.trim();
  if (!text && !photoData) {
    toast('Type what you ate or add a photo.');
    return;
  }
  const meal = editing ? { ...editing } : { id: db.uid(), date: state.date, createdAt: Date.now() };
  const changed = !editing || editing.text !== text || editing.portion !== form.portion.value.trim()
    || editing.size !== form.size.value || editing.photo !== photoData;
  Object.assign(meal, {
    mealType: form.mealType.value,
    text,
    portion: form.portion.value.trim(),
    size: form.size.value,
    time: form.time.value,
    photo: photoData,
    skipped: false,
  });
  if (favEstimate) meal.estimate = favEstimate;
  else if (changed) delete meal.estimate;
  if ($('#f-fav').checked) meal.saveFavorite = true;
  await db.put('meals', meal);
  // Logging food for a meal replaces an earlier "Skipped" mark.
  const sameMeal = await db.mealsBetween(meal.date, meal.date);
  for (const m of sameMeal) if (m.skipped && m.mealType === meal.mealType) await db.del('meals', m.id);
  dialog.close();
  requestPersistence();
  render();
  if (!meal.estimate) estimate(meal);
  else if (meal.saveFavorite) {
    await saveFavorite(meal);
    delete meal.saveFavorite;
    await db.put('meals', meal);
  }
});

$('#f-delete').addEventListener('click', async () => {
  if (!editing || !confirm('Delete this meal?')) return;
  await db.del('meals', editing.id);
  dialog.close();
  render();
});

// ---------- views ----------

function flagChips(e) {
  return [
    e.hasVeg && '<span class="tag good">🥬 gulay</span>',
    e.hasFruit && '<span class="tag good">🍎 prutas</span>',
    e.fried && '<span class="tag warn">🍳 prito</span>',
    e.sugaryDrink && '<span class="tag warn">🥤 matamis na inumin</span>',
    e.sweet && '<span class="tag warn">🍰 sweets</span>',
    e.processed && '<span class="tag warn">🌭 processed</span>',
  ].filter(Boolean).join('');
}

function plateBar(p) {
  if (!p) return '';
  const total = p.go + p.grow + p.glow || 1;
  const w = (n) => ((100 * n) / total).toFixed(0);
  return `<div class="plate" role="img" aria-label="Plate: Go ${w(p.go)}%, Grow ${w(p.grow)}%, Glow ${w(p.glow)}%">
    <span class="go" style="width:${w(p.go)}%"></span><span class="grow" style="width:${w(p.grow)}%"></span><span class="glow" style="width:${w(p.glow)}%"></span>
  </div>`;
}

function mealCard(m) {
  if (m.skipped) {
    return `<div class="meal skipped"><span>Skipped</span><button class="link-btn" data-unskip="${m.id}">Undo</button></div>`;
  }
  const e = m.estimate;
  let body;
  if (state.estimating.has(m.id)) body = '<p class="muted">⏳ Estimating…</p>';
  else if (e) {
    body = `<div class="meal-meta"><strong>~${e.calories} kcal</strong>${e.confidence === 'low' ? ' <span class="muted">(rough guess)</span>' : ''}</div>
      ${plateBar(e.plate)}<div class="tags">${flagChips(e)}</div>
      ${e.tip ? `<p class="tip">💡 ${esc(e.tip)}</p>` : ''}`;
  } else {
    body = `<p class="muted">${m.estimateError ? '⚠️ ' + esc(m.estimateError) : 'Not estimated yet.'}</p>
      <button class="link-btn" data-estimate="${m.id}">Estimate now</button>`;
  }
  return `<div class="meal" data-edit="${m.id}">
    ${m.photo ? `<img class="thumb" src="${m.photo}" alt="">` : ''}
    <div class="meal-body">
      <div class="meal-title"><span>${esc(m.text || e?.description || 'Photo meal')}</span><span class="muted">${esc(m.time || '')}</span></div>
      ${m.portion || m.size !== 'regular' ? `<div class="muted small">${esc([m.size !== 'regular' && m.size, m.portion].filter(Boolean).join(' · '))}</div>` : ''}
      ${body}
    </div>
  </div>`;
}

async function renderToday() {
  const meals = await db.mealsBetween(state.date, state.date);
  const eaten = meals.filter((m) => !m.skipped && m.estimate);
  const kcal = eaten.reduce((s, m) => s + (m.estimate.calories || 0), 0);
  const target = calorieTarget(await db.setting('profile'));
  const isToday = state.date === today();

  const sections = MEAL_TYPES.map((t) => {
    const rows = meals.filter((m) => m.mealType === t.id);
    const actions = rows.length
      ? `<button class="link-btn" data-add="${t.id}">+ Add more</button>`
      : `<button class="btn small" data-add="${t.id}">+ Add</button>${t.main ? `<button class="btn small ghost" data-skip="${t.id}">Skipped</button>` : ''}`;
    return `<section class="meal-section">
      <div class="section-head"><h2>${t.icon} ${t.label}</h2><div class="actions">${actions}</div></div>
      ${rows.map(mealCard).join('')}
    </section>`;
  }).join('');

  view.innerHTML = `
    <div class="date-nav">
      <button class="icon-btn" data-day="-1" aria-label="Previous day">‹</button>
      <div class="date-label"><strong>${isToday ? 'Today' : fmtDay(state.date, { weekday: 'long' })}</strong><span class="muted">${fmtDay(state.date, { month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
      <button class="icon-btn" data-day="1" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    ${!isToday ? '<button class="link-btn center" data-day="0">Back to today</button>' : ''}
    <div class="card day-summary">
      <div><span class="muted small">Estimated today</span><div class="big">${kcal ? '~' + kcal.toLocaleString() : '—'} <small>kcal</small></div></div>
      <div class="muted small">${target ? `Rough need: ~${target.toLocaleString()} kcal` : 'Add your profile in Settings for a rough daily need.'}</div>
    </div>
    ${sections}`;
}

async function renderWeek() {
  const end = addDays(state.week, 6);
  const meals = await db.mealsBetween(state.week, end);
  const profile = await db.setting('profile');
  const s = weekStats(meals, state.week, profile);
  const review = await db.get('reviews', state.week);
  const thisWeek = state.week === weekStart(today());

  const cell = (v) => ({ logged: '<span class="dot logged" title="Logged">●</span>', skipped: '<span class="dot skipped" title="Skipped">✕</span>', none: '<span class="dot none" title="Not logged">○</span>' })[v];
  const grid = `<table class="grid">
    <thead><tr><th></th>${s.days.map((d) => `<th>${fmtDay(d, { weekday: 'narrow' })}</th>`).join('')}</tr></thead>
    <tbody>${MEAL_TYPES.map((t, i) => `<tr><th>${t.icon}</th>${s.grid.map((row) => `<td>${cell(row[i])}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>
  <p class="legend small muted"><span>● logged</span><span>✕ skipped</span><span>○ not logged</span></p>`;

  const bar = (label, value, target, note) => `<div class="bar-row">
    <div class="bar-label"><span>${label}</span><strong>${value == null ? '—' : value + '%'}</strong></div>
    <div class="bar"><span style="width:${value || 0}%"></span>${target != null ? `<i style="left:${target}%" title="Target ${target}%"></i>` : ''}</div>
    <div class="muted small">${note}</div>
  </div>`;

  const habit = (icon, label, n) => `<li><span>${icon} ${label}</span><strong>${n}×</strong></li>`;

  view.innerHTML = `
    <div class="date-nav">
      <button class="icon-btn" data-week="-1" aria-label="Previous week">‹</button>
      <div class="date-label"><strong>${thisWeek ? 'This week' : 'Week of ' + fmtDay(state.week, { month: 'short', day: 'numeric' })}</strong><span class="muted">${fmtDay(state.week, { month: 'short', day: 'numeric' })} – ${fmtDay(end, { month: 'short', day: 'numeric' })}</span></div>
      <button class="icon-btn" data-week="1" aria-label="Next week" ${thisWeek ? 'disabled' : ''}>›</button>
    </div>

    <div class="tiles">
      <div class="tile"><span class="muted small">Main meals logged</span><div class="big">${s.mainLogged}<small>/${s.mainPossible}</small></div></div>
      <div class="tile"><span class="muted small">Skipped meals</span><div class="big">${s.mainSkipped}</div></div>
      <div class="tile"><span class="muted small">Avg per day</span><div class="big">${s.avgCalories ? '~' + s.avgCalories.toLocaleString() : '—'}<small> kcal</small></div><span class="muted small">${s.target ? 'need ~' + s.target.toLocaleString() : ''}${s.calorieDays ? ` · ${s.calorieDays} full day${s.calorieDays > 1 ? 's' : ''}` : ''}</span></div>
      <div class="tile"><span class="muted small">Days with fruit</span><div class="big">${s.fruitDays}<small>/7</small></div></div>
    </div>
    ${s.pending ? `<p class="muted small">⏳ ${s.pending} meal(s) not estimated yet. <button class="link-btn" data-estimate-all>Estimate now</button></p>` : ''}

    <section class="card">
      <h2>Your plate vs Pinggang Pinoy</h2>
      <p class="muted small">Average share of your main meals. The line marks the guide's target.</p>
      ${bar('🥬 Glow (gulay at prutas)', s.plate?.glow, 50, 'Target: half the plate')}
      ${bar('🍚 Go (kanin, tinapay, pansit)', s.plate?.go, 25, 'Target: a quarter')}
      ${bar('🍗 Grow (isda, karne, itlog, tokwa)', s.plate?.grow, 25, 'Target: a quarter')}
      ${bar('Main meals with gulay', s.vegPct, null, '')}
    </section>

    <section class="card">
      <h2>Habits this week</h2>
      <ul class="habits">
        ${habit('🍳', 'Fried food', s.fried)}
        ${habit('🥤', 'Sugary drinks', s.sugaryDrink)}
        ${habit('🍰', 'Sweets', s.sweet)}
        ${habit('🌭', 'Processed food', s.processed)}
      </ul>
    </section>

    <section class="card">
      <h2>Meals logged</h2>
      ${grid}
    </section>

    <section class="card review">
      <div class="section-head"><h2>🤖 Coach review</h2>
        ${s.logged ? `<button class="btn small" data-review>${review ? 'Regenerate' : 'Generate'}</button>` : ''}</div>
      <div id="review-body">${review ? md(review.text) + `<p class="muted small">Generated ${new Date(review.createdAt).toLocaleString('en-PH')}</p>` : `<p class="muted">${s.logged ? 'Tap Generate for a Taglish review of your week.' : 'Log some meals first.'}</p>`}</div>
    </section>`;
}

const SUGGESTIONS = [
  'Ano pwede kong ulam mamayang dinner?',
  'Kulang ba ako sa gulay this week?',
  'Healthy merienda ideas na mura',
  'Paano ko mababawasan ang kanin?',
];

async function renderAsk() {
  if (!state.chat.length) state.chat = (await db.setting('chat')) || [];
  const thinking = state.chatBusy ? '<div class="bubble model muted">⏳ Nag-iisip…</div>' : '';
  view.innerHTML = `
    <div class="chat" id="chat">
      ${state.chat.length ? '' : `<div class="card"><p>Kumusta! Ask me anything about your meals. I can see your log for the last 14 days.</p></div>`}
      ${state.chat.map((m) => `<div class="bubble ${m.role}">${m.role === 'model' ? md(m.text) : esc(m.text)}</div>`).join('')}
      ${thinking}
    </div>
    <div class="chips">${SUGGESTIONS.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <form class="chat-form" id="chat-form">
      <input name="q" placeholder="Type your question…" autocomplete="off" ${state.chatBusy ? 'disabled' : ''}>
      <button class="btn primary" ${state.chatBusy ? 'disabled' : ''}>Send</button>
    </form>
    ${state.chat.length ? '<button class="link-btn center" data-clear-chat>Clear chat</button>' : ''}`;
  $('#chat').lastElementChild?.scrollIntoView({ block: 'end' });
}

async function ask(q) {
  q = q.trim();
  if (!q || state.chatBusy) return;
  state.chat.push({ role: 'user', text: q });
  state.chatBusy = true;
  render();
  try {
    const from = addDays(today(), -13);
    const meals = await db.mealsBetween(from, today());
    const reply = await ai.chat({ profile: await db.setting('profile'), context: mealLines(meals), history: state.chat.slice(-12) });
    state.chat.push({ role: 'model', text: reply });
  } catch (err) {
    state.chat.pop();
    toast(err.message, 6000);
  }
  state.chatBusy = false;
  await db.saveSetting('chat', state.chat.slice(-40));
  render();
}

async function renderSettings() {
  const p = (await db.setting('profile')) || {};
  const key = (await db.setting('apiKey')) || '';
  const model = (await db.setting('model')) || ai.DEFAULT_MODEL;
  const models = (await db.setting('models')) || [];
  const lastBackup = await db.setting('lastBackup');
  const favs = await db.all('favorites');
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  const target = calorieTarget(p);
  const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  const modelList = [...new Set([model, ...models])];

  view.innerHTML = `
    <section class="card">
      <h2>👤 Profile</h2>
      <form id="profile-form" class="form-grid">
        <label class="field"><span>Name (optional)</span><input name="name" value="${esc(p.name)}"></label>
        <label class="field"><span>Age</span><input name="age" type="number" inputmode="numeric" min="10" max="100" value="${esc(p.age)}"></label>
        <label class="field"><span>Sex (for calorie formula)</span><select name="sex">${opt('', '—', p.sex || '')}${opt('female', 'Female', p.sex)}${opt('male', 'Male', p.sex)}</select></label>
        <label class="field"><span>Height (cm)</span><input name="height" type="number" inputmode="decimal" value="${esc(p.height)}"></label>
        <label class="field"><span>Weight (kg)</span><input name="weight" type="number" inputmode="decimal" step="0.1" value="${esc(p.weight)}"></label>
        <label class="field"><span>Activity</span><select name="activity">
          ${opt('sedentary', 'Mostly sitting', p.activity)}${opt('light', 'Light (walks, 1–3 workouts/wk)', p.activity || 'light')}
          ${opt('moderate', 'Moderate (3–5 workouts/wk)', p.activity)}${opt('active', 'Very active', p.activity)}</select></label>
        <label class="field wide"><span>Notes for the coach (allergies, dislikes, budget…)</span><textarea name="notes" rows="2">${esc(p.notes)}</textarea></label>
        <p class="muted small wide">${target ? `Rough daily need: ~${target.toLocaleString()} kcal (estimate only).` : 'Fill in age, sex, height and weight to see a rough daily calorie need.'}</p>
        <button class="btn primary wide">Save profile</button>
      </form>
    </section>

    <section class="card">
      <h2>🤖 AI (Google Gemini)</h2>
      <p class="muted small">Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. It is stored only on this phone.</p>
      <label class="field"><span>API key</span>
        <div class="row"><input id="api-key" type="password" autocomplete="off" value="${esc(key)}" placeholder="AIza…"><button type="button" class="btn small ghost" id="toggle-key">Show</button></div>
      </label>
      <label class="field"><span>Model</span>
        <div class="row"><select id="model">${modelList.map((m) => opt(m, m, model)).join('')}</select><button type="button" class="btn small ghost" id="load-models">Load list</button></div>
      </label>
      <div class="row"><button class="btn primary" id="save-ai">Save</button><button class="btn secondary" id="test-ai">Test</button></div>
    </section>

    <section class="card">
      <h2>⭐ Quick-picks</h2>
      ${favs.length ? `<ul class="fav-list">${favs.map((f) => `<li><span>${esc(f.text)} <span class="muted small">${f.estimate ? '~' + f.estimate.calories + ' kcal' : ''}</span></span><button class="icon-btn" data-del-fav="${f.id}" aria-label="Remove">✕</button></li>`).join('')}</ul>`
        : '<p class="muted small">Check “Save to quick-pick” when adding a meal you eat often.</p>'}
    </section>

    <section class="card">
      <h2>💾 Backup</h2>
      <p class="muted small">Last backup: ${lastBackup ? new Date(lastBackup).toLocaleDateString('en-PH', { dateStyle: 'medium' }) : 'never'}.
        Save the file to Google Drive so you can restore it if Chrome data gets cleared. (The API key is not included.)</p>
      <div class="row wrap">
        <button class="btn primary" id="share-backup">Share to Drive…</button>
        <button class="btn secondary" id="download-backup">Download file</button>
        <label class="btn secondary">Restore…<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      </div>
      <p class="muted small">Storage protection: ${persisted ? '✅ on (Chrome won’t auto-delete)' : '⚠️ off'}
        ${persisted ? '' : '<button class="link-btn" id="persist">Turn on</button>'}</p>
    </section>

    <section class="card">
      <h2>⚠️ Danger zone</h2>
      <button class="btn danger" id="clear-all">Delete all data</button>
    </section>
    <p class="muted small center">Kain Log v${APP_VERSION}</p>`;

  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    for (const k of ['age', 'height', 'weight']) f[k] = f[k] ? Number(f[k]) : null;
    await db.saveSetting('profile', f);
    toast('Profile saved.');
    render();
  };
  $('#toggle-key').onclick = (e) => {
    const input = $('#api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    e.target.textContent = input.type === 'password' ? 'Show' : 'Hide';
  };
  const saveAI = async () => {
    await db.saveSetting('apiKey', $('#api-key').value.trim());
    await db.saveSetting('model', $('#model').value);
  };
  $('#save-ai').onclick = async () => {
    await saveAI();
    toast('Saved.');
    estimatePending();
  };
  $('#load-models').onclick = async () => {
    try {
      const list = await ai.listModels($('#api-key').value.trim());
      await db.saveSetting('models', list);
      const cur = list.includes($('#model').value) ? $('#model').value : ai.pickModel(list) || $('#model').value;
      $('#model').innerHTML = [...new Set([cur, ...list])].map((m) => opt(m, m, cur)).join('');
      toast(`${list.length} models found.`);
    } catch (err) {
      toast(err.message, 6000);
    }
  };
  $('#test-ai').onclick = async () => {
    await saveAI();
    toast('Testing…');
    try {
      const reply = await ai.chat({ profile: null, context: '', history: [{ role: 'user', text: 'Say hi in one short Taglish sentence.' }] });
      toast('✅ ' + reply, 6000);
      estimatePending();
    } catch (err) {
      toast(err.message, 6000);
    }
  };
  view.querySelectorAll('[data-del-fav]').forEach((b) => (b.onclick = async () => {
    await db.del('favorites', b.dataset.delFav);
    render();
  }));
  $('#share-backup').onclick = () => backup(true);
  $('#download-backup').onclick = () => backup(false);
  $('#import-file').onchange = restore;
  $('#persist') && ($('#persist').onclick = async () => {
    await requestPersistence();
    if (!(await navigator.storage.persisted())) toast('Chrome said no for now. Installing the app to the home screen usually helps.', 6000);
    render();
  });
  $('#clear-all').onclick = async () => {
    if (!confirm('Delete ALL meals, quick-picks, reviews and settings? Make a backup first!')) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    await db.clearAll();
    state.chat = [];
    toast('All data deleted.');
    render();
  };
}

async function backup(share) {
  const data = await db.exportAll();
  const name = `kain-log-backup-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Kain Log backup' });
    } else {
      if (share) toast('Sharing not supported here, downloading instead.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    await db.saveSetting('lastBackup', Date.now());
    toast(`Backup ready: ${data.meals.length} meals.`);
    render();
  } catch (err) {
    if (err.name !== 'AbortError') toast('Backup failed: ' + err.message);
  }
}

async function restore(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const replace = confirm(`Backup has ${data.meals?.length || 0} meals.\n\nOK = replace everything with the backup\nCancel = merge with current data`);
    await db.importAll(data, { replace });
    toast('Restored!');
    render();
  } catch (err) {
    toast('Restore failed: ' + err.message, 6000);
  }
}

// ---------- shell ----------

const TITLES = { today: 'Kain Log', week: 'Weekly summary', ask: 'Ask the coach', settings: 'Settings' };
const RENDERERS = { today: renderToday, week: renderWeek, ask: renderAsk, settings: renderSettings };

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(async () => {
    renderQueued = false;
    $('#screen-title').textContent = TITLES[state.tab];
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    await RENDERERS[state.tab]();
    updateBanner();
  });
}

async function updateBanner() {
  const el = $('#banner');
  if (state.updateReady) {
    el.innerHTML = 'May bagong version! <button class="btn small" data-update>Update</button>';
    el.hidden = false;
    return;
  }
  const last = await db.setting('lastBackup');
  const count = (await db.all('meals')).length;
  const stale = count >= 5 && (!last || Date.now() - last > BACKUP_REMINDER_DAYS * 864e5);
  if (stale && state.tab !== 'settings') {
    el.innerHTML = `💾 ${last ? 'No backup in 2+ weeks.' : 'No backup yet.'} <button class="btn small" data-goto="settings">Back up</button>`;
    el.hidden = false;
  } else el.hidden = true;
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  window.scrollTo(0, 0);
  render();
});

// Delegated clicks for the dynamic views.
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-edit]');
  if (!t) return;
  const d = t.dataset;
  if (d.day !== undefined) {
    state.date = d.day === '0' ? today() : addDays(state.date, Number(d.day));
    if (state.date > today()) state.date = today();
    render();
  } else if (d.week !== undefined) {
    state.week = addDays(state.week, 7 * Number(d.week));
    render();
  } else if (d.add) {
    openMealDialog({ type: d.add });
  } else if (d.skip) {
    await db.put('meals', { id: db.uid(), date: state.date, mealType: d.skip, skipped: true, time: mealType(d.skip).time, createdAt: Date.now() });
    render();
  } else if (d.unskip) {
    await db.del('meals', d.unskip);
    render();
  } else if (d.estimate) {
    estimate(await db.get('meals', d.estimate));
  } else if (d.estimateAll !== undefined) {
    if (!(await db.setting('apiKey'))) return toast('Add your Gemini key in Settings first.');
    toast('Estimating…');
    estimatePending();
  } else if (d.review !== undefined) {
    generateReview(t);
  } else if (d.q) {
    ask(d.q);
  } else if (d.clearChat !== undefined) {
    state.chat = [];
    await db.saveSetting('chat', []);
    render();
  } else if (d.goto) {
    state.tab = d.goto;
    render();
  } else if (d.update !== undefined) {
    t.disabled = true;
    t.textContent = 'Updating…';
    state.waitingWorker?.postMessage('skipWaiting');
  } else if (d.edit) {
    openMealDialog({ meal: await db.get('meals', d.edit) });
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'chat-form') return;
  e.preventDefault();
  ask(e.target.q.value);
});

async function generateReview(btn) {
  btn.disabled = true;
  btn.textContent = 'Generating…';
  $('#review-body').innerHTML = '<p class="muted">⏳ Sinusuri ang linggo mo…</p>';
  try {
    const start = state.week;
    const meals = await db.mealsBetween(start, addDays(start, 6));
    const profile = await db.setting('profile');
    const { days, grid, ...stats } = weekStats(meals, start, profile);
    const text = await ai.weeklyReview({ profile, stats, mealLines: mealLines(meals) });
    await db.put('reviews', { weekStart: start, text, createdAt: Date.now() });
  } catch (err) {
    toast(err.message, 6000);
  }
  render();
}

function updateOnline() {
  $('#online-dot').classList.toggle('offline', !navigator.onLine);
  $('#online-dot').title = navigator.onLine ? 'Online' : 'Offline (logging still works)';
}
window.addEventListener('online', () => {
  updateOnline();
  estimatePending();
});
window.addEventListener('offline', updateOnline);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const waiting = (w) => {
      state.waitingWorker = w;
      state.updateReady = true;
      updateBanner();
    };
    if (reg.waiting && navigator.serviceWorker.controller) waiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) waiting(w);
      });
    });
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

// Confirms an update after the reload. Installs from before v1.0.2 never saved a
// version, so a page already controlled by the service worker counts as an update.
async function announceUpdate() {
  const last = await db.setting('appVersion');
  if (last !== APP_VERSION) {
    if (last || navigator.serviceWorker?.controller) toast(`✅ Updated na! Kain Log v${APP_VERSION}`, 5000);
    await db.saveSetting('appVersion', APP_VERSION);
  }
}

updateOnline();
render();
announceUpdate();
estimatePending();
