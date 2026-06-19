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
    'budgetPlanner.loansVisible'
  ];

  const auth = firebase.auth();
  const db   = firebase.firestore();
  let currentUser   = null;
  let unsubSnapshot = null;
  let saveCooldown  = false;
  let cooldownTimer = null;

  const userRef   = (uid) => db.collection('users').doc(uid);
  const budgetRef = (uid, pid) => userRef(uid).collection('budgets').doc(pid);

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

    if (d.profiles) localStorage.setItem('budgetProfiles', d.profiles);
    if (d.settings) {
      try {
        const s = JSON.parse(d.settings);
        Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (_) {}
    }

    let profiles = [];
    try { profiles = d.profiles ? JSON.parse(d.profiles) : []; } catch (_) {}

    /* Recovery: if the profiles list is empty but budget sub-documents exist,
       reconstruct profiles from them. This handles accidental profile-list wipes. */
    if (profiles.length === 0) {
      try {
        const budgetsSnap = await userRef(uid).collection('budgets').get();
        if (!budgetsSnap.empty) {
          const recovered = [];
          budgetsSnap.forEach((doc, i) => {
            if (doc.data().data) {
              recovered.push({ id: doc.id, name: `Budget ${recovered.length + 1}` });
              localStorage.setItem(`budgetPlannerData.${doc.id}.v2`, doc.data().data);
            }
          });
          if (recovered.length > 0) {
            profiles = recovered;
            localStorage.setItem('budgetProfiles', JSON.stringify(recovered));
            toast('☁ Budget data recovered from cloud', 4000);
          }
        }
      } catch (e) { console.warn('[BudgetSync] Sub-doc recovery failed:', e); }
    }

    /* Fetch budget data for all known profiles */
    await Promise.all(profiles.map(async p => {
      try {
        const bs = await budgetRef(uid, p.id).get();
        if (bs.exists && bs.data().data) localStorage.setItem(`budgetPlannerData.${p.id}.v2`, bs.data().data);
      } catch (_) {}
    }));

    if (cloudTs > 0) localStorage.setItem(LAST_PULL_TS_KEY, String(cloudTs));
    sessionStorage.setItem(SESSION_KEY, uid);
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
      await pushLocalToCloud(uid);
      localStorage.setItem(DAILY_BACKUP_KEY, String(Date.now()));
    } catch (e) {
      console.warn('[BudgetSync] Daily backup failed:', e);
    }
  }

  /* ── Auth state listener ── */
  auth.onAuthStateChanged(async user => {
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

    if (!knownUser) {
      await reconcile(user);
    } else if (!pulledThisTab) {
      sessionStorage.setItem(SESSION_KEY, user.uid);
      await pullFromCloud(user.uid, { silent: true });
    }

    startRealtimeSync(user.uid);

    /* Daily backup runs after sync so we push the freshest local data */
    runDailyBackupIfDue(user.uid);
  });

  /* ── Public API called from budget.js on every save ──
     Guards: never push null/empty data — budget sub-docs hold real user data. */
  window.cloudSync = {
    saveProfile(profileId, dataStr) {
      if (!currentUser || !profileId || !dataStr) return;
      markSaving();
      const batch = db.batch();
      batch.set(budgetRef(currentUser.uid, profileId), {
        data:      dataStr,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      /* Bump user doc so the budget sub-doc listener on other devices fires */
      batch.set(userRef(currentUser.uid), {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      batch.commit()
        .then(syncLocalTsAfterWrite)
        .catch(e => console.warn('[BudgetSync] saveProfile failed:', e));
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

    saveSetting(key, value) {
      if (!currentUser) return;
      markSaving();
      userRef(currentUser.uid)
        .set({
          ['settings_' + key.replace(/\./g, '_')]: value,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true })
        .then(syncLocalTsAfterWrite)
        .catch(e => console.warn('[BudgetSync] saveSetting failed:', e));
    }
  };
})();
