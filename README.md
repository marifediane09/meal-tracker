# Kain Log

Personal meal logger PWA with weekly summaries and AI nutrition tips for balanced eating.

- Log Breakfast, Snack, Lunch, Merienda and Dinner by text, quick-pick, or photo. No food scale needed; rough portions are fine.
- Google Gemini (free tier) estimates calories and the Pinggang Pinoy plate split (Go / Grow / Glow) and flags fried food, sugary drinks, sweets and processed food.
- Weekly summary with a Taglish coach review, plus an "Ask the coach" chat that sees your last 14 days.
- Works offline. Meals are saved on the phone (IndexedDB) and estimated once you're back online.
- Backup/restore to a JSON file (e.g. Google Drive). The API key is never included in backups or in this repo.

## Setup

1. **Turn on GitHub Pages:** repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main` and `/ (root)`. The app will be at `https://marifediane09.github.io/meal-tracker/`.
2. On your Android phone, open that link in Chrome → ⋮ menu → **Add to Home screen / Install app**.
3. Get a free Gemini API key at <https://aistudio.google.com/apikey>, then paste it in the app under **Settings → AI**, tap **Save**, then **Test**.
4. Fill in your profile in **Settings** for a rough daily calorie need.

## Development

Plain HTML/CSS/JS ES modules, no build step. Run locally with any static server:

```sh
python3 -m http.server 8000
```

**When you change any file, bump `CACHE` in `sw.js`** (e.g. `kain-log-v2`). Otherwise installed phones keep the old cached files. The app shows an "Update" banner when a new version is ready.

| File | What it does |
| --- | --- |
| `index.html` | App shell and the add-meal sheet |
| `js/app.js` | Screens (Today, Week, Ask, Settings), backup, service worker updates |
| `js/ai.js` | Gemini API calls and prompts (Taglish persona) |
| `js/stats.js` | Dates, meal types, weekly numbers, calorie formula |
| `js/db.js` | IndexedDB storage, export/import |
| `sw.js` | Offline cache |

Calorie numbers are rough AI estimates from descriptions and photos, not medical advice.
