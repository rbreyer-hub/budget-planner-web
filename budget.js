/* ── localStorage shim: maps chrome.storage.local API to localStorage so the
   same code works in the web build. Data lives per-browser, per-device. ── */
if (typeof window !== 'undefined' && (typeof chrome === 'undefined' || !chrome.storage)) {
  const toKeyList = (k) => Array.isArray(k) ? k : (typeof k === 'string' ? [k] : Object.keys(k || {}));
  window.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const result = {};
          toKeyList(keys).forEach(k => {
            const v = localStorage.getItem(k);
            if (v !== null) result[k] = v;
          });
          if (cb) setTimeout(() => cb(result), 0);
        },
        set(obj, cb) {
          try {
            Object.entries(obj).forEach(([k, v]) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)));
          } catch (e) {
            console.error('localStorage write failed:', e);
            if (e && e.name === 'QuotaExceededError') {
              alert('Browser storage is full. Use "Backup All" to save your data, then clear some space.');
            }
          }
          if (cb) cb();
        },
        remove(keys, cb) {
          toKeyList(keys).forEach(k => localStorage.removeItem(k));
          if (cb) cb();
        }
      }
    }
  };
}

const today = new Date();
const pad2 = n => String(n).padStart(2, '0');
const todayIso = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;
const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
const nextMonthIso = `${nextMonth.getFullYear()}-${pad2(nextMonth.getMonth()+1)}-${pad2(nextMonth.getDate())}`;

/* ── Profiles (dynamic, stored in chrome.storage.local) ── */
const PROFILES_KEY = "budgetProfiles";
let profiles = []; // array of { id, name }
const storageKeyForProfile = (id) => `budgetPlannerData.${id}.v2`;

const makeDefaultState = () => ({
  startingBalance: 0,
  balanceDate: todayIso,
  checkDate: nextMonthIso,
  bills: [],
  deposits: [],
  incidentals: [],
  archivedIncidentals: {},
  loans: [],
  funds: []
});

let activeProfile = null;
let state = makeDefaultState();

/* ── Elements ── */
const elements = {
  startingBalance: document.getElementById("startingBalance"),
  balanceDate:     document.getElementById("balanceDate"),
  checkDate:       document.getElementById("checkDate"),
  endingBalance:   document.getElementById("endingBalance"),
  balanceState:    document.getElementById("balanceState"),
  currentBalance:  document.getElementById("currentBalance"),
  currentBalanceAsOf: document.getElementById("currentBalanceAsOf"),
  billTable:       document.getElementById("billTable"),
  addBill:         document.getElementById("addBill"),
  newName:         document.getElementById("newName"),
  newAmount:       document.getElementById("newAmount"),
  newInterval:     document.getElementById("newInterval"),
  newDueDay:       document.getElementById("newDueDay"),
  newStartDate:    document.getElementById("newStartDate"),
  newType:         document.getElementById("newType"),
  resetBills:      document.getElementById("resetBills"),
  importBills:     document.getElementById("importBills"),
  exportBills:     document.getElementById("exportBills"),
  depositName:     document.getElementById("depositName"),
  depositAmount:   document.getElementById("depositAmount"),
  depositDate:     document.getElementById("depositDate"),
  addDeposit:      document.getElementById("addDeposit"),
  depositTable:    document.getElementById("depositTable"),
  incName:         document.getElementById("incName"),
  incAmount:       document.getElementById("incAmount"),
  incDate:         document.getElementById("incDate"),
  addIncidental:   document.getElementById("addIncidental"),
  incInBalance:    document.getElementById("incInBalance"),
  incidentalGroups:document.getElementById("incidentalGroups"),
  incidentalSummary:document.getElementById("incidentalSummary"),
  loanName:         document.getElementById("loanName"),
  loanAmount:       document.getElementById("loanAmount"),
  loanDate:         document.getElementById("loanDate"),
  loanRepayDate:    document.getElementById("loanRepayDate"),
  addLoan:          document.getElementById("addLoan"),
  loanTable:        document.getElementById("loanTable"),
  loanSummary:      document.getElementById("loanSummary")
};

/* ── Helpers ── */
const toDate = (v) => { const [y,m,d] = v.split("-").map(Number); return new Date(y, m-1, d); };
const getDueDay = (bill) => {
  if (bill.dueDay != null) return bill.dueDay;
  if (bill.startDate) { const d = toDate(bill.startDate); return d.getDate(); }
  return 1;
};
const formatMoney = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/* ── Save / Load using chrome.storage.local ── */
const showToast = (msg) => {
  const toast = document.getElementById("saveToast");
  if (msg) toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 1200);
};

const saveState = () => {
  if (!activeProfile) return;
  const key = storageKeyForProfile(activeProfile);
  const data = JSON.stringify(state);
  chrome.storage.local.set({ [key]: data }, () => {
    showToast('\u2713 Saved');
    window.cloudSync?.saveProfile(activeProfile, data);
  });
};

const saveProfiles = (callback) => {
  chrome.storage.local.set({ [PROFILES_KEY]: JSON.stringify(profiles) }, () => {
    window.cloudSync?.saveProfiles(profiles);
    if (callback) callback();
  });
};

const normalizeBills = () => {
  state.bills = state.bills.map((b) => {
    let paused = !!b.paused;
    if (!paused && b.pausedMonths && b.pausedMonths.length) {
      paused = true;
    }
    let includedInBalance = b.includedInBalance || null;
    if (includedInBalance && includedInBalance !== currentMonthKey()) includedInBalance = null;
    let notInBalance = b.notInBalance || null;
    if (notInBalance && notInBalance !== currentMonthKey()) notInBalance = null;
    const bill = {
      ...b,
      type: b.type === "income" ? "income" : "expense",
      dueDay: b.dueDay != null ? b.dueDay : (b.startDate ? toDate(b.startDate).getDate() : 1),
      startDate: b.startDate || state.balanceDate,
      paused: paused,
      includedInBalance: includedInBalance,
      notInBalance: notInBalance,
      manualPayments: b.manualPayments || []
    };
    delete bill.pausedMonths;
    return bill;
  });
};

const loadState = (callback) => {
  if (!activeProfile) { state = makeDefaultState(); if (callback) callback(); return; }
  const key = storageKeyForProfile(activeProfile);
  chrome.storage.local.get([key], (result) => {
    const saved = result[key];
    if (!saved) { state = makeDefaultState(); if (callback) callback(); return; }
    try {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.bills) {
        state = parsed;
        if (!state.deposits) state.deposits = [];
        if (!state.incidentals) state.incidentals = [];
        if (!state.archivedIncidentals) state.archivedIncidentals = {};
        if (!state.loans) state.loans = [];
        if (!state.funds) state.funds = [];
        normalizeBills();
      } else { state = makeDefaultState(); }
    } catch (e) { state = makeDefaultState(); }
    if (callback) callback();
  });
};

/* ── Occurrences ── */
const getOccurrences = (bill, rangeStart, rangeEnd) => {
  const start = startOfDay(rangeStart), end = startOfDay(rangeEnd);
  if (end < start) return 0;
  if (bill.interval === "monthly") {
    const dueDay = getDueDay(bill);
    let count = 0, cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const limit = new Date(end.getFullYear(), end.getMonth() + 1, 1);
    while (cursor < limit) {
      const last = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0).getDate();
      const dd = new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(dueDay, last));
      if (dd >= start && dd <= end) count++;
      cursor.setMonth(cursor.getMonth()+1);
    }
    return count;
  }
  const intv = bill.interval === "weekly" ? 7 : 14;
  const anchor = bill.startDate ? startOfDay(toDate(bill.startDate)) : start;
  let count = 0;
  if (anchor >= start) {
    let c = new Date(anchor);
    while (c <= end) { if (c >= start) count++; c.setDate(c.getDate()+intv); }
  } else {
    const dMs = start - anchor, dD = Math.floor(dMs/(864e5)), jumps = Math.floor(dD/intv);
    let c = new Date(anchor); c.setDate(c.getDate()+jumps*intv);
    if (c < start) c.setDate(c.getDate()+intv);
    while (c <= end) { count++; c.setDate(c.getDate()+intv); }
  }
  return count;
};

/* ── Check if bill is paused ── */
const isBillPausedForDate = (bill, d) => {
  return !!bill.paused;
};

