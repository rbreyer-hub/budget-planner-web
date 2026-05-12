# Budget Planner

A free, private, browser-only budget planner. Track bills by interval, project your balance for any date, catch low-balance days weeks before they hit.

**Live site:** https://rbreyer-hub.github.io/budget-planner-web/

## How storage works

Everything lives in your browser's `localStorage`. Nothing is uploaded, no accounts, no servers. Each browser is its own user. To move data between devices, use **Backup All** to download a JSON file and **Restore Backup** to load it on another machine.

## Local development

It's a static site — open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

- `index.html` — markup (hero, features, planner, FAQ, footer)
- `styles.css` — bernese-style dark shell + light planner surface
- `budget.js` — planner logic (also includes a `chrome.storage.local` → `localStorage` shim so the same code works in the Chrome extension build)

## Related

The Chrome/Edge extension version: https://github.com/rbreyer-hub/budget-planner-extension
