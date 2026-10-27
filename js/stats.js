// Date helpers and the weekly numbers shown on the Week screen.
export const MEAL_TYPES = [
  { id: 'breakfast', label: 'Breakfast', icon: '🌅', main: true, time: '07:00' },
  { id: 'snack', label: 'Snack', icon: '🍌', main: false, time: '10:00' },
  { id: 'lunch', label: 'Lunch', icon: '🍛', main: true, time: '12:00' },
  { id: 'merienda', label: 'Merienda', icon: '☕', main: false, time: '15:30' },
  { id: 'dinner', label: 'Dinner', icon: '🌙', main: true, time: '19:00' },
];
export const mealType = (id) => MEAL_TYPES.find((m) => m.id === id) || MEAL_TYPES[0];

const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const today = () => dateStr(new Date());
export const addDays = (s, n) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
};
// Weeks run Monday to Sunday.
export const weekStart = (s) => {
  const d = parseDate(s);
  return addDays(s, -((d.getDay() + 6) % 7));
};
export const nowTime = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtDay = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  parseDate(s).toLocaleDateString('en-PH', opts);

const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };

// Mifflin-St Jeor resting energy times an activity factor. Only a rough guide.
export function calorieTarget(p) {
  if (!p?.age || !p?.height || !p?.weight || !p?.sex) return null;
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === 'male' ? 5 : -161);
  return Math.round((base * (ACTIVITY[p.activity] || 1.375)) / 10) * 10;
}

export function weekStats(meals, start, profile) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const eaten = meals.filter((m) => !m.skipped);
  const estimated = eaten.filter((m) => m.estimate);
  const main = estimated.filter((m) => mealType(m.mealType).main);

  const grid = days.map((date) =>
    MEAL_TYPES.map((t) => {
      const rows = meals.filter((m) => m.date === date && m.mealType === t.id);
      if (rows.some((m) => !m.skipped)) return 'logged';
      if (rows.length) return 'skipped';
      return 'none';
    }),
  );

  const mainIdx = MEAL_TYPES.map((t, i) => (t.main ? i : -1)).filter((i) => i >= 0);
  const mainLogged = grid.reduce((n, row) => n + mainIdx.filter((i) => row[i] === 'logged').length, 0);
  const mainSkipped = grid.reduce((n, row) => n + mainIdx.filter((i) => row[i] === 'skipped').length, 0);
  const skippedByType = Object.fromEntries(
    MEAL_TYPES.filter((t) => t.main).map((t) => [t.id, meals.filter((m) => m.skipped && m.mealType === t.id).length]),
  );

  const avg = (arr, f) => (arr.length ? Math.round(arr.reduce((s, x) => s + f(x), 0) / arr.length) : null);
  const pct = (arr, f) => (arr.length ? Math.round((100 * arr.filter(f).length) / arr.length) : null);

  // Average calories only over days that have all main meals logged and estimated,
  // so half-logged days don't make the number look low.
  const fullDays = days.filter((date) => {
    const dayMain = MEAL_TYPES.filter((t) => t.main).map((t) => meals.filter((m) => m.date === date && m.mealType === t.id));
    return dayMain.every((rows) => rows.length && rows.every((m) => m.skipped || m.estimate));
  });
  const dayCalories = fullDays.map((date) =>
    estimated.filter((m) => m.date === date).reduce((s, m) => s + (m.estimate.calories || 0), 0),
  );

  return {
    days,
    grid,
    logged: eaten.length,
    pending: eaten.length - estimated.length,
    mainLogged,
    mainSkipped,
    mainPossible: 21,
    skippedByType,
    plate: main.length
      ? { go: avg(main, (m) => m.estimate.plate.go), grow: avg(main, (m) => m.estimate.plate.grow), glow: avg(main, (m) => m.estimate.plate.glow) }
      : null,
    vegPct: pct(main, (m) => m.estimate.hasVeg),
    proteinPct: pct(main, (m) => m.estimate.hasProtein),
    fruitDays: days.filter((d) => estimated.some((m) => m.date === d && m.estimate.hasFruit)).length,
    fried: estimated.filter((m) => m.estimate.fried).length,
    sweet: estimated.filter((m) => m.estimate.sweet).length,
    sugaryDrink: estimated.filter((m) => m.estimate.sugaryDrink).length,
    processed: estimated.filter((m) => m.estimate.processed).length,
    avgCalories: dayCalories.length ? Math.round(dayCalories.reduce((a, b) => a + b, 0) / dayCalories.length) : null,
    calorieDays: dayCalories.length,
    target: calorieTarget(profile),
  };
}

// One line per meal, used as context for the AI.
export function mealLines(meals) {
  return meals
    .map((m) => {
      const head = `${fmtDay(m.date)} ${m.time || ''} ${mealType(m.mealType).label}:`;
      if (m.skipped) return `${head} SKIPPED`;
      const e = m.estimate;
      const desc = e?.description || m.text || '(photo)';
      const extra = e
        ? ` (~${e.calories} kcal; plate go/grow/glow ${e.plate.go}/${e.plate.grow}/${e.plate.glow}` +
          `${e.fried ? '; fried' : ''}${e.sugaryDrink ? '; sugary drink' : ''}${e.sweet ? '; sweets' : ''}${e.processed ? '; processed' : ''})`
        : '';
      return `${head} ${desc}${m.size && m.size !== 'regular' ? ` [${m.size}]` : ''}${m.portion ? ` [${m.portion}]` : ''}${extra}`;
    })
    .join('\n');
}
