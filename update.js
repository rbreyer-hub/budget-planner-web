/* ── Auto-update ──
   A home-screen shortcut on iOS keeps a page open (or serves it from cache) long after a new deploy.
   Whenever the app comes back to the foreground (and every few minutes while open), fetch index.html
   uncached and compare the ?v= tags on its local scripts/stylesheets. If they changed, jump to a
   never-seen URL so iOS has to fetch the new page; a plain location.reload() can be answered from the
   HTTP cache (GitHub Pages sends max-age=600) and bring the old files back.
   Waits while a form field is focused so nothing being typed is lost.
   Self-contained: drop in with <script src="update.js?v=N"></script> as the last script. */
(function () {
  if (!location.protocol.startsWith('http')) return;

  // Local (relative) script/stylesheet URLs carrying a ?v= tag, e.g. "app.js?v=20261122a".
  const tagsOf = html => {
    const out = [], re = /(?:src|href)\s*=\s*["']([^"':]+\?v=[\w.-]+)["']/g;
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out.sort().join('|');
  };
  const runningTags = tagsOf(document.documentElement.outerHTML);
  if (!runningTags) return;

  const page = location.pathname.endsWith('/') ? location.pathname + 'index.html' : location.pathname;
  let updateReady = false, lastCheck = 0;

  async function checkForUpdate() {
    if (document.hidden || updateReady || Date.now() - lastCheck < 2000) return;
    lastCheck = Date.now();
    try {
      const res = await fetch(page + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const tags = tagsOf(await res.text());
      if (tags && tags !== runningTags) { updateReady = true; applyUpdate(tags); }
    } catch (_) { /* offline: try again next time */ }
  }

  function busy() {
    const a = document.activeElement;
    return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function applyUpdate(tags) {
    if (busy()) { setTimeout(() => applyUpdate(tags), 3000); return; }   // typing: wait until done
    // Loop guard: if we already tried to jump to this exact version and still got the old files, stop.
    const key = 'autoUpdate.tried:' + location.pathname;
    try { if (sessionStorage.getItem(key) === tags) return; sessionStorage.setItem(key, tags); } catch (_) {}
    note('Updating…');
    let h = 0;
    for (const c of tags) h = (h * 31 + c.charCodeAt(0)) | 0;
    const v = (h >>> 0).toString(36);
    setTimeout(() => location.replace(location.pathname + '?v=' + v + location.hash), 400);
  }

  function note(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'z-index:2147483647;background:#111827;color:#fff;font:500 14px/1.2 system-ui,-apple-system,sans-serif;' +
      'padding:10px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);pointer-events:none';
    document.body.appendChild(el);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  window.addEventListener('pageshow', checkForUpdate);   // incl. restores from the back/forward cache
  window.addEventListener('focus', checkForUpdate);
  window.addEventListener('online', checkForUpdate);
  setInterval(checkForUpdate, 5 * 60e3);
  setTimeout(checkForUpdate, 1500);
})();