/* ── Transactions for a day ── */
const getTransactionsForDay = (day) => {
  const d = startOfDay(day), txns = [];
  state.bills.forEach((bill) => {
    const amt = Number(bill.amount || 0);
    if (bill.includedInBalance) {
      const billMonth = `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
      if (bill.includedInBalance === billMonth) return;
    }
    let manualPaidThisPeriod = false;
    if (bill.manualPayments && bill.manualPayments.length) {
      bill.manualPayments.forEach(mp => {
        if (mp.date && d.getTime() === startOfDay(toDate(mp.date)).getTime())
          txns.push({ name: bill.name + " (manual pay)", amount: amt, type: bill.type || "expense" });
      });
      if (bill.interval === "monthly") {
        manualPaidThisPeriod = bill.manualPayments.some(mp => {
          if (!mp.date) return false;
          const mpd = startOfDay(toDate(mp.date));
          return mpd.getFullYear() === d.getFullYear() && mpd.getMonth() === d.getMonth();
        });
      } else if (bill.interval === "weekly" || bill.interval === "biweekly") {
        const intv = bill.interval === "weekly" ? 7 : 14;
        const anchor = bill.startDate ? startOfDay(toDate(bill.startDate)) : startOfDay(toDate(state.balanceDate));
        manualPaidThisPeriod = bill.manualPayments.some(mp => {
          if (!mp.date) return false;
          const mpd = startOfDay(toDate(mp.date));
          const diffMp = Math.round((mpd - anchor) / 864e5);
          const diffD = Math.round((d - anchor) / 864e5);
          if (diffMp < 0 || diffD < 0) return false;
          return Math.floor(diffMp / intv) === Math.floor(diffD / intv);
        });
      }
    }
    if (isBillPausedForDate(bill, d)) return;
    if (manualPaidThisPeriod) return;
    if (bill.interval === "one-time") {
      if (bill.startDate && d.getTime() === startOfDay(toDate(bill.startDate)).getTime())
        txns.push({ name: bill.name, amount: amt, type: bill.type || "expense" });
    } else if (bill.interval === "monthly") {
      if (bill.startDate && d < startOfDay(toDate(bill.startDate))) return;
      const dueDay = getDueDay(bill);
      const last = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate();
      if (d.getDate() === Math.min(dueDay, last))
        txns.push({ name: bill.name, amount: amt, type: bill.type || "expense" });
    } else {
      const intv = bill.interval === "weekly" ? 7 : 14;
      const anchor = bill.startDate ? startOfDay(toDate(bill.startDate)) : d;
      const diff = d - anchor;
      if (diff < 0) return;
      if (Math.round(diff/864e5) % intv === 0)
        txns.push({ name: bill.name, amount: amt, type: bill.type || "expense" });
    }
  });
  (state.deposits || []).forEach((dep) => {
    if (dep.date && d.getTime() === startOfDay(toDate(dep.date)).getTime())
      txns.push({ name: dep.name, amount: Number(dep.amount||0), type: "income" });
  });
  (state.incidentals || []).forEach((inc) => {
    if (inc.inBalance) return;
    if (inc.date && d.getTime() === startOfDay(toDate(inc.date)).getTime())
      txns.push({ name: "\u2022 " + inc.name, amount: Number(inc.amount||0), type: "expense" });
  });
  Object.values(state.archivedIncidentals || {}).forEach(arr => {
    arr.forEach((inc) => {
      if (inc.inBalance) return;
      if (inc.date && d.getTime() === startOfDay(toDate(inc.date)).getTime())
        txns.push({ name: "\u2022 " + inc.name, amount: Number(inc.amount||0), type: "expense" });
    });
  });
  (state.loans || []).forEach((loan) => {
    if (loan.date && d.getTime() === startOfDay(toDate(loan.date)).getTime())
      txns.push({ name: "\uD83D\uDCB0 " + loan.name, amount: Number(loan.amount||0), type: "income" });
    if (loan.repaid && loan.repaidDate && d.getTime() === startOfDay(toDate(loan.repaidDate)).getTime())
      txns.push({ name: "\uD83D\uDCB0 Repay: " + loan.name, amount: Number(loan.amount||0), type: "expense" });
    if (!loan.repaid && !loan.paused && loan.scheduledRepayDate && d.getTime() === startOfDay(toDate(loan.scheduledRepayDate)).getTime())
      txns.push({ name: "\uD83D\uDCB0 Sched. Repay: " + loan.name, amount: Number(loan.amount||0), type: "expense" });
  });
  return txns;
};

/* ── Month key helper ── */
const monthKey = (dateStr) => {
  const [y, m] = dateStr.split("-");
  return `${y}-${m}`;
};
const monthLabel = (key) => {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m)-1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
const currentMonthKey = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad2(n.getMonth()+1)}`;
};

/* ── Archive past-month incidentals ── */
const archiveIncidentals = () => {
  const curKey = currentMonthKey();
  const keep = [], toArchive = {};
  (state.incidentals || []).forEach(inc => {
    const mk = inc.date ? monthKey(inc.date) : curKey;
    if (mk < curKey) {
      if (!toArchive[mk]) toArchive[mk] = [];
      toArchive[mk].push(inc);
    } else {
      keep.push(inc);
    }
  });
  if (Object.keys(toArchive).length) {
    if (!state.archivedIncidentals) state.archivedIncidentals = {};
    Object.entries(toArchive).forEach(([mk, items]) => {
      if (!state.archivedIncidentals[mk]) state.archivedIncidentals[mk] = [];
      state.archivedIncidentals[mk].push(...items);
    });
    state.incidentals = keep;
  }
};

/* ── Render incidentals ── */
const renderIncidentals = () => {
  const container = elements.incidentalGroups;
  container.innerHTML = "";

  const curKey = currentMonthKey();
  const grouped = {};
  (state.incidentals || []).forEach((inc, origIdx) => {
    const mk = inc.date ? monthKey(inc.date) : curKey;
    if (!grouped[mk]) grouped[mk] = [];
    grouped[mk].push({ ...inc, _idx: origIdx });
  });

  const allKeys = new Set([...Object.keys(grouped), ...Object.keys(state.archivedIncidentals || {})]);
  const sortedKeys = [...allKeys].sort().reverse();

  let grandTotal = 0;
  let currentMonthTotal = 0;

  if (!sortedKeys.length) {
    container.innerHTML = '<p class="muted" style="text-align:center">No incidental payments yet.</p>';
    elements.incidentalSummary.style.display = "none";
    return;
  }

  sortedKeys.forEach(mk => {
    const currentItems = grouped[mk] || [];
    const archivedItems = (state.archivedIncidentals || {})[mk] || [];
    const allItems = [...currentItems, ...archivedItems.map((a, ai) => ({ ...a, _archived: true, _archiveMonth: mk, _archIdx: ai }))];
    if (!allItems.length) return;

    const total = allItems.reduce((s, it) => s + Number(it.amount || 0), 0);
    grandTotal += total;
    if (mk === curKey) currentMonthTotal = total;
    const isCurrentMonth = mk === curKey;

    const group = document.createElement("div");
    group.className = "month-group";

    const header = document.createElement("div");
    header.className = `month-header${isCurrentMonth ? "" : " collapsed"}`;
    header.innerHTML = `
      <span>
        <span class="chevron">&#9660;</span>
        ${monthLabel(mk)} (${allItems.length} item${allItems.length!==1?"s":""})
        ${!isCurrentMonth ? '<span class="archived-label">Archived</span>' : ''}
      </span>
      <span class="month-total">-${formatMoney(total)}</span>
    `;

    const body = document.createElement("div");
    body.className = `month-body${isCurrentMonth ? "" : " collapsed"}`;

    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      body.classList.toggle("collapsed");
    });

    const tbl = document.createElement("table");
    tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:13px;margin:0";
    tbl.innerHTML = '<thead><tr><th style="padding:6px 8px">Description</th><th style="padding:6px 8px">Amount</th><th style="padding:6px 8px">Date</th><th style="padding:6px 8px"></th></tr></thead>';
    const tbody = document.createElement("tbody");

    allItems.forEach(it => {
      const tr = document.createElement("tr");
      const dd = it.date ? new Date(it.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "\u2014";
      const inBalBadge = it.inBalance ? ' <span class="in-balance-badge" title="Already reflected in current balance \u2014 not subtracted again">In balance</span>' : '';
      const amountColor = it.inBalance ? 'var(--muted)' : 'var(--danger)';
      const amountStyle = it.inBalance ? 'text-decoration:line-through;' : '';
      let actions = '';
      if (!it._archived) {
        actions = `<button class="secondary" data-action="edit-inc" data-index="${it._idx}" style="width:auto;display:inline-block;margin-right:4px">Edit</button><button class="danger" data-action="remove-inc" data-index="${it._idx}" style="width:auto;display:inline-block;margin-right:4px">Remove</button><button class="secondary" data-action="archive-inc" data-index="${it._idx}" style="width:auto;display:inline-block">Archive</button>`;
      } else {
        actions = `<button class="secondary" data-action="edit-archived-inc" data-month="${it._archiveMonth}" data-index="${it._archIdx}" style="width:auto;display:inline-block;margin-right:4px">Edit</button><button class="danger" data-action="remove-archived-inc" data-month="${it._archiveMonth}" data-index="${it._archIdx}" style="width:auto;display:inline-block;margin-right:4px">Remove</button><button class="secondary" data-action="unarchive-inc" data-month="${it._archiveMonth}" data-index="${it._archIdx}" style="width:auto;display:inline-block">Unarchive</button>`;
      }
      tr.innerHTML = `
        <td style="padding:4px 8px">${it.name}${inBalBadge}</td>
        <td style="padding:4px 8px;color:${amountColor};${amountStyle}" data-cell="amount">-${formatMoney(Number(it.amount||0))}</td>
        <td style="padding:4px 8px" data-cell="date">${dd}</td>
        <td style="padding:4px 8px;white-space:nowrap">${actions}</td>
      `;
      tbody.appendChild(tr);
    });

    tbl.appendChild(tbody);
    const tblWrap = document.createElement("div");
    tblWrap.style.overflowX = "auto";
    tblWrap.appendChild(tbl);
    body.appendChild(tblWrap);
    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);
  });

  const sumEl = elements.incidentalSummary;
  sumEl.style.display = "flex";
  sumEl.innerHTML = `
    <span><strong>This month:</strong> <span style="color:var(--danger)">-${formatMoney(currentMonthTotal)}</span></span>
    <span><strong>All time:</strong> <span style="color:var(--danger)">-${formatMoney(grandTotal)}</span></span>
  `;
};

/* ── Render deposits ── */
const renderDeposits = () => {
  elements.depositTable.innerHTML = "";
  if (!state.deposits || !state.deposits.length) {
    elements.depositTable.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center">No deposits added yet.</td></tr>';
    return;
  }
  state.deposits.forEach((dep, i) => {
    const row = document.createElement("tr");
    const dd = dep.date ? new Date(dep.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "\u2014";
    row.innerHTML = `
      <td>${dep.name}</td>
      <td>${formatMoney(Number(dep.amount||0))}</td>
      <td>${dd}</td>
      <td style="white-space:nowrap">
        <button class="danger" data-action="remove-deposit" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Remove</button>
        <button class="secondary" data-action="cancel-deposit" data-index="${i}" style="width:auto;display:inline-block">Cancel</button>
      </td>`;
    elements.depositTable.appendChild(row);
  });
};

/* ── Render loans ── */
const renderLoans = () => {
  elements.loanTable.innerHTML = "";
  if (!state.loans || !state.loans.length) {
    elements.loanTable.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center">No loans yet. Pull money from another account and track it here.</td></tr>';
    elements.loanSummary.style.display = "none";
    return;
  }
  let totalOutstanding = 0, totalRepaid = 0, totalPaused = 0;
  const todayD = startOfDay(new Date());
  state.loans.forEach((loan, i) => {
    if (loan.repaid) totalRepaid += Number(loan.amount || 0);
    else if (loan.paused) totalPaused += Number(loan.amount || 0);
    else totalOutstanding += Number(loan.amount || 0);

    const row = document.createElement("tr");
    const dd = loan.date ? new Date(loan.date+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "\u2014";

    const schedDate = loan.scheduledRepayDate
      ? new Date(loan.scheduledRepayDate+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})
      : null;
    const isOverdue = !loan.repaid && !loan.paused && loan.scheduledRepayDate && startOfDay(toDate(loan.scheduledRepayDate)) < todayD;
    const isDueToday = !loan.repaid && !loan.paused && loan.scheduledRepayDate && startOfDay(toDate(loan.scheduledRepayDate)).getTime() === todayD.getTime();
    let schedHtml = '';
    if (loan.repaid) {
      schedHtml = schedDate ? `<span class="muted">${schedDate}</span>` : '\u2014';
    } else {
      schedHtml = `<input type="date" data-action="edit-sched" data-index="${i}" value="${loan.scheduledRepayDate || ''}" style="width:140px" />`;
      if (isOverdue) schedHtml += ' <span style="color:#dc2626;font-weight:600;font-size:11px">OVERDUE</span>';
      else if (isDueToday) schedHtml += ' <span style="color:#f59e0b;font-weight:600;font-size:11px">DUE TODAY</span>';
    }

    let statusHtml;
    if (loan.repaid) {
      statusHtml = `<span style="color:#16a34a;font-weight:600">\u2713 Repaid${loan.repaidDate ? ' ' + new Date(loan.repaidDate+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}) : ''}</span>`;
    } else if (loan.paused) {
      statusHtml = '<span class="pause-badge">Paused</span>';
    } else if (isOverdue) {
      statusHtml = '<span style="color:#dc2626;font-weight:600">Outstanding</span>';
    } else if (isDueToday) {
      statusHtml = '<span style="color:#f59e0b;font-weight:600">Due Today</span>';
    } else if (loan.scheduledRepayDate) {
      statusHtml = '<span style="color:#2563eb;font-weight:600">Scheduled</span>';
    } else {
      statusHtml = '<span style="color:#dc2626;font-weight:600">Outstanding</span>';
    }

    let actionsHtml = '';
    if (loan.repaid) {
      actionsHtml = `<button class="secondary" data-action="unrepay-loan" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Undo Repay</button>`;
    } else {
      actionsHtml += `<button class="pay-today" data-action="repay-loan" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Mark Repaid</button>`;
      actionsHtml += `<button class="${loan.paused ? 'secondary' : 'warn'}" data-action="toggle-pause-loan" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">${loan.paused ? 'Resume' : 'Pause'}</button>`;
    }
    actionsHtml += `<button class="danger" data-action="delete-loan" data-index="${i}" style="width:auto;display:inline-block">Delete</button>`;

    if (loan.paused) { row.className = "row-paused"; }
    else if (loan.repaid) { row.className = "row-paid"; }
    else if (isDueToday) { row.className = "row-today"; }

    row.innerHTML = `
      <td>${isDueToday && !loan.paused ? '<span class="today-arrow">\u25B6</span>' : ''}${loan.name}</td>
      <td><input type="number" step="0.01" data-action="edit-amount" data-index="${i}" value="${loan.amount}" style="width:90px" /></td>
      <td>${dd}</td>
      <td>${schedHtml}</td>
      <td>${statusHtml}</td>
      <td style="white-space:nowrap">${actionsHtml}</td>`;
    elements.loanTable.appendChild(row);
  });
  const sumEl = elements.loanSummary;
  sumEl.style.display = "flex";
  sumEl.innerHTML = `
    <span><strong>Outstanding:</strong> <span style="color:var(--danger)">${formatMoney(totalOutstanding)}</span></span>
    ${totalPaused ? `<span><strong>Paused:</strong> <span style="color:#92400e">${formatMoney(totalPaused)}</span></span>` : ''}
    <span><strong>Repaid:</strong> <span style="color:#16a34a">${formatMoney(totalRepaid)}</span></span>
    <span><strong>Total borrowed:</strong> ${formatMoney(totalOutstanding + totalRepaid + totalPaused)}</span>
  `;
};

/* ── Current balance: starting balance + transactions through today ── */
const calculateCurrentBalance = () => {
  const today = startOfDay(new Date());
  const balStart = startOfDay(toDate(state.balanceDate));
  let bal = Number(state.startingBalance || 0);
  const walker = new Date(balStart);
  while (walker <= today) {
    const txns = getTransactionsForDay(walker);
    txns.forEach(t => { bal += t.type === 'income' ? t.amount : -t.amount; });
    walker.setDate(walker.getDate() + 1);
  }
  if (elements.currentBalance) {
    elements.currentBalance.textContent = formatMoney(bal);
    elements.currentBalance.className = bal >= 0 ? 'positive' : 'negative';
  }
  if (elements.currentBalanceAsOf) {
    const ds = today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    elements.currentBalanceAsOf.textContent = `(as of ${ds})`;
  }
  return bal;
};

/* ── Calculate ending balance + bills summary ── */
const calculateEndingBalance = () => {
  calculateCurrentBalance();
  const balance = Number(state.startingBalance||0);
  const bd = toDate(state.balanceDate), cd = toDate(state.checkDate);
  let running = balance;
  const cursor = new Date(bd);
  while (cursor <= cd) {
    const txns = getTransactionsForDay(cursor);
    txns.forEach(t => { running += t.type==="income" ? t.amount : -t.amount; });
    cursor.setDate(cursor.getDate()+1);
  }
  elements.endingBalance.textContent = formatMoney(running);
  elements.balanceState.textContent = running >= 0 ? "Positive" : "Negative";
  elements.balanceState.className = `tag ${running >= 0 ? "positive" : "negative"}`;

  /* Bills summary: incidentals shown for full [balanceDate, checkDate]; recurring bills from today only */
  const summaryDiv = document.getElementById("billsSummary");
  const todayLocal = startOfDay(new Date());
  const items = [];
  let totalExp = 0, totalInc = 0;

  let runBal = Number(state.startingBalance || 0);
  const balStart = startOfDay(toDate(state.balanceDate));
  const sc = new Date(balStart);
  while (sc <= cd) {
    const txns = getTransactionsForDay(sc);
    const ds = sc.toLocaleDateString("en-US", {month:"short", day:"numeric"});
    const isPast = sc < todayLocal;
    txns.forEach(t => {
      runBal += t.type === 'income' ? t.amount : -t.amount;
      const isIncidental = t.name.startsWith('• ');
      if (!isPast || isIncidental) {
        items.push({ date: ds, name: t.name, amount: t.amount, type: t.type, balance: runBal, isPast });
        if (!isPast) {
          if (t.type === 'income') totalInc += t.amount; else totalExp += t.amount;
        }
      }
    });
    sc.setDate(sc.getDate() + 1);
  }
  if (items.length) {
    let html = '<h4 style="margin:0 0 8px">Bills &amp; Incidentals &#8594; Check Date</h4>';
    html += '<div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    html += '<thead><tr><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Date</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Item</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">Amount</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">Balance</th></tr></thead><tbody>';
    items.forEach(it => {
      const color = it.type === "income" ? "#16a34a" : "#dc2626";
      const sign = it.type === "income" ? "+" : "-";
      const balColor = it.balance >= 0 ? "#16a34a" : "#dc2626";
      const rowStyle = it.isPast ? 'opacity:0.75;background:var(--surface-2,#f9f9f9)' : '';
      html += `<tr style="${rowStyle}"><td style="padding:4px 8px">${it.date}</td><td style="padding:4px 8px">${it.name}</td><td style="padding:4px 8px;text-align:right;color:${color}">${sign}${formatMoney(it.amount)}</td><td style="padding:4px 8px;text-align:right;font-weight:600;color:${balColor}">${formatMoney(it.balance)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    const totalIncWithBalance = totalInc + Number(state.startingBalance || 0);
    html += '<div style="margin-top:8px;font-size:13px;display:flex;gap:16px;flex-wrap:wrap">';
    html += `<span style="color:#dc2626">Upcoming expenses: -${formatMoney(totalExp)}</span>`;
    html += `<span style="color:#16a34a">Income (incl. balance): +${formatMoney(totalIncWithBalance)}</span>`;
    html += `<strong>Net: ${formatMoney(totalIncWithBalance - totalExp)}</strong>`;
    html += '</div>';
    summaryDiv.innerHTML = html;
  } else {
    summaryDiv.innerHTML = '<p class="muted" style="margin-top:8px">No bills or incidentals in range.</p>';
  }
  if (typeof renderMonthlyExpenseSummary === 'function') renderMonthlyExpenseSummary();
  if (typeof renderMonthlyBreakdown === 'function') renderMonthlyBreakdown();
};

/* ── Check if a bill has already come out this month ── */
const hasBillPaidThisMonth = (bill) => {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const monthStart = new Date(y, m, 1);
  const todayEnd = startOfDay(now);

  if (bill.interval === 'monthly') {
    const dueDay = getDueDay(bill);
    const lastDay = new Date(y, m + 1, 0).getDate();
    const dueDate = new Date(y, m, Math.min(dueDay, lastDay));
    return dueDate <= todayEnd;
  }
  if (bill.interval === 'one-time') {
    if (!bill.startDate) return false;
    const d = startOfDay(toDate(bill.startDate));
    return d >= monthStart && d <= todayEnd;
  }
  const intv = bill.interval === 'weekly' ? 7 : 14;
  const anchor = bill.startDate ? startOfDay(toDate(bill.startDate)) : monthStart;
  let c;
  if (anchor >= monthStart) {
    c = new Date(anchor);
  } else {
    const dMs = monthStart - anchor, dD = Math.floor(dMs / 864e5), jumps = Math.floor(dD / intv);
    c = new Date(anchor); c.setDate(c.getDate() + jumps * intv);
    if (c < monthStart) c.setDate(c.getDate() + intv);
  }
  while (c <= todayEnd) {
    if (c >= monthStart) return true;
    c.setDate(c.getDate() + intv);
  }
  return false;
};

/* ── Get effective sort day for a bill ── */
const billSortDay = (bill) => {
  return getDueDay(bill);
};

/* ── Check if a bill is due today ── */
const isBillDueToday = (bill) => {
  const now = new Date(), todayD = now.getDate(), y = now.getFullYear(), m = now.getMonth();
  if (bill.interval === 'monthly') {
    const dueDay = getDueDay(bill);
    const lastDay = new Date(y, m + 1, 0).getDate();
    return todayD === Math.min(dueDay, lastDay);
  }
  if (bill.interval === 'one-time' && bill.startDate) {
    return startOfDay(toDate(bill.startDate)).getTime() === startOfDay(now).getTime();
  }
  const intv = bill.interval === 'weekly' ? 7 : 14;
  const anchor = bill.startDate ? startOfDay(toDate(bill.startDate)) : startOfDay(now);
  const diff = startOfDay(now) - anchor;
  if (diff < 0) return false;
  return Math.round(diff / 864e5) % intv === 0;
};

/* ── Render bills ── */
const renderBills = () => {
  elements.billTable.innerHTML = "";
  const indexed = state.bills.map((bill, i) => ({ bill, i }));
  indexed.sort((a, b) => billSortDay(a.bill) - billSortDay(b.bill));

  indexed.forEach(({ bill, i }) => {
    const isPaused = !!bill.paused;
    const isNotInBal = bill.notInBalance === currentMonthKey();
    const isPaid = !isPaused && !isNotInBal && hasBillPaidThisMonth(bill);
    const isPastDue = !isPaused && isNotInBal && hasBillPaidThisMonth(bill);
    const isToday = isBillDueToday(bill);
    const hasManualPayThisMonth = bill.manualPayments && bill.manualPayments.some(mp => {
      if (!mp.date) return false;
      const mpd = toDate(mp.date);
      const now = new Date();
      return mpd.getFullYear() === now.getFullYear() && mpd.getMonth() === now.getMonth();
    });
    const hasManualPayToday = bill.manualPayments && bill.manualPayments.some(mp => mp.date === todayIso);
    const isInBal = bill.includedInBalance === currentMonthKey();
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${isToday ? '<span class="today-arrow">\u25B6</span>' : ''}<input type="text" data-field="name" data-index="${i}" value="${bill.name}" style="width:${isToday ? 'calc(100% - 22px)' : '100%'};display:inline-block" />${bill.debtId ? '<span class="pause-badge" style="background:#4f46e5;color:#fff">Linked</span>' : ''}${isPaused ? '<span class="pause-badge">Paused</span>' : ''}${isPastDue ? '<span class="past-due-badge">Past Due</span>' : ''}${isPaid ? '<span class="paid-badge">&check; Paid</span>' : ''}${hasManualPayToday ? '<span class="paid-badge">&check; Paid Today</span>' : ''}${isInBal ? '<span class="paid-badge" style="background:#dbeafe;color:#1d4ed8">In Balance</span>' : ''}</td>
      <td><input type="number" step="0.01" data-field="amount" data-index="${i}" value="${bill.amount}" style="width:90px" /></td>
      <td>
        <select data-field="interval" data-index="${i}" style="width:100px">
          <option value="monthly" ${bill.interval==="monthly"?"selected":""}>Monthly</option>
          <option value="weekly" ${bill.interval==="weekly"?"selected":""}>Weekly</option>
          <option value="biweekly" ${bill.interval==="biweekly"?"selected":""}>Biweekly</option>
          <option value="one-time" ${bill.interval==="one-time"?"selected":""}>One-time</option>
        </select>
      </td>
      <td><input type="number" min="1" max="31" data-field="dueDay" data-index="${i}" value="${getDueDay(bill)}" style="width:60px" /></td>
      <td><input type="date" data-field="startDate" data-index="${i}" value="${bill.startDate??state.balanceDate}" style="width:140px" /></td>
      <td>
        <select data-field="type" data-index="${i}">
          <option value="expense" ${bill.type!=="income"?"selected":""}>Expense</option>
          <option value="income" ${bill.type==="income"?"selected":""}>Income</option>
        </select>
      </td>
      <td style="white-space:nowrap">
        <button class="danger" data-action="delete" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Remove</button>
        ${bill.interval==="one-time"?`<button class="secondary" data-action="cancel" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Cancel</button>`:""}
        ${bill.interval!=="one-time"?`<button class="pay-today" data-action="pay-today" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px"${hasManualPayToday?' disabled':''}>Pay Today</button>`:""}
        ${hasManualPayThisMonth?`<button class="danger" data-action="undo-pay" data-index="${i}" style="width:auto;display:inline-block;margin-right:4px">Undo Pay</button>`:""}
        ${bill.interval!=="one-time"?`<button class="${isPaused?'secondary':'warn'}" data-action="toggle-pause" data-index="${i}" style="width:auto;display:inline-block">${isPaused?'Resume':'Pause'}</button>`:""}
        <button class="${isInBal?'secondary':''}" data-action="toggle-in-balance" data-index="${i}" style="width:auto;display:inline-block;margin-left:4px;${isInBal?'background:#1d4ed8;color:#fff':''}">In Balance</button>
        ${(isPaid || isPastDue) ? `<button class="${isNotInBal?'':'secondary'}" data-action="toggle-not-in-balance" data-index="${i}" style="width:auto;display:inline-block;margin-left:4px;${isNotInBal?'background:#dc2626;color:#fff':''}">Not In Balance</button>` : ''}
      </td>`;
    if (isPaused) row.className = "row-paused";
    else if (isPastDue) row.className = "row-past-due";
    else if (isToday) row.className = "row-today" + (isPaid ? " row-paid" : "");
    else if (isPaid) row.className = "row-paid";
    elements.billTable.appendChild(row);
  });
};

/* ── Render paused bills section ── */
const renderPausedBills = () => {
  const card = document.getElementById('pausedBillsCard');
  const tbody = document.getElementById('pausedBillTable');
  const paused = [];
  state.bills.forEach((bill, i) => { if (bill.paused) paused.push({ bill, i }); });
  if (!paused.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  tbody.innerHTML = '';
  paused.forEach(({ bill, i }) => {
    const tr = document.createElement('tr');
    tr.className = 'row-paused';
    tr.innerHTML = `
      <td>${bill.name}</td>
      <td>${formatMoney(Number(bill.amount || 0))}</td>
      <td>${bill.interval}</td>
      <td>${bill.type}</td>
      <td style="white-space:nowrap">
        <button class="secondary" data-action="resume-paused" data-index="${i}" style="width:auto;display:inline-block">Resume</button>
      </td>`;
    tbody.appendChild(tr);
  });
};

/* ── Events: resume from paused section ── */
document.getElementById('pausedBillTable').addEventListener('click', (e) => {
  if (e.target.dataset.action !== 'resume-paused') return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  bill.paused = false;
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Sync UI from state ── */
const syncInputs = () => {
  elements.startingBalance.value = state.startingBalance;
  elements.balanceDate.value = state.balanceDate;
  elements.checkDate.value = state.checkDate;
  elements.newStartDate.value = state.balanceDate;
  elements.depositDate.value = state.balanceDate;
  elements.incDate.value = todayIso;
  elements.loanDate.value = todayIso;
};

const updateBillField = (i, field, value) => {
  const b = state.bills[i]; if (!b) return;
  if (field==="amount" || field==="dueDay") b[field]=Number(value); else b[field]=value;
};

/* ── Monthly negative balance alert ── */
const renderNegativeAlert = () => {
  const card = document.getElementById('negativeAlertCard');
  const content = document.getElementById('negativeAlertContent');
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const monthStart = new Date(y, m, 1);
  const monthEnd = new Date(y, m + 1, 0);

  let running = Number(state.startingBalance || 0);
  const balD = startOfDay(toDate(state.balanceDate));
  const walkStart = new Date(balD);

  if (walkStart < monthStart) {
    const cursor2 = new Date(walkStart);
    while (cursor2 < monthStart) {
      const txns = getTransactionsForDay(cursor2);
      txns.forEach(t => { running += t.type === 'income' ? t.amount : -t.amount; });
      cursor2.setDate(cursor2.getDate() + 1);
    }
  }

  const scanFrom = walkStart > monthStart ? new Date(walkStart) : new Date(monthStart);
  const negDays = [];
  const cursor2 = new Date(scanFrom);
  while (cursor2 <= monthEnd) {
    const txns = getTransactionsForDay(cursor2);
    let dayLowest = running;
    txns.forEach(t => {
      const amt = t.type === 'income' ? t.amount : -t.amount;
      running += amt;
      if (running < dayLowest) dayLowest = running;
    });
    if (dayLowest < 0 || running < 0) {
      negDays.push({
        date: cursor2.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        balance: dayLowest < running ? dayLowest : running,
        txns
      });
    }
    cursor2.setDate(cursor2.getDate() + 1);
  }

  if (!negDays.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  const monthName = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const lowestDay = negDays.reduce((a, b) => a.balance < b.balance ? a : b);
  let html = `<div class="warning-banner" style="margin-top:0">`;
  html += `<strong>&#9888; Your balance will go negative on ${negDays.length} day(s) in ${monthName}.</strong><br/>`;
  html += `First negative day: <strong>${negDays[0].date}</strong> (${formatMoney(negDays[0].balance)})<br/>`;
  html += `Lowest point: <strong>${lowestDay.date}</strong> at <strong>${formatMoney(lowestDay.balance)}</strong>`;
  html += `</div>`;
  html += '<div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:10px">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<thead><tr><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Date</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Transactions</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">Balance</th></tr></thead><tbody>';
  negDays.forEach(nd => {
    const txT = nd.txns.map(t => `${t.type==='income'?'+':'-'}$${t.amount.toFixed(2)} ${t.name}`).join(', ');
    html += `<tr style="background:#fef2f2"><td style="padding:4px 8px;color:#991b1b">${nd.date}</td><td style="padding:4px 8px;color:#991b1b">${txT || '\u2014'}</td><td style="padding:4px 8px;text-align:right;font-weight:700;color:#dc2626">${formatMoney(nd.balance)}</td></tr>`;
  });
  html += '</tbody></table></div>';
  content.innerHTML = html;
};

/* ── Monthly expense summary ── */
const expenseMonthInput = document.getElementById('expenseMonth');
{
  const now = new Date();
  expenseMonthInput.value = `${now.getFullYear()}-${pad2(now.getMonth()+1)}`;
}
expenseMonthInput.addEventListener('change', () => { renderMonthlyExpenseSummary(); });

const renderMonthlyExpenseSummary = () => {
  const content = document.getElementById('monthlyExpenseContent');
  const val = expenseMonthInput.value;
  let y, m;
  if (val && /^\d{4}-\d{2}$/.test(val)) {
    [y, m] = val.split('-').map(Number);
    m = m - 1;
  } else {
    const now = new Date();
    y = now.getFullYear(); m = now.getMonth();
  }
  const monthStart = new Date(y, m, 1);
  const monthEnd = new Date(y, m + 1, 0);
  const monthName = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const items = [];
  let totalExpense = 0, totalIncome = 0;
  const cursor = new Date(monthStart);
  while (cursor <= monthEnd) {
    const txns = getTransactionsForDay(cursor);
    txns.forEach(t => {
      const ds = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      items.push({ date: ds, rawDate: new Date(cursor), name: t.name, amount: t.amount, type: t.type });
      if (t.type === 'income') totalIncome += t.amount; else totalExpense += t.amount;
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  let runBal = Number(state.startingBalance || 0);
  const balStart = startOfDay(toDate(state.balanceDate));
  const walkStart2 = new Date(balStart);

  if (walkStart2 < monthStart) {
    const pre = new Date(walkStart2);
    while (pre < monthStart) {
      const preTxns = getTransactionsForDay(pre);
      preTxns.forEach(t => { runBal += t.type === 'income' ? t.amount : -t.amount; });
      pre.setDate(pre.getDate() + 1);
    }
  }

  const openingBalance = runBal;
  const trackFrom = walkStart2 > monthStart ? new Date(walkStart2) : new Date(monthStart);
  let lowestBal = runBal, lowestDate = trackFrom;
  const dayCursor = new Date(trackFrom);
  while (dayCursor <= monthEnd) {
    const dayTxns = getTransactionsForDay(dayCursor);
    dayTxns.forEach(t => {
      runBal += t.type === 'income' ? t.amount : -t.amount;
      if (runBal < lowestBal) {
        lowestBal = runBal;
        lowestDate = new Date(dayCursor);
      }
    });
    dayCursor.setDate(dayCursor.getDate() + 1);
  }
  const closingBalance = runBal;

  if (!items.length) {
    content.innerHTML = '<p class="muted" style="text-align:center">No bills or income this month.</p>';
    return;
  }

  let html = '';
  const lowColor = lowestBal < 0 ? '#dc2626' : '#f59e0b';
  const lowBg = lowestBal < 0 ? '#fef2f2' : '#fffbeb';
  const lowBorder = lowestBal < 0 ? '#fecaca' : '#fde68a';
  const lowIcon = lowestBal < 0 ? '\u26a0' : '\u{1f4c9}';
  const lowDateStr = lowestDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  html += `<div style="background:${lowBg};border:1px solid ${lowBorder};border-radius:8px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">`;
  html += `<span style="font-size:20px">${lowIcon}</span>`;
  html += `<div style="flex:1;min-width:200px">`;
  html += `<div style="font-weight:700;color:${lowColor};font-size:15px">Lowest Balance: ${formatMoney(lowestBal)}</div>`;
  html += `<div style="font-size:12px;color:var(--muted)">Hits on ${lowDateStr}</div>`;
  html += `</div>`;
  html += `<div style="text-align:right;font-size:13px">`;
  html += `<div>Opening: <strong>${formatMoney(openingBalance)}</strong></div>`;
  html += `<div>Closing: <strong style="color:${closingBalance < 0 ? '#dc2626' : '#16a34a'}">${formatMoney(closingBalance)}</strong></div>`;
  html += `</div>`;
  html += `</div>`;

  html += '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:14px">';
  html += `<span style="color:#dc2626"><strong>Total Expenses:</strong> -${formatMoney(totalExpense)}</span>`;
  html += `<span style="color:#16a34a"><strong>Total Income:</strong> +${formatMoney(totalIncome)}</span>`;
  html += `<strong>Net: ${formatMoney(totalIncome - totalExpense)}</strong>`;
  html += `<span class="muted">${items.length} transaction${items.length !== 1 ? 's' : ''} in ${monthName}</span>`;
  html += '</div>';
  html += '<div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<thead><tr><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Date</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted)">Description</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">Amount</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted)">Balance</th></tr></thead><tbody>';
  const todayMs = startOfDay(new Date()).getTime();
  let lastPaidIdx = -1;
  items.forEach((it, i) => { if (startOfDay(it.rawDate).getTime() <= todayMs) lastPaidIdx = i; });

  let rowBal = openingBalance;
  const balDateMs = startOfDay(toDate(state.balanceDate)).getTime();
  items.forEach((it, i) => {
    const color = it.type === 'income' ? '#16a34a' : '#dc2626';
    const sign = it.type === 'income' ? '+' : '-';
    const itemMs = startOfDay(it.rawDate).getTime();
    const isBeforeBalance = itemMs <= balDateMs;
    if (!isBeforeBalance) {
      rowBal += it.type === 'income' ? it.amount : -it.amount;
    }
    const balText = isBeforeBalance ? '\u2014' : formatMoney(rowBal);
    const balColor = isBeforeBalance ? 'var(--muted)' : (rowBal < 0 ? '#dc2626' : '#16a34a');
    const isLastPaid = i === lastPaidIdx;
    const rowStyle = isLastPaid ? 'background:#dbeafe;border-left:4px solid #2563eb' : '';
    html += `<tr style="${rowStyle}"><td style="padding:4px 8px">${isLastPaid ? '<span style="color:#2563eb;font-weight:700;margin-right:4px">&#9658;</span>' : ''}${it.date}</td><td style="padding:4px 8px">${it.name}</td><td style="padding:4px 8px;text-align:right;color:${color}">${sign}${formatMoney(it.amount)}</td><td style="padding:4px 8px;text-align:right;font-weight:600;color:${balColor}">${balText}</td></tr>`;
  });
  html += '</tbody></table></div>';
  content.innerHTML = html;
};

/* ── Monthly breakdown (income / expense / ending balance per month) ── */
const breakdownMonthsInput = document.getElementById('breakdownMonths');
const toggleBreakdownBtn = document.getElementById('toggleBreakdown');
const breakdownContent = document.getElementById('monthlyBreakdownContent');
const BREAKDOWN_HIDDEN_KEY = 'budgetPlanner.breakdownHidden';
const BREAKDOWN_MONTHS_KEY = 'budgetPlanner.breakdownMonths';

{
  const savedMonths = localStorage.getItem(BREAKDOWN_MONTHS_KEY);
  if (savedMonths && breakdownMonthsInput.querySelector(`option[value="${savedMonths}"]`)) {
    breakdownMonthsInput.value = savedMonths;
  }
  if (localStorage.getItem(BREAKDOWN_HIDDEN_KEY) === null) {
    localStorage.setItem(BREAKDOWN_HIDDEN_KEY, '1');
  }
}

const applyBreakdownVisibility = () => {
  const hidden = localStorage.getItem(BREAKDOWN_HIDDEN_KEY) === '1';
  breakdownContent.style.display = hidden ? 'none' : '';
  toggleBreakdownBtn.textContent = hidden ? 'Show' : 'Hide';
};

toggleBreakdownBtn.addEventListener('click', () => {
  const hidden = localStorage.getItem(BREAKDOWN_HIDDEN_KEY) === '1';
  const newVal = hidden ? '0' : '1';
  localStorage.setItem(BREAKDOWN_HIDDEN_KEY, newVal);
  window.cloudSync?.saveSetting(BREAKDOWN_HIDDEN_KEY, newVal);
  applyBreakdownVisibility();
  if (hidden) renderMonthlyBreakdown();
});

breakdownMonthsInput.addEventListener('change', () => {
  localStorage.setItem(BREAKDOWN_MONTHS_KEY, breakdownMonthsInput.value);
  window.cloudSync?.saveSetting(BREAKDOWN_MONTHS_KEY, breakdownMonthsInput.value);
  renderMonthlyBreakdown();
});

const renderMonthlyBreakdown = () => {
  applyBreakdownVisibility();
  const monthCount = Number(breakdownMonthsInput.value || 12);
  const startingBalance = Number(state.startingBalance || 0);
  const balStart = startOfDay(toDate(state.balanceDate));

  const firstMonth = new Date(balStart.getFullYear(), balStart.getMonth(), 1);
  const lastMonth = new Date(balStart.getFullYear(), balStart.getMonth() + monthCount - 1, 1);
  const finalDay = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0);

  let runBal = startingBalance;
  let preBalanceNet = 0;
  const months = [];
  let currentMonthIdx = -1;

  const cursor = new Date(firstMonth);
  while (cursor <= finalDay) {
    const monthKeyStr = `${cursor.getFullYear()}-${pad2(cursor.getMonth()+1)}`;
    if (currentMonthIdx === -1 || months[currentMonthIdx].key !== monthKeyStr) {
      months.push({
        key: monthKeyStr,
        date: new Date(cursor.getFullYear(), cursor.getMonth(), 1),
        income: 0,
        expense: 0,
        opening: runBal,
        ending: runBal,
        impliedOpening: false,
      });
      currentMonthIdx = months.length - 1;
    }
    const txns = getTransactionsForDay(cursor);
    const isPostBalance = cursor >= balStart;
    if (!months[currentMonthIdx].txns) months[currentMonthIdx].txns = [];
    txns.forEach(t => {
      months[currentMonthIdx].txns.push({ date: new Date(cursor), ...t, isPostBalance });
      if (t.type === 'income') {
        months[currentMonthIdx].income += t.amount;
        if (isPostBalance) runBal += t.amount;
        else if (currentMonthIdx === 0) preBalanceNet += t.amount;
      } else {
        months[currentMonthIdx].expense += t.amount;
        if (isPostBalance) runBal -= t.amount;
        else if (currentMonthIdx === 0) preBalanceNet -= t.amount;
      }
    });
    months[currentMonthIdx].ending = runBal;
    cursor.setDate(cursor.getDate() + 1);
  }

  if (months.length) {
    months[0].opening = startingBalance - preBalanceNet;
    months[0].impliedOpening = preBalanceNet !== 0;
    for (let i = 1; i < months.length; i++) {
      months[i].opening = months[i - 1].ending;
    }
  }

  const todayKey = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${pad2(t.getMonth()+1)}`;
  })();

  let html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<thead><tr>';
  html += '<th style="padding:8px;text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase">Month</th>';
  html += '<th style="padding:8px;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase">Opening</th>';
  html += '<th style="padding:8px;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase">Income</th>';
  html += '<th style="padding:8px;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase">Expenses</th>';
  html += '<th style="padding:8px;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase">Ending</th>';
  html += '<th style="padding:8px;text-align:right;font-size:11px;color:var(--muted);text-transform:uppercase" title="Income minus expenses for this month only — money left over after paying this month\'s bills">Free</th>';
  html += '</tr></thead><tbody>';

  let totalIncome = 0, totalExpense = 0;
  months.forEach((mo, idx) => {
    totalIncome += mo.income;
    totalExpense += mo.expense;
    const nextMo = idx + 1 < months.length ? months[idx + 1] : null;
    const free = nextMo ? mo.ending + nextMo.income - nextMo.expense : mo.ending;
    const endColor = mo.ending < 0 ? '#dc2626' : '#16a34a';
    const freeColor = free < 0 ? '#dc2626' : (free > 0 ? '#16a34a' : 'var(--muted)');
    const isCurrent = mo.key === todayKey;
    const rowStyle = isCurrent ? 'background:#dbeafe;border-left:4px solid #2563eb' : (mo.ending < 0 ? 'background:#fef2f2' : '');
    const monthName = mo.date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    html += `<tr style="${rowStyle}">`;
    html += `<td style="padding:8px;border-bottom:1px solid var(--border)">${isCurrent ? '<span style="color:#2563eb;font-weight:700;margin-right:4px">&#9658;</span>' : ''}${monthName}</td>`;
    const openingMark = mo.impliedOpening ? '<sup style="color:var(--muted);font-weight:400" title="Implied — your balance was recorded mid-month">*</sup>' : '';
    html += `<td style="padding:8px;text-align:right;border-bottom:1px solid var(--border)">${formatMoney(mo.opening)}${openingMark}</td>`;
    html += `<td style="padding:8px;text-align:right;color:#16a34a;border-bottom:1px solid var(--border)">${mo.income > 0 ? '+' + formatMoney(mo.income) : formatMoney(0)}</td>`;
    html += `<td style="padding:8px;text-align:right;color:#dc2626;border-bottom:1px solid var(--border)">${mo.expense > 0 ? '-' + formatMoney(mo.expense) : formatMoney(0)}</td>`;
    html += `<td style="padding:8px;text-align:right;color:${endColor};font-weight:700;border-bottom:1px solid var(--border)">${formatMoney(mo.ending)}</td>`;
    html += `<td style="padding:8px;text-align:right;color:${freeColor};font-weight:700;border-bottom:1px solid var(--border)">${free >= 0 ? '+' : ''}${formatMoney(free)}</td>`;
    html += '</tr>';
  });

  const totalFree = totalIncome - totalExpense;
  const totalFreeColor = totalFree < 0 ? '#dc2626' : '#16a34a';
  const finalEnd = months.length ? months[months.length - 1].ending : Number(state.startingBalance || 0);
  const finalEndColor = finalEnd < 0 ? '#dc2626' : '#16a34a';
  html += '<tr style="background:#f1f5f9;font-weight:700">';
  html += `<td style="padding:8px">Totals (${months.length} mo)</td>`;
  html += '<td style="padding:8px"></td>';
  html += `<td style="padding:8px;text-align:right;color:#16a34a">+${formatMoney(totalIncome)}</td>`;
  html += `<td style="padding:8px;text-align:right;color:#dc2626">-${formatMoney(totalExpense)}</td>`;
  html += `<td style="padding:8px;text-align:right;color:${finalEndColor}">${formatMoney(finalEnd)}</td>`;
  html += `<td style="padding:8px;text-align:right;color:${totalFreeColor}">${totalFree >= 0 ? '+' : ''}${formatMoney(totalFree)}</td>`;
  html += '</tr>';

  html += '</tbody></table></div>';
  html += `<p class="muted" style="font-size:12px;margin-top:8px"><strong>Free</strong> = this month's ending balance + next month's income − next month's expenses. What's left after next month's bills are fully covered.</p>`;
  if (months.length && months[0].impliedOpening) {
    const balDateStr = balStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    html += `<p class="muted" style="font-size:12px;margin-top:4px">* Opening balance is implied because your balance was recorded on ${balDateStr} (mid-month). Income/expenses for that month show all transactions; the ending balance reflects your stated balance plus post-${balDateStr} activity.</p>`;
  }
  breakdownContent.innerHTML = html;

  /* ── Debug detail for first 3 months (appended after main render) ── */
  if (!window._showBreakdownDebug) return;
  try {
    const debugMonths = months.slice(0, 3);
    if (debugMonths.length) {
      const dbg = document.createElement('div');
      dbg.style.cssText = 'margin-top:20px;padding:12px;background:#fefce8;border:2px solid #ca8a04;border-radius:8px;font-size:12px';
      let dbgHtml = '<strong style="font-size:13px">Breakdown Debug: June – August</strong>';
      debugMonths.forEach((mo, idx) => {
        const nextMoDbg = idx + 1 < months.length ? months[idx + 1] : null;
        const free = nextMoDbg ? mo.ending + nextMoDbg.income - nextMoDbg.expense : mo.ending;
        const moLabel = mo.date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        const nextLabel = nextMoDbg ? nextMoDbg.date.toLocaleDateString('en-US', { month: 'long' }) : null;
        dbgHtml += `<div style="margin-top:10px;border-top:1px solid #ca8a04;padding-top:8px">`;
        dbgHtml += `<strong>${moLabel}</strong><br>`;
        dbgHtml += `Ending balance: ${formatMoney(mo.ending)}<br>`;
        if (nextMoDbg) {
          dbgHtml += `+ ${nextLabel} income: ${formatMoney(nextMoDbg.income)}<br>`;
          dbgHtml += `− ${nextLabel} expenses: ${formatMoney(nextMoDbg.expense)}<br>`;
        }
        dbgHtml += `= <strong>Free: ${formatMoney(free)}</strong>${nextMoDbg ? '' : ' (last month, no next month data)'}<br>`;
        dbgHtml += '<div style="margin-top:6px"><table style="width:100%;border-collapse:collapse">';
        dbgHtml += '<tr style="background:#fef9c3"><td style="padding:2px 4px"><b>Date</b></td><td style="padding:2px 4px"><b>Name</b></td><td style="padding:2px 4px;text-align:right"><b>Amount</b></td><td style="padding:2px 4px"><b>Type</b></td><td style="padding:2px 4px"><b>Post-bal?</b></td><td style="padding:2px 4px;text-align:right"><b>Running Bal</b></td></tr>';
        const txns = mo.txns || [];
        let runningBal = mo.opening;
        dbgHtml += `<tr style="background:#fef9c3"><td colspan="5" style="padding:2px 4px;font-style:italic">Opening</td><td style="padding:2px 4px;text-align:right;font-weight:700">${formatMoney(runningBal)}</td></tr>`;
        txns.forEach(t => {
          if (t.isPostBalance) runningBal += t.type === 'income' ? t.amount : -t.amount;
          const sign = t.type === 'income' ? '+' : '-';
          const color = t.type === 'income' ? '#16a34a' : '#dc2626';
          const balColor = runningBal < 0 ? '#dc2626' : '#16a34a';
          const ds = t.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const preNote = t.isPostBalance ? '' : ' <em style="color:#888">(pre-bal, not added)</em>';
          dbgHtml += `<tr><td style="padding:2px 4px">${ds}</td><td style="padding:2px 4px">${t.name}${preNote}</td><td style="padding:2px 4px;text-align:right;color:${color}">${sign}${formatMoney(t.amount)}</td><td style="padding:2px 4px">${t.type}</td><td style="padding:2px 4px">${t.isPostBalance ? 'yes' : 'no'}</td><td style="padding:2px 4px;text-align:right;font-weight:700;color:${balColor}">${formatMoney(runningBal)}</td></tr>`;
        });
        if (!txns.length) dbgHtml += '<tr><td colspan="6" style="padding:4px;color:#888">No transactions</td></tr>';
        dbgHtml += '</table></div></div>';
      });
      dbg.innerHTML = dbgHtml;
      breakdownContent.appendChild(dbg);
    }
  } catch(e) {
    console.error('Debug breakdown error:', e);
  }
};

/* ── Full refresh (tab switch) ── */
const refreshAll = () => {
  loadState(() => {
    normalizeBills();
    archiveIncidentals();
    syncInputs();
    renderBills();
    renderPausedBills();
    renderDeposits();
    renderIncidentals();
    renderLoans();
    renderFunds();
    calculateEndingBalance();
    renderNegativeAlert();
    renderMonthlyExpenseSummary();
    renderMonthlyBreakdown();
    saveState();
  });
};

/* ── Dynamic tab bar ── */
const tabBar = document.getElementById("tabBar");

const generateProfileId = () => 'profile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

const renderTabs = () => {
  tabBar.innerHTML = '';
  profiles.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (p.id === activeProfile ? ' active' : '');
    btn.dataset.tab = p.id;
    btn.textContent = p.name;
    /* Delete button (only if more than 1 profile) */
    if (profiles.length > 1) {
      const del = document.createElement('span');
      del.className = 'tab-delete';
      del.textContent = '\u00d7';
      del.title = 'Delete this tab';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProfile(p.id);
      });
      btn.appendChild(del);
    }
    /* Click to switch */
    btn.addEventListener('click', () => {
      if (p.id === activeProfile) return;
      saveState();
      activeProfile = p.id;
      renderTabs();
      refreshAll();
    });
    /* Double-click to rename */
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startRenameTab(p.id, btn);
    });
    tabBar.appendChild(btn);
  });
  /* Add tab button */
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add new budget tab';
  addBtn.addEventListener('click', addProfile);
  tabBar.appendChild(addBtn);
};

const startRenameTab = (profileId, btn) => {
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-rename-input';
  input.value = profile.name;
  input.maxLength = 30;
  const finish = () => {
    const newName = input.value.trim();
    if (newName && newName !== profile.name) {
      profile.name = newName;
      saveProfiles(() => renderTabs());
    } else {
      renderTabs();
    }
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = profile.name; input.blur(); }
  });
  btn.textContent = '';
  btn.appendChild(input);
  input.focus();
  input.select();
};

