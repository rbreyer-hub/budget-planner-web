/* ── Google Auth + Firestore cloud sync ── */
(function () {
  'use strict';

  const SYNCED_USER_KEY  = 'budgetPlanner.cloudSyncedUser';
  const LAST_PULL_TS_KEY = 'budgetPlanner.lastCloudPullTs';
  const SESSION_KEY      = 'budgetPlanner.sessionPulled';
  const DAILY_BACKUP_KEY = 'budgetPlanner.lastDailyBackup';
  const BACKUP_INTERVAL  = 24 * 60 * 60 * 1000; // 24 hours in ms
  const SETTINGS_KEYS = [
    'budgetPlanner.appTitle',
    'budgetPlanner.breakdownHidden',
    'budgetPlanner.breakdownMonths',
    'budgetPlanner.loansVisible',
    'budgetPlanner.loanContentHidden'
  ];

  const auth = firebase.auth();
  const db   = firebase.firestore();
  let currentUser   = null;
  let unsubSnapshot = null;
  let saveCooldown  = false;
  let cooldownTimer = null;

  const userRef   = (uid) => db.collection('users').doc(uid);
  const budgetRef = (uid, pid) => userRef(uid).collection('budgets').doc(pid);
  /* The Debt Planner app keeps its data here (field `data` = JSON string). */
  const debtRef   = (uid) => userRef(uid).collection('debtPlanner').doc('main');

  /* Resolves once the first auth state (and the sign-in sync that follows it) has settled. */
  let authReadyResolve;
  const authReady = new Promise(r => { authReadyResolve = r; });

  /* ── Toast ── */
  function toast(msg, duration = 2500) {
    const el = document.getElementById('saveToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._authTimer);
    el._authTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  /* ── Auth UI ── */
  function updateAuthUI(user) {
    const signInBtn       = document.getElementById('authSignIn');
    const userChip        = document.getElementById('authUserChip');
    const avatar          = document.getElementById('authUserAvatar');
    const name            = document.getElementById('authUserName');
    const restoreCloudBtn = document.getElementById('restoreFromCloud');
    if (!signInBtn || !userChip) return;
    if (user) {
      signInBtn.style.display = 'none';
      userChip.style.display  = 'flex';
      if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = ''; }
      else { avatar.style.display = 'none'; }
      name.textContent = user.displayName || user.email.split('@')[0];
      if (restoreCloudBtn) restoreCloudBtn.style.display = '';
    } else {
      signInBtn.style.display = '';
      userChip.style.display  = 'none';
      if (restoreCloudBtn) restoreCloudBtn.style.display = 'none';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authSignIn')?.addEventListener('click', () => {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .catch(e => alert('Sign-in failed: ' + e.message));
    });

    document.getElementById('authSignOut')?.addEventListener('click', () => {
      const ok = confirm('Sign out of your Google account?\n\nYour data will remain saved locally on this device.');
      if (!ok) return;
      auth.signOut().then(() => {
        localStorage.removeItem(SYNCED_USER_KEY);
        localStorage.removeItem(LAST_PULL_TS_KEY);
        toast('Signed out');
      });
    });

    document.getElementById('authSyncNow')?.addEventListener('click', () => {
      if (!currentUser) return;
      pullFromCloud(currentUser.uid, { force: true }).then(reloaded => {
        if (!reloaded) toast('☁ Already up to date');
      });
    });

    document.getElementById('restoreFromCloud')?.addEventListener('click', () => {
      if (!currentUser) return;
      const ok = confirm(
        'Restore data from cloud?\n\n' +
        'This will replace everything on this device with the latest cloud backup. ' +
        'Any unsaved local changes will be lost.'
      );
      if (!ok) return;
      toast('☁ Restoring from cloud…', 3000);
      pullFromCloud(currentUser.uid, { force: true }).then(reloaded => {
        if (!reloaded) toast('☁ Nothing to restore — cloud data matches this device');
      });
    });
  });

  /* ── Unsynced-change tracking ──
     A budget is "dirty" from the moment it is saved locally until its cloud write
     is confirmed. Pulls never overwrite a dirty budget (that was deleting freshly
     added items), and dirty budgets are flushed to the cloud on next sign-in. */
  const dirtyKey = id => `budgetPlanner.dirty.${id}`;
  const isDirty  = id => !!localStorage.getItem(dirtyKey(id));
  const dirtySeq = {};

  /* ── Conflict-safe budget writes ──
     base.<id> is the budget JSON this device last agreed on with the cloud (pulled or written).
     Every write reads the cloud copy inside a transaction first. If it no longer matches base,
     another device saved in between, so the two sets of edits are merged field by field against
     base, instead of this device's whole (stale) copy replacing them. That replacement is what
     kept reverting bill amounts edited on another device. */
  const baseKey = id => `budgetPlanner.base.${id}`;
  const dataKey = id => `budgetPlannerData.${id}.v2`;
  const same  = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  function merge3(b, l, c) {
    if (same(l, b)) return c;                      // only the cloud changed it
    if (same(c, b) || same(l, c)) return l;        // only this device changed it
    if (isObj(b) && isObj(l) && isObj(c)) {
      const out = {};
      new Set([...Object.keys(l), ...Object.keys(c)]).forEach(k => {
        const v = merge3(b[k], l[k], c[k]);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(c)) {
      const n = b.length;   // merge item by item when at most one side appended items
      if (l.length >= n && c.length >= n && (l.length === n || c.length === n))
        return [...b.map((x, i) => merge3(x, l[i], c[i])), ...l.slice(n), ...c.slice(n)];
    }
    return l;   // both changed the same thing: this device's edit is the newer intent
  }

  /* Writes one budget. Serialized per budget, and always sends what is in storage when it runs.
     opts.onlyIfInSync: skip unless the cloud still matches base (background writes, e.g. the daily backup).
     Without a base (first run of this version) a conflicting background write lets the cloud win. */
  const writeChain = {};
  function writeBudget(uid, id, opts = {}) {
    const run = async () => {
      const local = localStorage.getItem(dataKey(id));
      if (!local) return { skipped: true };
      const base = localStorage.getItem(baseKey(id));
      const res = await db.runTransaction(async tx => {
        const snap  = await tx.get(budgetRef(uid, id));
        const cloud = snap.exists ? (snap.data()?.data || null) : null;
        let out = local;
        if (cloud && cloud !== local && cloud !== base) {
          if (opts.onlyIfInSync || (!base && opts.background)) return { skipped: true, cloud };
          if (base) out = JSON.stringify(merge3(JSON.parse(base), JSON.parse(local), JSON.parse(cloud)));
        }
        if (out === cloud) return { out };
        tx.set(budgetRef(uid, id), { data: out, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        /* Bump user doc so the budget sub-doc listener on other devices fires */
        tx.set(userRef(uid), { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { out, wrote: true };
      });
      if (res.skipped) return res;
      if (localStorage.getItem(dataKey(id)) === local) {   // not edited again while the write was in flight
        localStorage.setItem(baseKey(id), res.out);
        if (res.out !== local) {
          localStorage.setItem(dataKey(id), res.out);
          window.dispatchEvent(new CustomEvent('budget-merged', { detail: { id, local, out: res.out } }));
          toast('☁ Merged changes from another device');
        }
      }   // else: keep the old base so the next write merges the newer edit onto the cloud copy
      return res;
    };
    const p = (writeChain[id] || Promise.resolve()).catch(() => {}).then(run);
    writeChain[id] = p;
    return p;
  }

  async function flushDirty(uid) {
    let profiles = [];
    try { profiles = JSON.parse(localStorage.getItem('budgetProfiles') || '[]'); } catch (_) {}
    for (const p of profiles) {
      if (!isDirty(p.id)) continue;
      const data = localStorage.getItem(`budgetPlannerData.${p.id}.v2`);
      if (!data) { localStorage.removeItem(dirtyKey(p.id)); continue; }
      try {
        await writeBudget(uid, p.id, { background: true });   // a skipped (cloud-wins) flush is resolved too
        localStorage.removeItem(dirtyKey(p.id));
      } catch (e) { console.warn('[BudgetSync] Flush failed for', p.id, e); }
    }
  }

  /* ── Prevent pulling our own writes ── */
  function markSaving() {
    saveCooldown = true;
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => { saveCooldown = false; }, 4000);
  }

  function syncLocalTsAfterWrite() {
    if (!currentUser) return;
    userRef(currentUser.uid).get().then(snap => {
      const ts = snap.data()?.updatedAt?.toMillis?.();
      if (ts) localStorage.setItem(LAST_PULL_TS_KEY, String(ts));
    }).catch(() => {});
  }

  /* ── Upload local → Firestore ──
     Safety: never push if profiles list is empty — that would wipe cloud data. */
  async function pushLocalToCloud(uid) {
    const profilesStr = localStorage.getItem('budgetProfiles') || '[]';
    let profiles;
    try { profiles = JSON.parse(profilesStr); } catch (_) { profiles = []; }

    if (profiles.length === 0) {
      console.warn('[BudgetSync] Push skipped: local profiles list is empty');
      return;
    }

    const settings = {};
    SETTINGS_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v !== null) settings[k] = v; });

    const batch = db.batch();
    batch.set(userRef(uid), {
      profiles:  profilesStr,
      settings:  JSON.stringify(settings),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    profiles.forEach(p => {
      const data = localStorage.getItem(`budgetPlannerData.${p.id}.v2`);
      if (data) batch.set(budgetRef(uid, p.id), { data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
    profiles.forEach(p => {
      const data = localStorage.getItem(`budgetPlannerData.${p.id}.v2`);
      if (data) localStorage.setItem(baseKey(p.id), data);
    });
  }

  /* ── Download cloud → localStorage ──
     If the user doc's profiles list is empty but budget sub-documents still
     exist (e.g. after accidental data loss), this recovers from the sub-docs. */
  async function pullFromCloud(uid, options = {}) {
    let snap;
    try { snap = await userRef(uid).get(); }
    catch (e) { console.warn('[BudgetSync] Pull failed:', e); return false; }

    if (!snap.exists) {
      if (!options.silent) toast('No cloud data found');
      return false;
    }

    const d       = snap.data();
    const cloudTs = d.updatedAt?.toMillis?.() ?? 0;
    const localTs = parseInt(localStorage.getItem(LAST_PULL_TS_KEY) || '0');

    if (!options.force && cloudTs > 0 && cloudTs <= localTs) return false;

    /* Tabs are only ever added via the + button (or restored from a backup file).
       A sync must never invent or drop tabs, so:
       - only adopt the cloud tab list when it is a non-empty list;
       - if the cloud list is missing/empty, keep the local list as-is and
         re-publish it, instead of rebuilding tabs from stray budget sub-docs. */
    let cloudProfiles = [];
    try { cloudProfiles = d.profiles ? JSON.parse(d.profiles) : []; } catch (_) {}
    let localProfiles = [];
    try { localProfiles = JSON.parse(localStorage.getItem('budgetProfiles') || '[]'); } catch (_) {}
    if (!Array.isArray(cloudProfiles)) cloudProfiles = [];
    if (!Array.isArray(localProfiles)) localProfiles = [];

    let profiles;
    if (cloudProfiles.length > 0) {
      profiles = cloudProfiles;
      localStorage.setItem('budgetProfiles', d.profiles);
    } else {
      profiles = localProfiles;
      if (localProfiles.length > 0) {
        userRef(uid).set({ profiles: JSON.stringify(localProfiles) }, { merge: true })
          .catch(e => console.warn('[BudgetSync] Re-publishing tab list failed:', e));
      }
    }
    if (d.settings) {
      try {
        const s = JSON.parse(d.settings);
        Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (_) {}
    }

    /* Fetch budget data for all known profiles */
    await Promise.all(profiles.map(async p => {
      try {
        if (isDirty(p.id)) return;   // local copy has unsynced edits — keep it
        const bs = await budgetRef(uid, p.id).get();
        if (isDirty(p.id)) return;   // edited while we were fetching
        if (bs.exists && bs.data().data) {
          localStorage.setItem(`budgetPlannerData.${p.id}.v2`, bs.data().data);
          localStorage.setItem(baseKey(p.id), bs.data().data);
        }
      } catch (_) {}
    }));

    if (cloudTs > 0) localStorage.setItem(LAST_PULL_TS_KEY, String(cloudTs));
    sessionStorage.setItem(SESSION_KEY, uid);
    window.__budgetReloading = true;   // lets in-flight work (e.g. the Debt Planner sync) bail out
    location.reload();
    return true;
  }

  /* ── Real-time listener ──
     Watches user doc AND each budget sub-doc for remote changes.
     Skips the first snapshot (baseline) to prevent reload loops. */
  function startRealtimeSync(uid) {
    if (unsubSnapshot) unsubSnapshot();
    const handlers  = [];
    const initialTs = {};

    function handleDocChange(key, snap) {
      if (!snap.exists || snap.metadata.hasPendingWrites || saveCooldown) return;
      const cloudTs = snap.data()?.updatedAt?.toMillis?.() ?? 0;
      if (initialTs[key] === undefined) { initialTs[key] = cloudTs; return; }
      if (cloudTs > initialTs[key]) {
        initialTs[key] = cloudTs;
        pullFromCloud(uid, { silent: true });
      }
    }

    handlers.push(userRef(uid).onSnapshot(
      snap => handleDocChange('user', snap),
      err  => console.warn('[BudgetSync] user doc listener error:', err)
    ));

    try {
      const profiles = JSON.parse(localStorage.getItem('budgetProfiles') || '[]');
      profiles.forEach(p => {
        handlers.push(budgetRef(uid, p.id).onSnapshot(
          snap => handleDocChange('budget:' + p.id, snap),
          err  => console.warn('[BudgetSync] budget listener error:', err)
        ));
      });
    } catch (_) {}

    unsubSnapshot = () => handlers.forEach(unsub => unsub());
  }

  /* ── Re-check the cloud when the app comes back to the foreground ──
     A phone keeps the page alive in the background: the once-per-tab pull and the
     realtime listener never re-run, so it kept showing stale amounts. Pull (non-forced:
     it only reloads if the cloud is newer, and never touches unsynced local edits). */
  let lastResumePull = 0;
  async function pullOnResume() {
    if (!currentUser || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastResumePull < 15000) return;
    lastResumePull = now;
    await flushDirty(currentUser.uid);
    pullFromCloud(currentUser.uid, { silent: true });
  }
  document.addEventListener('visibilitychange', pullOnResume);
  window.addEventListener('pageshow', pullOnResume);
  window.addEventListener('online', pullOnResume);

  /* ── First-time sign-in reconciliation ──
     SAFE RULE: cloud is always the source of truth.
     - Cloud exists → always pull from it, no dialog, no overwrite risk.
     - Cloud is empty → offer to back up local data (only safe push direction). */
  async function reconcile(user) {
    let cloudSnap;
    try { cloudSnap = await userRef(user.uid).get(); }
    catch (e) { console.warn('[BudgetSync] Firestore unreachable:', e); return; }

    if (cloudSnap.exists) {
      /* Cloud has a user doc — pull it unconditionally.
         The recovery logic inside pullFromCloud handles any empty-profiles case. */
      toast('☁ Loading your cloud data…', 3000);
      await pullFromCloud(user.uid, { force: true });
      return;
    }

    /* No cloud data at all — offer to back up local budgets */
    let profiles = [];
    try { profiles = JSON.parse(localStorage.getItem('budgetProfiles') || '[]'); } catch (_) {}

    if (profiles.length > 0) {
      const doIt = confirm(
        `Welcome${user.displayName ? ', ' + user.displayName : ''}!\n\n` +
        `Back up your existing budget(s) to the cloud so they sync across devices?`
      );
      if (doIt) {
        await pushLocalToCloud(user.uid);
        toast('☁ Budgets backed up to cloud');
      }
    }
  }

  /* ── Daily safety backup ──
     Once per day, push local data to cloud regardless of normal sync events.
     Guards in pushLocalToCloud ensure empty data is never uploaded. */
  async function runDailyBackupIfDue(uid) {
    const last = parseInt(localStorage.getItem(DAILY_BACKUP_KEY) || '0');
    if (Date.now() - last < BACKUP_INTERVAL) return;
    try {
      /* Budgets only, and only where the cloud hasn't moved on: this used to push the whole
         local copy over whatever another device had saved since. */
      let profiles = [];
      try { profiles = JSON.parse(localStorage.getItem('budgetProfiles') || '[]'); } catch (_) {}
      for (const p of profiles) await writeBudget(uid, p.id, { onlyIfInSync: true });
      localStorage.setItem(DAILY_BACKUP_KEY, String(Date.now()));
    } catch (e) {
      console.warn('[BudgetSync] Daily backup failed:', e);
    }
  }

  /* ── Auth state listener ── */
  auth.onAuthStateChanged(user => handleAuth(user).finally(() => authReadyResolve()));

  async function handleAuth(user) {
    currentUser = user;
    updateAuthUI(user);

    if (!user) {
      if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
      return;
    }

    const knownUser     = localStorage.getItem(SYNCED_USER_KEY) === user.uid;
    const pulledThisTab = sessionStorage.getItem(SESSION_KEY) === user.uid;

    /* Set before any async work so a reload inside reconcile/pullFromCloud
       doesn't lose this flag and re-trigger reconcile on the next load. */
    localStorage.setItem(SYNCED_USER_KEY, user.uid);

    await flushDirty(user.uid);   // push any edits that never reached the cloud before pulling

    if (!knownUser) {
      await reconcile(user);
    } else if (!pulledThisTab) {
      sessionStorage.setItem(SESSION_KEY, user.uid);
      await pullFromCloud(user.uid, { silent: true });
    }

    startRealtimeSync(user.uid);

    /* Daily backup runs after sync so we push the freshest local data */
    runDailyBackupIfDue(user.uid);
  }

  /* ── Public API called from budget.js on every save ──
     Guards: never push null/empty data — budget sub-docs hold real user data. */
  window.cloudSync = {
    saveProfile(profileId, dataStr) {
      /* Edited before auth finished loading: remember it so a startup pull can't clobber it */
      if (!currentUser && profileId && dataStr && localStorage.getItem(SYNCED_USER_KEY)) localStorage.setItem(dirtyKey(profileId), String(Date.now()));
      if (!currentUser || !profileId || !dataStr) return;
      markSaving();
      const seq = dirtySeq[profileId] = (dirtySeq[profileId] || 0) + 1;
      localStorage.setItem(dirtyKey(profileId), String(Date.now()));
      writeBudget(currentUser.uid, profileId)
        .then(() => { if (dirtySeq[profileId] === seq) localStorage.removeItem(dirtyKey(profileId)); })
        .then(syncLocalTsAfterWrite)
        .catch(e => console.warn('[BudgetSync] saveProfile failed (kept as unsynced):', e));
    },

    saveProfiles(profiles) {
      if (!currentUser || !Array.isArray(profiles) || profiles.length === 0) return;
      markSaving();
      userRef(currentUser.uid)
        .set({
          profiles:  JSON.stringify(profiles),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true })
        .then(syncLocalTsAfterWrite)
        .catch(e => console.warn('[BudgetSync] saveProfiles failed:', e));
    },

    isSignedIn() { return !!currentUser; },
    /* Resolves once auth has settled (or after 8s), so callers can trust isSignedIn(). */
    merge3,

    ready() { return Promise.race([authReady, new Promise(r => setTimeout(r, 8000))]); },

    /* Debt Planner data for the Budget's debt sync. Signed in -> the CLOUD copy, so every device
       computes the same bill amounts (a device's own localStorage copy can be stale).
       Returns { source: 'cloud', raw, data } | { source: 'local' } (signed out / no cloud copy yet)
       | { source: 'error' } (signed in but the cloud could not be read: caller must not guess). */
    async getDebtPlannerData() {
      await Promise.race([authReady, new Promise(r => setTimeout(r, 8000))]);
      if (!currentUser) return { source: 'local' };
      try {
        const snap = await debtRef(currentUser.uid).get();
        const raw = snap.exists ? snap.data()?.data : null;
        if (!raw) return { source: 'local' };
        return { source: 'cloud', raw, data: JSON.parse(raw) };
      } catch (e) {
        console.warn('[BudgetSync] Could not read Debt Planner data from cloud:', e);
        return { source: 'error' };
      }
    },

    /* Atomically edit the cloud copy of the Debt Planner data. mutator(data) edits in place and
       returns true if it changed anything. Resolves { ok, raw } | { unchanged } | { noDoc } | { error }. */
    async updateDebtPlanner(mutator) {
      await Promise.race([authReady, new Promise(r => setTimeout(r, 8000))]);
      if (!currentUser) return { ok: false };
      const ref = debtRef(currentUser.uid);
      try {
        const res = await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const cur = snap.exists ? snap.data()?.data : null;
          if (!cur) return { noDoc: true };
          const data = JSON.parse(cur);
          if (!mutator(data)) return { unchanged: true };
          const out = JSON.stringify(data);
          tx.set(ref, { data: out, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
          return { ok: true, raw: out };
        });
        return res;
      } catch (e) {
        console.warn('[BudgetSync] Debt Planner cloud update failed:', e);
        return { ok: false, error: true };
      }
    },

    async saveSetting(key, value) {
      if (!currentUser) return;
      markSaving();
      const ref = userRef(currentUser.uid);
      try {
        const snap = await ref.get();
        let settings = {};
        try { settings = JSON.parse(snap.data()?.settings || '{}'); } catch (_) {}
        settings[key] = value;
        await ref.set({
          settings:  JSON.stringify(settings),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        syncLocalTsAfterWrite();
      } catch (e) {
        console.warn('[BudgetSync] saveSetting failed:', e);
      }
    }
  };
})();
