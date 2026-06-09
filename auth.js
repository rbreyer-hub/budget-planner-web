/* ── Google Auth + Firestore cloud sync ── */
(function () {
  'use strict';

  const SYNCED_USER_KEY = 'budgetPlanner.cloudSyncedUser';
  const SETTINGS_KEYS = [
    'budgetPlanner.appTitle',
    'budgetPlanner.breakdownHidden',
    'budgetPlanner.breakdownMonths',
    'budgetPlanner.loansVisible'
  ];

  const auth = firebase.auth();
  const db   = firebase.firestore();
  let currentUser = null;

  /* ── Firestore refs ── */
  const userRef    = (uid) => db.collection('users').doc(uid);
  const budgetRef  = (uid, pid) => userRef(uid).collection('budgets').doc(pid);

  /* ── Toast helper (reuses the existing #saveToast element) ── */
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
    const signInBtn = document.getElementById('authSignIn');
    const userChip  = document.getElementById('authUserChip');
    const avatar    = document.getElementById('authUserAvatar');
    const name      = document.getElementById('authUserName');
    if (!signInBtn || !userChip) return;

    if (user) {
      signInBtn.style.display = 'none';
      userChip.style.display  = 'flex';
      if (user.photoURL) {
        avatar.src            = user.photoURL;
        avatar.style.display  = '';
      } else {
        avatar.style.display  = 'none';
      }
      name.textContent = user.displayName || user.email.split('@')[0];
    } else {
      signInBtn.style.display = '';
      userChip.style.display  = 'none';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('authSignIn')?.addEventListener('click', () => {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .catch(e => alert('Sign-in failed: ' + e.message));
    });

    document.getElementById('authSignOut')?.addEventListener('click', () => {
      auth.signOut().then(() => {
        localStorage.removeItem(SYNCED_USER_KEY);
        toast('Signed out');
      });
    });

    document.getElementById('authSyncNow')?.addEventListener('click', () => {
      if (!currentUser) return;
      pullFromCloud(currentUser.uid).then(reloaded => {
        if (!reloaded) toast('☁ Already up to date');
      });
    });
  });

  /* ── Upload local data → Firestore ── */
  async function pushLocalToCloud(uid) {
    const profilesStr = localStorage.getItem('budgetProfiles') || '[]';
    const profiles    = JSON.parse(profilesStr);
    const settings    = {};
    SETTINGS_KEYS.forEach(k => {
      const v = localStorage.getItem(k);
      if (v !== null) settings[k] = v;
    });

    const batch = db.batch();
    batch.set(userRef(uid), {
      profiles:   profilesStr,
      settings:   JSON.stringify(settings),
      updatedAt:  firebase.firestore.FieldValue.serverTimestamp()
    });

    profiles.forEach(p => {
      const data = localStorage.getItem(`budgetPlannerData.${p.id}.v2`);
      if (data) {
        batch.set(budgetRef(uid, p.id), {
          data,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    await batch.commit();
  }

  /* ── Download cloud data → localStorage, returns true if page will reload ── */
  async function pullFromCloud(uid) {
    const snap = await userRef(uid).get();
    if (!snap.exists) { toast('No cloud data found'); return false; }

    const d = snap.data();
    if (d.profiles)  localStorage.setItem('budgetProfiles', d.profiles);
    if (d.settings) {
      try {
        const s = JSON.parse(d.settings);
        Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
      } catch (_) {}
    }

    const profiles = d.profiles ? JSON.parse(d.profiles) : [];
    await Promise.all(profiles.map(async p => {
      try {
        const bs = await budgetRef(uid, p.id).get();
        if (bs.exists && bs.data().data) {
          localStorage.setItem(`budgetPlannerData.${p.id}.v2`, bs.data().data);
        }
      } catch (_) {}
    }));

    location.reload();
    return true;
  }

  /* ── First-time reconciliation after sign-in ── */
  async function reconcile(user) {
    let cloudSnap;
    try {
      cloudSnap = await userRef(user.uid).get();
    } catch (e) {
      console.warn('Firestore unreachable:', e);
      return;
    }

    const profilesStr  = localStorage.getItem('budgetProfiles');
    const hasLocalData = !!(profilesStr && JSON.parse(profilesStr).length > 0);
    const hasCloudData = !!(cloudSnap.exists && cloudSnap.data().profiles);

    if (!hasCloudData && !hasLocalData) return;

    if (!hasCloudData && hasLocalData) {
      const doIt = confirm(
        `Welcome${user.displayName ? ', ' + user.displayName : ''}!\n\n` +
        `Back up your existing budget(s) to the cloud so they sync across devices?`
      );
      if (doIt) {
        await pushLocalToCloud(user.uid);
        toast('☁ Budgets backed up to cloud');
      }
      return;
    }

    if (hasCloudData && !hasLocalData) {
      toast('☁ Loading your cloud data…', 3000);
      await pullFromCloud(user.uid);
      return;
    }

    /* Both exist */
    const useCloud = confirm(
      `You have budget data saved locally AND in the cloud.\n\n` +
      `OK  → Load cloud data (recommended when switching devices)\n` +
      `Cancel → Keep local data and overwrite the cloud`
    );
    if (useCloud) {
      await pullFromCloud(user.uid);
    } else {
      await pushLocalToCloud(user.uid);
      toast('☁ Local data synced to cloud');
    }
  }

  /* ── Auth state listener ── */
  auth.onAuthStateChanged(async user => {
    currentUser = user;
    updateAuthUI(user);

    if (!user) return;

    const alreadySynced = localStorage.getItem(SYNCED_USER_KEY) === user.uid;
    if (!alreadySynced) {
      await reconcile(user);
      localStorage.setItem(SYNCED_USER_KEY, user.uid);
    }
  });

  /* ── Public API — called from budget.js ── */
  window.cloudSync = {
    saveProfile(profileId, dataStr) {
      if (!currentUser) return;
      budgetRef(currentUser.uid, profileId)
        .set({ data: dataStr, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(e => console.warn('Cloud save failed:', e));
    },

    saveProfiles(profiles) {
      if (!currentUser) return;
      userRef(currentUser.uid)
        .set({ profiles: JSON.stringify(profiles), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
        .catch(e => console.warn('Cloud profiles save failed:', e));
    },

    saveSetting(key, value) {
      if (!currentUser) return;
      const fieldKey = 'settings_' + key.replace(/\./g, '_');
      userRef(currentUser.uid)
        .set({ [fieldKey]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
        .catch(e => console.warn('Cloud setting save failed:', e));
    }
  };
})();