const addProfile = () => {
  const id = generateProfileId();
  const name = 'Budget ' + (profiles.length + 1);
  profiles.push({ id, name });
  saveState();
  activeProfile = id;
  state = makeDefaultState();
  saveProfiles(() => {
    saveState();
    renderTabs();
    refreshAll();
  });
};

const deleteProfile = (profileId) => {
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;
  if (!confirm(`Delete "${profile.name}" and all its data?`)) return;
  profiles = profiles.filter(p => p.id !== profileId);
  /* Remove data from storage */
  chrome.storage.local.remove(storageKeyForProfile(profileId));
  /* Switch to first remaining profile */
  if (activeProfile === profileId) {
    activeProfile = profiles.length ? profiles[0].id : null;
  }
  saveProfiles(() => {
    renderTabs();
    if (activeProfile) {
      refreshAll();
    }
  });
};

/* ── Backup all profiles ── */
document.getElementById("backupAll").addEventListener("click", () => {
  saveState();
  const keys = profiles.map(p => storageKeyForProfile(p.id));
  chrome.storage.local.get(keys, (result) => {
    const backup = {};
    profiles.forEach(p => {
      const raw = result[storageKeyForProfile(p.id)];
      if (raw) {
        try { backup[p.id] = JSON.parse(raw); } catch(e) { /* skip corrupt */ }
      }
    });
    backup._meta = { exportedAt: new Date().toISOString(), version: 3, profiles: profiles };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `budget-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

/* ── Restore backup ── */
const jsonBackupInput = document.getElementById("jsonBackupInput");
document.getElementById("restoreBackup").addEventListener("click", () => jsonBackupInput.click());
jsonBackupInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data._meta && data._meta.profiles) {
        /* New-format backup (v3) with dynamic profiles */
        const backupProfiles = data._meta.profiles;
        let restored = 0;
        const toStore = {};
        backupProfiles.forEach(p => {
          if (data[p.id] && data[p.id].bills) {
            /* Merge profile if not already present */
            if (!profiles.find(ep => ep.id === p.id)) {
              profiles.push({ id: p.id, name: p.name });
            }
            toStore[storageKeyForProfile(p.id)] = JSON.stringify(data[p.id]);
            restored++;
          }
        });
        if (restored) {
          toStore[PROFILES_KEY] = JSON.stringify(profiles);
          activeProfile = profiles[0].id;
          chrome.storage.local.set(toStore, () => {
            renderTabs();
            refreshAll();
            alert(`Backup restored! ${restored} profile(s) loaded.`);
          });
        } else {
          alert("No valid profile data found in backup file.");
        }
      } else if (data._meta || data.rex || data.extra || data.mary) {
        /* Old-format backup (v2) with hardcoded rex/extra/mary */
        const oldProfiles = ['rex', 'extra', 'mary'];
        const oldNames = { rex: "Rex's Budget", extra: "Extra Budget", mary: "Mary's Budget" };
        let restored = 0;
        const toStore = {};
        oldProfiles.forEach(p => {
          if (data[p] && data[p].bills) {
            if (!profiles.find(ep => ep.id === p)) {
              profiles.push({ id: p, name: oldNames[p] || p });
            }
            toStore[storageKeyForProfile(p)] = JSON.stringify(data[p]);
            restored++;
          }
        });
        if (restored) {
          toStore[PROFILES_KEY] = JSON.stringify(profiles);
          activeProfile = profiles[0].id;
          chrome.storage.local.set(toStore, () => {
            renderTabs();
            refreshAll();
            alert(`Backup restored! ${restored} profile(s) loaded.`);
          });
        } else {
          alert("No valid profile data found in backup file.");
        }
      } else if (data.bills) {
        /* Single-profile export — load into active profile */
        if (!activeProfile) {
          const id = generateProfileId();
          profiles.push({ id, name: 'Imported Budget' });
          activeProfile = id;
        }
        const toStore = {
          [storageKeyForProfile(activeProfile)]: JSON.stringify(data),
          [PROFILES_KEY]: JSON.stringify(profiles)
        };
        chrome.storage.local.set(toStore, () => {
          renderTabs();
          refreshAll();
          alert(`Restored into "${profiles.find(p => p.id === activeProfile).name}".`);
        });
      } else {
        alert("Unrecognized backup format.");
      }
    } catch (err) {
      alert("Could not parse backup file: " + err.message);
    }
  };
  reader.readAsText(file);
  jsonBackupInput.value = "";
});

/* ── Download CSV template ── */
document.getElementById("downloadTemplate").addEventListener("click", () => {
  const headers = ["name", "amount", "interval", "dueDay", "startDate", "type"];
  const examples = [
    ["Rent", "1500.00", "monthly", "1", "2026-03-01", "expense"],
    ["Gas", "45.00", "weekly", "", "2026-03-01", "expense"],
    ["Payroll", "2400.00", "biweekly", "", "2026-03-01", "income"],
    ["New Laptop", "999.00", "one-time", "", "2026-04-15", "expense"]
  ];
  const csv = headers.join(",") + "\n" + examples.map(r => r.join(",")).join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "budget-template.csv"; a.click();
  URL.revokeObjectURL(url);
});

/* ── Import CSV ── */
const csvFileInput = document.getElementById("csvFileInput");
document.getElementById("importBills").addEventListener("click", () => csvFileInput.click());

const parseCSV = (text) => {
  const lines = []; let cur = ['']; let inQ = false; let fi = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i+1] === '"') { cur[fi] += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur[fi] += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',' || ch === '\t') { fi++; cur[fi] = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i+1] === '\n')) {
        lines.push(cur); cur = ['']; fi = 0;
        if (ch === '\r') i++;
      } else { cur[fi] += ch; }
    }
  }
  if (cur.length > 1 || cur[0] !== '') lines.push(cur);
  return lines;
};

const guessMapping = (headers) => {
  const mapping = { name: '', amount: '', interval: '', dueDay: '', startDate: '', type: '' };
  const lower = headers.map(h => h.toLowerCase().trim());
  const patterns = {
    name: /name|description|bill|label|title|vendor|payee/,
    amount: /amount|cost|price|total|payment|\$/,
    interval: /interval|frequency|recur|period|schedule/,
    dueDay: /due.*day|day.*due|due.*date/,
    startDate: /start.*date|date|when|begin/,
    type: /type|category|kind|income.*expense|direction/
  };
  for (const [field, rx] of Object.entries(patterns)) {
    const idx = lower.findIndex(h => rx.test(h));
    if (idx >= 0) mapping[field] = headers[idx];
  }
  return mapping;
};

const showImportModal = (headers, rows) => {
  const existing = document.getElementById("importModal");
  if (existing) existing.remove();

  const autoMap = guessMapping(headers);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "importModal";

  const selOpts = (selField) => {
    let html = '<option value="">(skip)</option>';
    headers.forEach(h => {
      html += `<option value="${h}" ${autoMap[selField]===h?'selected':''}>${h}</option>`;
    });
    return html;
  };

  const fields = [
    { key: 'name', label: 'Bill Name *' },
    { key: 'amount', label: 'Amount *' },
    { key: 'interval', label: 'Interval' },
    { key: 'dueDay', label: 'Due Day' },
    { key: 'startDate', label: 'Start Date' },
    { key: 'type', label: 'Type' }
  ];

  let mappingHTML = '<div class="mapping-grid">';
  fields.forEach(f => {
    mappingHTML += `<div><label>${f.label}</label></div><div class="arrow">&larr;</div><div><select data-map="${f.key}">${selOpts(f.key)}</select></div>`;
  });
  mappingHTML += '</div>';

  overlay.innerHTML = `
    <div class="modal">
      <h2>Import Bills from CSV</h2>
      <p class="step-label">Step 1: Map your CSV columns to bill fields</p>
      ${mappingHTML}
      <div class="import-mode">
        <label><input type="radio" name="importMode" value="append" checked /> Add to existing bills</label>
        <label><input type="radio" name="importMode" value="replace" /> Replace all bills</label>
      </div>
      <p class="step-label" style="margin-top:16px">Step 2: Preview (first ${Math.min(rows.length, 50)} of ${rows.length} rows)</p>
      <div id="importPreview"></div>
      <div class="import-stats" id="importStats"></div>
      <div class="import-actions">
        <button class="secondary" id="importCancel">Cancel</button>
        <button id="importConfirm">Import ${rows.length} bill${rows.length!==1?'s':''}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const getMapping = () => {
    const m = {};
    overlay.querySelectorAll('[data-map]').forEach(sel => {
      m[sel.dataset.map] = sel.value;
    });
    return m;
  };

  const mapRow = (row, mapping) => {
    const idx = (col) => col ? headers.indexOf(col) : -1;
    const val = (col) => { const i = idx(col); return i >= 0 ? (row[i] || '').trim() : ''; };

    const name = val(mapping.name);
    let amount = parseFloat(val(mapping.amount).replace(/[^\d.\-]/g, ''));
    if (isNaN(amount)) amount = 0;

    let interval = val(mapping.interval).toLowerCase();
    if (['monthly','weekly','biweekly','one-time'].includes(interval)) { /* ok */ }
    else if (/week/i.test(interval)) interval = 'weekly';
    else if (/bi|every.*2|fortnight/i.test(interval)) interval = 'biweekly';
    else if (/one|once|single/i.test(interval)) interval = 'one-time';
    else interval = 'monthly';

    let startDate = val(mapping.startDate);
    if (startDate) {
      const pd = new Date(startDate);
      if (!isNaN(pd)) startDate = `${pd.getFullYear()}-${pad2(pd.getMonth()+1)}-${pad2(pd.getDate())}`;
      else startDate = state.balanceDate;
    } else { startDate = state.balanceDate; }

    let dueDay = parseInt(val(mapping.dueDay), 10);
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) dueDay = null;

    let type = val(mapping.type).toLowerCase();
    if (type === 'income') type = 'income'; else type = 'expense';

    return { name, amount: Math.abs(amount), interval, dueDay, startDate, type };
  };

  const renderPreview = () => {
    const mapping = getMapping();
    const mapped = rows.map(r => mapRow(r, mapping));
    const valid = mapped.filter(b => b.name);
    const preview = valid.slice(0, 50);

    let html = '<div class="preview-scroll"><table class="preview-table">';
    html += '<thead><tr><th>Name</th><th>Amount</th><th>Interval</th><th>Due Day</th><th>Start Date</th><th>Type</th></tr></thead><tbody>';
    preview.forEach(b => {
      html += `<tr>
        <td>${b.name}</td>
        <td>${formatMoney(b.amount)}</td>
        <td>${b.interval}</td>
        <td>${b.dueDay || '\u2014'}</td>
        <td>${b.startDate}</td>
        <td>${b.type}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';

    document.getElementById('importPreview').innerHTML = html;
    const skipped = mapped.length - valid.length;
    document.getElementById('importStats').textContent = `${valid.length} valid bill${valid.length!==1?'s':''}${skipped ? `, ${skipped} skipped (missing name)` : ''}`;
    document.getElementById('importConfirm').textContent = `Import ${valid.length} bill${valid.length!==1?'s':''}`;
  };

  renderPreview();

  overlay.querySelectorAll('[data-map]').forEach(sel => {
    sel.addEventListener('change', renderPreview);
  });

  document.getElementById('importCancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('importConfirm').addEventListener('click', () => {
    const mapping = getMapping();
    const mapped = rows.map(r => mapRow(r, mapping)).filter(b => b.name);
    if (!mapped.length) return;

    const mode = overlay.querySelector('input[name=importMode]:checked').value;
    if (mode === 'replace') { state.bills = mapped; }
    else { state.bills.push(...mapped); }

    normalizeBills();
    renderBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    overlay.remove();
  });
};

csvFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = ev.target.result;
    const lines = parseCSV(text);
    if (lines.length < 2) { alert('CSV must have a header row and at least one data row.'); return; }
    const headers = lines[0].map(h => h.trim());
    const rows = lines.slice(1).filter(r => r.some(c => c.trim()));
    if (!rows.length) { alert('No data rows found.'); return; }
    showImportModal(headers, rows);
  };
  reader.readAsText(file);
  csvFileInput.value = '';
});

/* ── Events: add bill ── */
elements.addBill.addEventListener("click", () => {
  const name = elements.newName.value.trim();
  const amount = Number(elements.newAmount.value||0);
  const interval = elements.newInterval.value;
  const dueDay = Number(elements.newDueDay.value) || null;
  const startDate = elements.newStartDate.value || state.balanceDate;
  const type = elements.newType.value;
  if (!name) return;

  state.bills.push({ name, amount, interval, dueDay, startDate, type });
  normalizeBills();
  elements.newName.value = ""; elements.newAmount.value = "";
  elements.newDueDay.value = "";
  elements.newStartDate.value = state.balanceDate;
  renderBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: reset defaults ── */
elements.resetBills.addEventListener("click", () => {
  if (!confirm('Clear all bills for this profile?')) return;
  state.bills = [];
  normalizeBills(); renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Sync with Debt Planner ── */
document.getElementById('syncDebtPlanner').addEventListener('click', () => {
  const raw = localStorage.getItem('debtPlannerData');
  if (!raw) {
    alert('No Debt Planner data found. Open the Debt Planner in this browser first, then try again.');
    return;
  }
  let debtData;
  try { debtData = JSON.parse(raw); } catch(_) {
    alert('Could not read Debt Planner data.');
    return;
  }

  const debts = debtData.debts || [];
  const qualifying = debts.filter(d =>
    d.type === 'credit_card' || d.name.toLowerCase().includes('mortgage')
  );

  if (qualifying.length === 0) {
    alert('No credit card or mortgage debts found in Debt Planner.');
    return;
  }

  let added = 0, updated = 0;
  qualifying.forEach(debt => {
    const existingIdx = state.bills.findIndex(b => b.debtId === debt.id);
    const newAmount = debt.balance > 0.005 ? (debt.minPayment || 0) : 0;
    if (existingIdx >= 0) {
      const existing = state.bills[existingIdx];
      state.bills[existingIdx] = {
        ...existing,
        name: debt.name,
        amount: newAmount,
        ...(debt.dueDay > 0 ? { dueDay: debt.dueDay } : {})
      };
      updated++;
    } else {
      state.bills.push({
        name: debt.name,
        amount: newAmount,
        interval: 'monthly',
        dueDay: debt.dueDay > 0 ? debt.dueDay : null,
        startDate: state.balanceDate,
        type: 'expense',
        debtId: debt.id,
        manualPayments: []
      });
      added++;
    }
  });

  normalizeBills();
  renderBills();
  renderPausedBills();
  saveState();
  calculateEndingBalance();
  renderNegativeAlert();
  showToast(`Debt Planner synced: ${added} added, ${updated} updated`);
});

/* ── Events: export ── */
elements.exportBills.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download=`budget-${activeProfile}.json`; a.click();
  URL.revokeObjectURL(url);
});

/* ── Events: balance & dates ── */
elements.startingBalance.addEventListener("input", e => { state.startingBalance=Number(e.target.value||0); saveState(); calculateEndingBalance(); renderNegativeAlert(); });
elements.balanceDate.addEventListener("change", e => { state.balanceDate=e.target.value; saveState(); calculateEndingBalance(); renderNegativeAlert(); });
elements.checkDate.addEventListener("change", e => { state.checkDate=e.target.value; saveState(); calculateEndingBalance(); renderNegativeAlert(); });

/* ── Events: bill table edits ── */
let _editDebounce = null;
const handleBillEdit = (e) => {
  const f = e.target.dataset.field, idx = Number(e.target.dataset.index);
  if (!f) return;
  updateBillField(idx, f, e.target.value);
  clearTimeout(_editDebounce);
  _editDebounce = setTimeout(() => { saveState(); }, 500);
  calculateEndingBalance(); renderNegativeAlert();
};
elements.billTable.addEventListener("input", handleBillEdit);
elements.billTable.addEventListener("change", handleBillEdit);

/* ── Events: undo pay today ── */
elements.billTable.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "undo-pay") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth();
  const mpIdx = bill.manualPayments ? bill.manualPayments.findLastIndex(mp => {
    if (!mp.date) return false;
    const mpd = toDate(mp.date);
    return mpd.getFullYear() === curY && mpd.getMonth() === curM;
  }) : -1;
  if (mpIdx === -1) return;
  bill.manualPayments.splice(mpIdx, 1);
  const stillHasThisMonth = bill.manualPayments.some(mp => {
    if (!mp.date) return false;
    const mpd = toDate(mp.date);
    return mpd.getFullYear() === curY && mpd.getMonth() === curM;
  });
  if (!stillHasThisMonth) bill.paused = false;
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: toggle included in balance ── */
elements.billTable.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "toggle-in-balance") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  const curMk = currentMonthKey();
  bill.includedInBalance = bill.includedInBalance === curMk ? null : curMk;
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: toggle not in balance (past due) ── */
elements.billTable.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "toggle-not-in-balance") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  const curMk = currentMonthKey();
  bill.notInBalance = bill.notInBalance === curMk ? null : curMk;
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: bill pause / resume ── */
elements.billTable.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "toggle-pause") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  bill.paused = !bill.paused;
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: Pay Today ── */
elements.billTable.addEventListener("click", (e) => {
  if (e.target.dataset.action !== "pay-today") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (!bill) return;
  const now = new Date();
  const payDate = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  if (!bill.manualPayments) bill.manualPayments = [];
  bill.manualPayments.push({ date: payDate });
  const payD = startOfDay(toDate(payDate));
  const balD = startOfDay(toDate(state.balanceDate));
  if (payD.getTime() <= balD.getTime()) {
    const amt = Number(bill.amount || 0);
    state.startingBalance += bill.type === "income" ? amt : -amt;
    state.startingBalance = Math.round(state.startingBalance * 100) / 100;
    elements.startingBalance.value = state.startingBalance;
  }
  renderBills(); renderPausedBills(); saveState(); calculateEndingBalance(); renderNegativeAlert(); renderMonthlyExpenseSummary();
});

/* ── Events: bill remove / cancel ── */
elements.billTable.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (action !== "delete" && action !== "cancel") return;
  const idx = Number(e.target.dataset.index), bill = state.bills[idx];
  if (action === "cancel") {
    state.bills.splice(idx, 1);
    renderBills(); saveState(); calculateEndingBalance(); renderNegativeAlert(); return;
  }
  if (bill && bill.interval === "one-time" && bill.startDate) {
    const bd = startOfDay(toDate(bill.startDate)), balD = startOfDay(toDate(state.balanceDate)), now = startOfDay(new Date());
    if (bd >= balD && bd <= now) {
      const amt = Number(bill.amount||0);
      state.startingBalance += bill.type==="income" ? amt : -amt;
      state.startingBalance = Math.round(state.startingBalance*100)/100;
      elements.startingBalance.value = state.startingBalance;
    }
  }
  state.bills.splice(idx, 1);
  renderBills(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: add deposit ── */
elements.addDeposit.addEventListener("click", () => {
  const name = elements.depositName.value.trim();
  const amount = Number(elements.depositAmount.value||0);
  const date = elements.depositDate.value || state.balanceDate;
  if (!name || !amount) return;
  state.deposits.push({ name, amount, date });
  elements.depositName.value = ""; elements.depositAmount.value = "";
  elements.depositDate.value = state.balanceDate;
  renderDeposits(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: add incidental ── */
elements.addIncidental.addEventListener("click", () => {
  const name = elements.incName.value.trim();
  const amount = Number(elements.incAmount.value || 0);
  const date = elements.incDate.value || todayIso;
  const inBalance = !!elements.incInBalance.checked;
  if (!name || !amount) return;
  if (!state.incidentals) state.incidentals = [];
  state.incidentals.push({ name, amount, date, inBalance });
  elements.incName.value = ""; elements.incAmount.value = "";
  elements.incDate.value = todayIso;
  elements.incInBalance.checked = false;
  renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: incidental remove / archive / edit ── */
elements.incidentalGroups.addEventListener("click", (e) => {
  const action = e.target.dataset.action;

  if (action === "edit-inc") {
    const idx = Number(e.target.dataset.index);
    const inc = state.incidentals[idx];
    if (!inc) return;
    const tr = e.target.closest("tr");
    const amountTd = tr.querySelector('[data-cell="amount"]');
    const dateTd = tr.querySelector('[data-cell="date"]');
    const actionsTd = tr.lastElementChild;
    amountTd.innerHTML = `<input type="number" step="0.01" value="${inc.amount}" style="width:90px" data-edit="amount" />`;
    dateTd.innerHTML = `<input type="date" value="${inc.date || ''}" style="width:140px" data-edit="date" /><label style="display:block;font-size:11px;margin-top:4px;cursor:pointer" title="Already reflected in current balance"><input type="checkbox" data-edit="inBalance" ${inc.inBalance?'checked':''} style="width:auto;margin:0 4px 0 0;cursor:pointer" />In balance</label>`;
    actionsTd.innerHTML = `<button class="pay-today" data-action="save-inc" data-index="${idx}" style="width:auto;display:inline-block;margin-right:4px">Save</button><button class="secondary" data-action="cancel-edit-inc" data-index="${idx}" style="width:auto;display:inline-block">Cancel</button>`;
    return;
  }

  if (action === "cancel-edit-inc") {
    renderIncidentals();
    return;
  }

  if (action === "save-inc") {
    const idx = Number(e.target.dataset.index);
    const inc = state.incidentals[idx];
    if (!inc) return;
    const tr = e.target.closest("tr");
    const newAmount = Number(tr.querySelector('[data-edit="amount"]').value || 0);
    const newDate = tr.querySelector('[data-edit="date"]').value;
    const inBalCb = tr.querySelector('[data-edit="inBalance"]');
    if (!newAmount) return;
    inc.amount = newAmount;
    if (newDate) inc.date = newDate;
    if (inBalCb) inc.inBalance = !!inBalCb.checked;
    renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert(); renderMonthlyExpenseSummary();
    return;
  }

  if (action === "edit-archived-inc") {
    const mk = e.target.dataset.month;
    const ai = Number(e.target.dataset.index);
    const inc = (state.archivedIncidentals[mk] || [])[ai];
    if (!inc) return;
    const tr = e.target.closest("tr");
    const amountTd = tr.querySelector('[data-cell="amount"]');
    const dateTd = tr.querySelector('[data-cell="date"]');
    const actionsTd = tr.lastElementChild;
    amountTd.innerHTML = `<input type="number" step="0.01" value="${inc.amount}" style="width:90px" data-edit="amount" />`;
    dateTd.innerHTML = `<input type="date" value="${inc.date || ''}" style="width:140px" data-edit="date" /><label style="display:block;font-size:11px;margin-top:4px;cursor:pointer" title="Already reflected in current balance"><input type="checkbox" data-edit="inBalance" ${inc.inBalance?'checked':''} style="width:auto;margin:0 4px 0 0;cursor:pointer" />In balance</label>`;
    actionsTd.innerHTML = `<button class="pay-today" data-action="save-archived-inc" data-month="${mk}" data-index="${ai}" style="width:auto;display:inline-block;margin-right:4px">Save</button><button class="secondary" data-action="cancel-edit-inc" style="width:auto;display:inline-block">Cancel</button>`;
    return;
  }

  if (action === "save-archived-inc") {
    const mk = e.target.dataset.month;
    const ai = Number(e.target.dataset.index);
    const inc = (state.archivedIncidentals[mk] || [])[ai];
    if (!inc) return;
    const tr = e.target.closest("tr");
    const newAmount = Number(tr.querySelector('[data-edit="amount"]').value || 0);
    const newDate = tr.querySelector('[data-edit="date"]').value;
    const inBalCb = tr.querySelector('[data-edit="inBalance"]');
    if (!newAmount) return;
    inc.amount = newAmount;
    if (newDate) inc.date = newDate;
    if (inBalCb) inc.inBalance = !!inBalCb.checked;
    renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert(); renderMonthlyExpenseSummary();
    return;
  }

  if (action === "remove-archived-inc") {
    const mk = e.target.dataset.month;
    const ai = Number(e.target.dataset.index);
    const inc = (state.archivedIncidentals[mk] || [])[ai];
    if (!inc) return;
    state.archivedIncidentals[mk].splice(ai, 1);
    if (!state.archivedIncidentals[mk].length) delete state.archivedIncidentals[mk];
    renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  if (action === "unarchive-inc") {
    const mk = e.target.dataset.month;
    const ai = Number(e.target.dataset.index);
    const inc = (state.archivedIncidentals[mk] || [])[ai];
    if (!inc) return;
    state.incidentals.push({ ...inc });
    state.archivedIncidentals[mk].splice(ai, 1);
    if (!state.archivedIncidentals[mk].length) delete state.archivedIncidentals[mk];
    renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  if (action !== "remove-inc" && action !== "archive-inc") return;
  const idx = Number(e.target.dataset.index);
  const inc = state.incidentals[idx];
  if (!inc) return;

  if (action === "archive-inc") {
    const mk = inc.date ? monthKey(inc.date) : currentMonthKey();
    if (!state.archivedIncidentals) state.archivedIncidentals = {};
    if (!state.archivedIncidentals[mk]) state.archivedIncidentals[mk] = [];
    state.archivedIncidentals[mk].push({ ...inc });
    state.incidentals.splice(idx, 1);
    renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  state.incidentals.splice(idx, 1);
  renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: deposit remove / cancel ── */
elements.depositTable.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (action !== "remove-deposit" && action !== "cancel-deposit") return;
  const idx = Number(e.target.dataset.index), dep = state.deposits[idx];
  if (!dep) return;

  /* If this deposit came from a fund transfer, offer to return the money */
  if (dep.fromFund) {
    const returnIt = confirm(
      `Return ${formatMoney(Number(dep.amount||0))} to the "${dep.fromFund.name}" fund?\n\n` +
      `OK = delete deposit and return money to fund\n` +
      `Cancel = delete deposit only`
    );
    if (returnIt) {
      if (dep.fromFund.profileId === activeProfile) {
        /* Fund is in this tab — update live state */
        const f = state.funds?.find(f => f.id === dep.fromFund.id);
        if (f) f.balance = Math.round((Number(f.balance||0) + Number(dep.amount||0)) * 100) / 100;
        renderFunds();
      } else {
        /* Fund is in another tab — patch that profile's data */
        const fKey = storageKeyForProfile(dep.fromFund.profileId);
        const fRaw = localStorage.getItem(fKey);
        let fState;
        try { fState = JSON.parse(fRaw); } catch(_) { fState = makeDefaultState(); }
        const f = fState.funds?.find(f => f.id === dep.fromFund.id);
        if (f) {
          f.balance = Math.round((Number(f.balance||0) + Number(dep.amount||0)) * 100) / 100;
          const fData = JSON.stringify(fState);
          localStorage.setItem(fKey, fData);
          window.cloudSync?.saveProfile(dep.fromFund.profileId, fData);
        }
      }
    }
  }

  state.deposits.splice(idx, 1);
  renderDeposits(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: add loan ── */
elements.addLoan.addEventListener("click", () => {
  const name = elements.loanName.value.trim();
  const amount = Number(elements.loanAmount.value || 0);
  const date = elements.loanDate.value || todayIso;
  const scheduledRepayDate = elements.loanRepayDate.value || null;
  if (!name || !amount) return;
  if (!state.loans) state.loans = [];
  state.loans.push({ name, amount, date, scheduledRepayDate, repaid: false, repaidDate: null, paused: false });
  elements.loanName.value = ""; elements.loanAmount.value = "";
  elements.loanDate.value = todayIso; elements.loanRepayDate.value = "";
  renderLoans(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});

/* ── Events: loan actions ── */
elements.loanTable.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const idx = Number(e.target.dataset.index);
  const loan = (state.loans || [])[idx];
  if (!loan) return;

  if (action === "repay-loan") {
    const now = new Date();
    const repaidDate = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
    loan.repaid = true;
    loan.repaidDate = repaidDate;
    loan.paused = false;
    renderLoans(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  if (action === "unrepay-loan") {
    loan.repaid = false;
    loan.repaidDate = null;
    renderLoans(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  if (action === "toggle-pause-loan") {
    loan.paused = !loan.paused;
    renderLoans(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }

  if (action === "delete-loan") {
    state.loans.splice(idx, 1);
    renderLoans(); saveState(); calculateEndingBalance(); renderNegativeAlert();
    return;
  }
});

/* ── Events: loan scheduled date / amount change ── */
elements.loanTable.addEventListener("change", (e) => {
  const action = e.target.dataset.action;
  const idx = Number(e.target.dataset.index);
  const loan = (state.loans || [])[idx];
  if (!loan) return;

  if (action === "edit-sched") {
    loan.scheduledRepayDate = e.target.value || null;
    saveState(); calculateEndingBalance(); renderNegativeAlert(); renderLoans();
    return;
  }

  if (action === "edit-amount") {
    loan.amount = Number(e.target.value || 0);
    saveState(); calculateEndingBalance(); renderNegativeAlert(); renderLoans();
    return;
  }
});

/* ── Optional sections (loans toggle) ── */
const LOANS_VISIBLE_KEY = 'budgetPlanner.loansVisible';
const loansSection = document.getElementById('loansSection');
const toggleLoansSection = document.getElementById('toggleLoansSection');

const applyLoansVisibility = () => {
  const visible = localStorage.getItem(LOANS_VISIBLE_KEY) === '1';
  loansSection.style.display = visible ? '' : 'none';
  toggleLoansSection.checked = visible;
};
toggleLoansSection.addEventListener('change', () => {
  const val = toggleLoansSection.checked ? '1' : '0';
  localStorage.setItem(LOANS_VISIBLE_KEY, val);
  window.cloudSync?.saveSetting(LOANS_VISIBLE_KEY, val);
  applyLoansVisibility();
});
applyLoansVisibility();

/* ── Debug breakdown toggle ── */
const toggleDebugSection = document.getElementById('toggleDebugSection');
if (toggleDebugSection) {
  toggleDebugSection.addEventListener('change', () => {
    window._showBreakdownDebug = toggleDebugSection.checked;
    renderMonthlyBreakdown();
  });
}

/* ── Editable app title ── */
const APP_TITLE_KEY = 'budgetPlanner.appTitle';
const appTitle = document.getElementById('appTitle');

const applyAppTitle = () => {
  const saved = localStorage.getItem(APP_TITLE_KEY);
  if (saved) {
    appTitle.textContent = saved;
    document.title = saved;
  }
};

const startTitleEdit = () => {
  if (appTitle.querySelector('input')) return;
  const current = appTitle.textContent.trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.style.cssText = 'font-size:24px;font-weight:bold;padding:4px 8px;border-radius:4px;border:2px solid #fff;background:rgba(255,255,255,0.95);color:var(--text);width:auto;min-width:200px';
  appTitle.textContent = '';
  appTitle.appendChild(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    const newVal = commit ? (input.value.trim() || current) : current;
    appTitle.textContent = newVal;
    if (commit && newVal !== current) {
      localStorage.setItem(APP_TITLE_KEY, newVal);
      window.cloudSync?.saveSetting(APP_TITLE_KEY, newVal);
      document.title = newVal;
    }
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
};
appTitle.addEventListener('click', startTitleEdit);
appTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startTitleEdit(); }
});
applyAppTitle();

/* ── Quick Expenses ── */
const QUICK_EXPENSES_KEY = 'budgetPlanner.quickExpenses';
const DEFAULT_QUICK_EXPENSES = [
  { id: 'qe-groceries', name: 'Groceries' },
  { id: 'qe-gas',       name: 'Gas' },
  { id: 'qe-snacks',    name: 'Snacks' },
  { id: 'qe-eating',    name: 'Eating Out' },
  { id: 'qe-coffee',    name: 'Coffee' },
];

let quickExpenses = (() => {
  try {
    const saved = localStorage.getItem(QUICK_EXPENSES_KEY);
    return saved ? JSON.parse(saved) : [...DEFAULT_QUICK_EXPENSES];
  } catch { return [...DEFAULT_QUICK_EXPENSES]; }
})();

const saveQuickExpenses = () => localStorage.setItem(QUICK_EXPENSES_KEY, JSON.stringify(quickExpenses));

/* modal open/close — defined as functions so they're hoisted */
let _qeModalName = '';
function openQEModal(name) {
  _qeModalName = name;
  document.getElementById('qeModalTitle').textContent = name;
  document.getElementById('qeAmount').value = '';
  document.getElementById('qeDate').value = todayIso;
  document.getElementById('qeInBalance').checked = false;
  document.getElementById('quickExpenseModal').style.display = 'flex';
  setTimeout(() => document.getElementById('qeAmount').focus(), 50);
}
function closeQEModal() {
  document.getElementById('quickExpenseModal').style.display = 'none';
}

const renderQuickExpenseSelect = () => {
  const sel = document.getElementById('quickExpenseSelect');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— select type —</option>' +
    quickExpenses.map(q => `<option value="${q.id}">${q.name}</option>`).join('');
  if (cur) sel.value = cur;
};

/* select change → open modal */
document.getElementById('quickExpenseSelect').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!id) return;
  const qe = quickExpenses.find(q => q.id === id);
  if (qe) openQEModal(qe.name);
  e.target.value = '';
});

/* modal buttons */
document.getElementById('qeCancel').addEventListener('click', closeQEModal);
document.getElementById('quickExpenseModal').addEventListener('click', (e) => {
  if (e.target.id === 'quickExpenseModal') closeQEModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeQEModal(); closeAddTypeModal(); } });

document.getElementById('qeSubmit').addEventListener('click', () => {
  const amount = Number(document.getElementById('qeAmount').value || 0);
  if (!amount) { document.getElementById('qeAmount').focus(); return; }
  const date = document.getElementById('qeDate').value || todayIso;
  const inBalance = !!document.getElementById('qeInBalance').checked;
  if (!state.incidentals) state.incidentals = [];
  state.incidentals.push({ name: _qeModalName, amount, date, inBalance });
  closeQEModal();
  renderIncidentals(); saveState(); calculateEndingBalance(); renderNegativeAlert();
});
document.getElementById('qeAmount').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('qeSubmit').click();
});

/* "+" → open add-type modal */
function openAddTypeModal() {
  document.getElementById('newQEName').value = '';
  document.getElementById('addTypeModal').style.display = 'flex';
  setTimeout(() => document.getElementById('newQEName').focus(), 50);
}
function closeAddTypeModal() {
  document.getElementById('addTypeModal').style.display = 'none';
}
document.getElementById('toggleManageQE').addEventListener('click', openAddTypeModal);
document.getElementById('addTypeCancelBtn').addEventListener('click', closeAddTypeModal);
document.getElementById('addTypeModal').addEventListener('click', (e) => {
  if (e.target.id === 'addTypeModal') closeAddTypeModal();
});

/* save new quick expense type */
function submitNewQE() {
  const input = document.getElementById('newQEName');
  const name = input.value.trim();
  if (!name) return;
  quickExpenses.push({ id: 'qe-' + Date.now(), name });
  saveQuickExpenses();
  closeAddTypeModal();
  renderQuickExpenseSelect();
}
document.getElementById('addQEBtn').addEventListener('click', submitNewQE);
document.getElementById('newQEName').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNewQE(); });

renderQuickExpenseSelect();

/* ── Dark mode ── */
const DARK_KEY = 'budgetPlanner.darkMode';
const darkBtn = document.getElementById('darkModeToggle');
const applyDark = (on) => {
  document.body.classList.toggle('dark-planner', on);
  darkBtn.textContent = on ? '☀' : '☽';
  darkBtn.title = on ? 'Switch to light mode' : 'Switch to dark mode';
};
applyDark(localStorage.getItem(DARK_KEY) === '1');
darkBtn.addEventListener('click', () => {
  const on = !document.body.classList.contains('dark-planner');
  localStorage.setItem(DARK_KEY, on ? '1' : '0');
  applyDark(on);
});

/* ── Boot ── */
chrome.storage.local.get([PROFILES_KEY], (result) => {
  const raw = result[PROFILES_KEY];
  if (raw) {
    try { profiles = JSON.parse(raw); } catch(e) { profiles = []; }
  }
  if (!profiles.length) {
    /* First run — create a default empty profile */
    const id = generateProfileId();
    profiles = [{ id, name: 'My Budget' }];
    activeProfile = id;
    saveProfiles();
  } else {
    activeProfile = profiles[0].id;
  }
  renderTabs();
  refreshAll();
});

/* ── Auto-refresh on deploy ── */
(function () {
  const PAGE_URL = location.origin + location.pathname;
  let knownTag = null;
  let bannerShown = false;

  async function poll() {
    try {
      const r = await fetch(PAGE_URL, { method: 'HEAD', cache: 'no-store' });
      const tag = r.headers.get('etag') || r.headers.get('last-modified');
      if (!tag) return;
      if (knownTag === null) { knownTag = tag; return; }
      if (tag !== knownTag && !bannerShown) showBanner();
    } catch (_) {}
  }

  function showBanner() {
    bannerShown = true;
    let secs = 15;
    const bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#d4a574;color:#1a1d25;padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:14px;font-weight:600;box-shadow:0 2px 12px rgba(0,0,0,0.3)';
    const label = document.createElement('span');
    label.textContent = `⟳ New version available — refreshing in ${secs}s`;
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.style.cssText = 'background:#1a1d25;color:#f0c896;border:none;padding:5px 14px;border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit';
    refreshBtn.onclick = () => location.reload();
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '×';
    dismissBtn.style.cssText = 'background:none;border:none;color:#1a1d25;font-size:22px;cursor:pointer;padding:0 4px;line-height:1';
    dismissBtn.onclick = () => { clearInterval(ticker); bar.remove(); };
    bar.append(label, refreshBtn, dismissBtn);
    document.body.prepend(bar);
    const ticker = setInterval(() => {
      secs--;
      if (secs <= 0) { clearInterval(ticker); location.reload(); }
      else label.textContent = `⟳ New version available — refreshing in ${secs}s`;
    }, 1000);
  }

  setTimeout(poll, 3000);
  setInterval(poll, 30000);
}());

/* ── Changelog modal ── */
const changelogModal = document.getElementById('changelogModal');
document.getElementById('changelogLink').addEventListener('click', (e) => {
  e.preventDefault();
  changelogModal.style.display = 'flex';
});
document.getElementById('changelogClose').addEventListener('click', () => {
  changelogModal.style.display = 'none';
});
changelogModal.addEventListener('click', (e) => {
  if (e.target === changelogModal) changelogModal.style.display = 'none';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    changelogModal.style.display = 'none';
    closeFundTxModal();
  }
});

/* ── Funds ─────────────────────────────────────────────── */
const fundsList       = document.getElementById('fundsList');
const fundsTotalBadge = document.getElementById('fundsTotalBadge');

/* ── render fund cards ── */
const renderFunds = () => {
  if (!state.funds) state.funds = [];
  const total = state.funds.reduce((s, f) => s + Number(f.balance || 0), 0);
  fundsTotalBadge.textContent = formatMoney(total) + ' total';

  if (!state.funds.length) {
    fundsList.innerHTML = '<span class="fund-empty">No funds yet — click "+ New Fund" to create one.</span>';
    return;
  }

  fundsList.innerHTML = '';
  state.funds.forEach((fund, i) => {
    const card = document.createElement('div');
    card.className = 'fund-card';
    const hasOtherFunds = state.funds.length > 1;
    card.innerHTML = `
      <div class="fund-card-name" title="${fund.name}">${fund.name}</div>
      <div class="fund-card-balance">${formatMoney(Number(fund.balance || 0))}</div>
      <div class="fund-card-actions">
        <button class="fund-action-btn fund-add"  data-fi="${i}" title="Add money to this fund">+ Add</button>
        <button class="fund-action-btn fund-move" data-fi="${i}" title="Move money to your main account">→ Acct</button>
        ${hasOtherFunds ? `<button class="fund-action-btn fund-xfer" data-fi="${i}" title="Transfer to another fund">⇄ Fund</button>` : ''}
        <button class="fund-action-btn fund-del"  data-fi="${i}" title="Delete fund">×</button>
      </div>`;
    fundsList.appendChild(card);
  });
};

/* ── Create fund modal ── */
function openAddFundModal() {
  /* close the funds panel so the modal sits cleanly on top */
  document.getElementById('navFundsPanel')?.classList.remove('open');
  document.getElementById('navFundsBtn')?.classList.remove('active');
  document.getElementById('newFundName').value    = '';
  document.getElementById('newFundBalance').value = '';
  document.getElementById('addFundModal').style.display = 'flex';
  document.getElementById('newFundName').focus({ preventScroll: true });
}
function closeAddFundModal() {
  document.getElementById('addFundModal').style.display = 'none';
}

document.getElementById('addFundBtn').addEventListener('click', openAddFundModal);
document.getElementById('addFundCancel').addEventListener('click', closeAddFundModal);
document.getElementById('addFundClose').addEventListener('click', closeAddFundModal);

document.getElementById('addFundSave').addEventListener('click', () => {
  const name = document.getElementById('newFundName').value.trim();
  if (!name) {
    document.getElementById('newFundName').focus();
    document.getElementById('newFundName').style.borderColor = '#dc2626';
    setTimeout(() => document.getElementById('newFundName').style.borderColor = '', 1500);
    return;
  }
  const balance = Math.max(0, Number(document.getElementById('newFundBalance').value || 0));
  if (!state.funds) state.funds = [];
  state.funds.push({ id: 'fund_' + Date.now(), name, balance });
  closeAddFundModal();
  renderFunds();
  saveState();
  showToast(`Fund "${name}" created`);
  /* reopen the funds panel so the user can manage the new fund */
  document.getElementById('navFundsPanel')?.classList.add('open');
  document.getElementById('navFundsBtn')?.classList.add('active');
});
document.getElementById('newFundName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addFundSave').click();
});

/* ── Fund transaction modal (add / move to account / transfer to fund) ── */
let _fundTxIndex = -1;
let _fundTxType  = 'add'; // 'add' | 'move' | 'xfer'

function openFundTxModal(index, type) {
  _fundTxIndex = index;
  _fundTxType  = type;
  const fund = state.funds[index];
  const destRow  = document.getElementById('fundTxDestRow');
  const destSel  = document.getElementById('fundTxDest');
  const noteEl   = document.getElementById('fundTxNote');
  const submitEl = document.getElementById('fundTxSubmit');
  const titleEl  = document.getElementById('fundTxTitle');

  document.getElementById('fundTxAmount').value = '';
  noteEl.value = '';

  if (type === 'add') {
    titleEl.textContent    = `Add to "${fund.name}"`;
    submitEl.textContent   = 'Add to Fund';
    noteEl.placeholder     = 'e.g. Monthly savings';
    destRow.style.display  = 'none';
  } else if (type === 'move') {
    titleEl.textContent    = `Move from "${fund.name}"`;
    submitEl.textContent   = 'Move';
    noteEl.placeholder     = 'e.g. Cover expenses';
    destRow.style.display  = '';
    destSel.innerHTML      = '';
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = `__profile__:${p.id}`;
      opt.textContent = p.name + (p.id === activeProfile ? ' (current)' : '');
      destSel.appendChild(opt);
    });
  } else if (type === 'xfer') {
    titleEl.textContent    = `Transfer from "${fund.name}"`;
    submitEl.textContent   = 'Transfer';
    noteEl.placeholder     = 'e.g. Consolidating funds';
    destRow.style.display  = '';
    destSel.innerHTML      = '';
    state.funds.forEach((f, i) => {
      if (i !== index) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = f.name;
        destSel.appendChild(opt);
      }
    });
  }

  document.getElementById('fundTxModal').style.display = 'flex';
  setTimeout(() => document.getElementById('fundTxAmount').focus(), 50);
}
function closeFundTxModal() {
  document.getElementById('fundTxModal').style.display = 'none';
  _fundTxIndex = -1;
}

document.getElementById('fundTxCancel').addEventListener('click', closeFundTxModal);
document.getElementById('fundTxModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('fundTxModal')) closeFundTxModal();
});

document.getElementById('fundTxSubmit').addEventListener('click', () => {
  const amount = Number(document.getElementById('fundTxAmount').value || 0);
  if (!amount || amount <= 0) {
    document.getElementById('fundTxAmount').focus();
    document.getElementById('fundTxAmount').style.borderColor = '#dc2626';
    setTimeout(() => document.getElementById('fundTxAmount').style.borderColor = '', 1500);
    return;
  }
  const note = document.getElementById('fundTxNote').value.trim();
  const fund = state.funds[_fundTxIndex];
  if (!fund) { closeFundTxModal(); return; }

  if (_fundTxType === 'add') {
    fund.balance = Number(fund.balance || 0) + amount;
    showToast(`+${formatMoney(amount)} added to "${fund.name}"`);

  } else if (_fundTxType === 'move' || _fundTxType === 'xfer') {
    if (amount > Number(fund.balance || 0)) {
      alert(`Not enough in "${fund.name}". Balance: ${formatMoney(Number(fund.balance || 0))}`);
      return;
    }
    fund.balance = Number(fund.balance || 0) - amount;

    const dest = document.getElementById('fundTxDest').value;
    if (dest.startsWith('__profile__:')) {
      const destProfileId = dest.slice('__profile__:'.length);
      const destProfile   = profiles.find(p => p.id === destProfileId);
      const depositEntry  = {
        name: note || `From fund: ${fund.name}`, amount, date: todayIso,
        fromFund: { id: fund.id, name: fund.name, profileId: activeProfile }
      };
      if (destProfileId === activeProfile) {
        /* Same tab — write directly into live state */
        if (!state.deposits) state.deposits = [];
        state.deposits.push(depositEntry);
        renderDeposits();
        calculateEndingBalance();
        renderNegativeAlert();
      } else {
        /* Different tab — load, patch, save that profile's data */
        const key = storageKeyForProfile(destProfileId);
        const raw = localStorage.getItem(key);
        let tState;
        try { tState = JSON.parse(raw); } catch(_) { tState = makeDefaultState(); }
        if (!tState.deposits) tState.deposits = [];
        tState.deposits.push(depositEntry);
        const tData = JSON.stringify(tState);
        localStorage.setItem(key, tData);
        window.cloudSync?.saveProfile(destProfileId, tData);
      }
      showToast(`${formatMoney(amount)} moved from "${fund.name}" → ${destProfile?.name ?? 'account'}`);
    } else {
      /* Transfer to another fund */
      const destFund = state.funds[Number(dest)];
      if (destFund) {
        destFund.balance = Number(destFund.balance || 0) + amount;
        showToast(`${formatMoney(amount)} transferred "${fund.name}" → "${destFund.name}"`);
      }
    }
  }

  closeFundTxModal();
  renderFunds();
  saveState();
});

/* event delegation on card buttons */
fundsList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-fi]');
  if (!btn) return;
  const i = Number(btn.dataset.fi);
  if (btn.classList.contains('fund-add'))  { openFundTxModal(i, 'add');  return; }
  if (btn.classList.contains('fund-move')) { openFundTxModal(i, 'move'); return; }
  if (btn.classList.contains('fund-xfer')) { openFundTxModal(i, 'xfer'); return; }
  if (btn.classList.contains('fund-del')) {
    const fund = state.funds[i];
    if (!confirm(`Delete "${fund.name}"${Number(fund.balance) ? ` (balance: ${formatMoney(Number(fund.balance))})` : ''}?`)) return;
    state.funds.splice(i, 1);
    renderFunds();
    saveState();
  }
});

renderFunds();
