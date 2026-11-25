import { firebaseConfig } from './config.js';

// ---------- helpers (money is stored in agorot, integers) ----------
const toAg = v => Math.round(parseFloat(String(v).replace(',', '.')) * 100);
const fmt = ag => {
  const n = ag / 100;
  return '₪' + (Number.isInteger(n) ? n.toLocaleString('he-IL') : n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function equalShares(totalAg, ids) {
  const n = ids.length, base = Math.floor(totalAg / n); let rem = totalAg - base * n;
  const out = {}; ids.forEach(id => { out[id] = base + (rem > 0 ? 1 : 0); rem--; }); return out;
}
function balancesFor(expenses) {
  const bal = {};
  for (const e of expenses) {
    bal[e.payer] = (bal[e.payer] || 0) + e.total;
    for (const [pid, a] of Object.entries(e.shares)) bal[pid] = (bal[pid] || 0) - a;
  }
  return bal;
}
function settle(bal) {
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(bal)) { if (v > 0) cred.push({ id, v }); else if (v < 0) debt.push({ id, v: -v }); }
  cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const a = Math.min(debt[i].v, cred[j].v);
    if (a > 0) out.push({ from: debt[i].id, to: cred[j].id, amount: a });
    debt[i].v -= a; cred[j].v -= a;
    if (!debt[i].v) i++; if (!cred[j].v) j++;
  }
  return out;
}

// ---------- backends ----------
async function firebaseBackend() {
  const V = '10.12.2';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  let db;
  try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
  catch { db = fs.getFirestore(app); }
  const st = { people: [], expenses: [], meta: { round: 1, rounds: [] } };
  const got = new Set(); let cb = () => {};
  const emit = k => { got.add(k); if (got.size === 3) cb(st); };
  const onErr = e => { console.error(e); toast('שגיאת חיבור: ' + e.code); };
  fs.onSnapshot(fs.collection(db, 'people'), s => { st.people = s.docs.map(d => ({ id: d.id, ...d.data() })); emit('p'); }, onErr);
  fs.onSnapshot(fs.collection(db, 'expenses'), s => { st.expenses = s.docs.map(d => ({ id: d.id, ...d.data() })); emit('e'); }, onErr);
  fs.onSnapshot(fs.doc(db, 'meta', 'state'), d => { st.meta = d.exists() ? d.data() : { round: 1, rounds: [] }; emit('m'); }, onErr);
  const w = p => p.catch(onErr); // don't block UI; offline writes are queued
  return {
    local: false,
    subscribe(f) { cb = f; },
    addPerson: name => w(fs.addDoc(fs.collection(db, 'people'), { name, hidden: false, createdAt: Date.now() })),
    updatePerson: (id, data) => w(fs.updateDoc(fs.doc(db, 'people', id), data)),
    deletePerson: id => w(fs.deleteDoc(fs.doc(db, 'people', id))),
    saveExpense: (id, data) => w(id ? fs.setDoc(fs.doc(db, 'expenses', id), data) : fs.addDoc(fs.collection(db, 'expenses'), data)),
    deleteExpense: id => w(fs.deleteDoc(fs.doc(db, 'expenses', id))),
    setMeta: meta => w(fs.setDoc(fs.doc(db, 'meta', 'state'), meta)),
  };
}
function localBackend() {
  const K = 'eilat-local-db';
  const st = lsGet(K, { people: [], expenses: [], meta: { round: 1, rounds: [] } });
  let cb = () => {};
  const emit = () => { lsSet(K, st); cb(structuredClone(st)); };
  const id = () => Math.random().toString(36).slice(2, 11);
  return {
    local: true,
    subscribe(f) { cb = f; setTimeout(emit); },
    addPerson(name) { st.people.push({ id: id(), name, hidden: false, createdAt: Date.now() }); emit(); },
    updatePerson(pid, data) { Object.assign(st.people.find(p => p.id === pid), data); emit(); },
    deletePerson(pid) { st.people = st.people.filter(p => p.id !== pid); emit(); },
    saveExpense(eid, data) { if (eid) st.expenses = st.expenses.map(e => e.id === eid ? { id: eid, ...data } : e); else st.expenses.push({ id: id(), ...data }); emit(); },
    deleteExpense(eid) { st.expenses = st.expenses.filter(e => e.id !== eid); emit(); },
    setMeta(meta) { st.meta = meta; emit(); },
  };
}

// ---------- app ----------
const useFirebase = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith('PASTE');
let be;
try { be = useFirebase ? await firebaseBackend() : localBackend(); }
catch (e) { console.error(e); be = localBackend(); toast('לא הצלחתי להתחבר – מצב מקומי'); }
$('localBanner').hidden = !be.local;

let S = { people: [], expenses: [], meta: { round: 1, rounds: [] } };
const nameOf = id => S.people.find(p => p.id === id)?.name ?? '(נמחק)';
const visiblePeople = () => S.people.filter(p => !p.hidden).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const roundExpenses = r => S.expenses.filter(e => e.round === r).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

be.subscribe(st => { S = st; render(); });

function setOnline() {
  $('dot').classList.toggle('off', !navigator.onLine);
}
addEventListener('online', setOnline); addEventListener('offline', setOnline);

// tabs
const tabs = [...document.querySelectorAll('nav button')];
const curTab = lsGet('eilat-tab', 'expenses');
function showTab(t) {
  tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('on', s.id === t));
  lsSet('eilat-tab', t);
}
tabs.forEach(b => b.onclick = () => showTab(b.dataset.tab));
showTab(curTab);

function render() {
  setOnline();
  const r = S.meta.round;
  const exps = roundExpenses(r);
  const sum = exps.reduce((a, e) => a + e.total, 0);
  $('sub').textContent = `סבב ${r} · ${exps.length} הוצאות · סה״כ ${fmt(sum)}${navigator.onLine ? '' : ' · לא מחובר (יסונכרן)'}`;
  renderExpenses(exps, sum); renderBalances(exps); renderPeople(); renderHistory();
}

function expenseMeta(e) {
  const ids = Object.keys(e.shares);
  const vals = Object.values(e.shares);
  const allEq = vals.every(v => Math.abs(v - vals[0]) <= 1);
  const who = allEq
    ? `${ids.map(nameOf).join(', ')} · ${fmt(vals[0])} לאחד`
    : ids.map(id => `${nameOf(id)} ${fmt(e.shares[id])}`).join(', ');
  return `שילם/ה: <b>${esc(nameOf(e.payer))}</b><br>עבור: ${esc(who)}`;
}
function renderExpenses(exps, sum) {
  const el = $('expenses');
  if (!visiblePeople().length) { el.innerHTML = `<div class="empty">קודם מוסיפים את החברים בלשונית <b>חברים</b> 👥</div>`; return; }
  if (!exps.length) { el.innerHTML = `<div class="empty">אין עדיין הוצאות בסבב הזה.<br>לוחצים על <b>+ הוצאה חדשה</b> 🍻</div>`; return; }
  el.innerHTML = exps.map(e => `
    <div class="card exp" data-id="${e.id}">
      <div class="top"><span>${esc(e.desc || 'הוצאה')}</span><span>${fmt(e.total)}</span></div>
      <div class="meta">${expenseMeta(e)}</div>
    </div>`).join('');
  el.querySelectorAll('.exp').forEach(c => c.onclick = () => openExpense(S.expenses.find(x => x.id === c.dataset.id)));
}

function renderBalances(exps) {
  const el = $('balances');
  const bal = balancesFor(exps);
  const ids = new Set([...visiblePeople().map(p => p.id), ...Object.keys(bal)]);
  const xf = settle(bal);
  const rows = [...ids].map(id => ({ id, v: bal[id] || 0 })).sort((a, b) => b.v - a.v);
  el.innerHTML = `
    <h2>💸 מי מעביר למי</h2>
    <div class="card">${xf.length ? xf.map(t => `
      <div class="xfer"><b>${esc(nameOf(t.from))}</b> ← <b>${esc(nameOf(t.to))}</b><span class="amt">${fmt(t.amount)}</span></div>`).join('')
      : '<div class="empty" style="padding:16px">כולם מאוזנים 🎉</div>'}</div>
    <h2>📊 מאזן לכל אחד</h2>
    <div class="card">${rows.map(r => `
      <div class="row"><span>${esc(nameOf(r.id))}</span>
      <span class="${r.v > 0 ? 'pos' : r.v < 0 ? 'neg' : 'zero'}">${r.v > 0 ? 'מקבל/ת ' + fmt(r.v) : r.v < 0 ? 'חייב/ת ' + fmt(-r.v) : 'מאוזן'}</span></div>`).join('')}</div>
    <h2>🔄 סגירת סבב</h2>
    <div class="card">
      <div class="hint" style="margin-top:0">אחרי שכולם העבירו את הכסף – סוגרים את הסבב. ההוצאות והחישוב נשמרים בהיסטוריה, והחברים נשארים.</div>
      <div class="actions"><button class="btn danger grow" id="closeRound" ${exps.length ? '' : 'disabled'}>סגור סבב ${S.meta.round} והתחל חדש</button></div>
    </div>`;
  const btn = $('closeRound');
  if (btn) btn.onclick = () => {
    if (!confirm(`לסגור את סבב ${S.meta.round}? כל היתרות יתאפסו (ההיסטוריה נשמרת).`)) return;
    const summary = {
      round: S.meta.round, closedAt: Date.now(), count: exps.length,
      total: exps.reduce((a, e) => a + e.total, 0),
      transfers: xf.map(t => ({ ...t, fromName: nameOf(t.from), toName: nameOf(t.to) })),
    };
    be.setMeta({ round: S.meta.round + 1, rounds: [...(S.meta.rounds || []), summary] });
    toast('הסבב נסגר ✔');
  };
}

function renderPeople() {
  const el = $('people');
  const ppl = visiblePeople();
  el.innerHTML = `
    <div class="card"><div class="addp"><input id="newName" placeholder="שם חבר/ה" maxlength="30"><button class="btn primary" id="addBtn">הוסף</button></div></div>
    <div class="card">${ppl.length ? ppl.map(p => `
      <div class="row"><span>${esc(p.name)}</span><span>
        <button class="btn ghost small" data-ren="${p.id}">שנה שם</button>
        <button class="btn danger small" data-del="${p.id}">מחק</button></span></div>`).join('')
      : '<div class="empty" style="padding:16px">אין עדיין חברים</div>'}</div>`;
  const add = () => {
    const name = $('newName').value.trim(); if (!name) return;
    const ex = S.people.find(p => p.name === name);
    if (ex && !ex.hidden) return toast('השם כבר קיים');
    if (ex) be.updatePerson(ex.id, { hidden: false }); else be.addPerson(name);
    $('newName').value = ''; $('newName').focus();
  };
  $('addBtn').onclick = add;
  $('newName').onkeydown = e => { if (e.key === 'Enter') add(); };
  el.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
    const p = S.people.find(x => x.id === b.dataset.ren);
    const n = prompt('שם חדש:', p.name)?.trim();
    if (n && n !== p.name) {
      if (S.people.some(x => x.name === n && x.id !== p.id && !x.hidden)) return toast('השם כבר קיים');
      be.updatePerson(p.id, { name: n });
    }
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const id = b.dataset.del;
    const inRound = roundExpenses(S.meta.round).some(e => e.payer === id || id in e.shares);
    if (inRound) return alert(`אי אפשר למחוק את ${nameOf(id)} – מופיע/ה בהוצאות של הסבב הנוכחי. קודם עורכים/מוחקים את ההוצאות או סוגרים סבב.`);
    if (!confirm(`למחוק את ${nameOf(id)}?`)) return;
    const used = S.expenses.some(e => e.payer === id || id in e.shares);
    used ? be.updatePerson(id, { hidden: true }) : be.deletePerson(id); // keep name for history
  });
}

function renderHistory() {
  const el = $('history');
  const rounds = [...(S.meta.rounds || [])].reverse();
  if (!rounds.length) { el.innerHTML = '<div class="empty">עוד לא נסגרו סבבים</div>'; return; }
  el.innerHTML = rounds.map(r => {
    const exps = roundExpenses(r.round);
    return `<div class="card">
      <div class="top" style="display:flex;justify-content:space-between;font-weight:500"><span>סבב ${r.round}</span><span>${fmt(r.total)}</span></div>
      <div class="total">נסגר ${new Date(r.closedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })} · ${r.count} הוצאות</div>
      ${r.transfers.length ? r.transfers.map(t => `<div class="xfer"><b>${esc(t.fromName)}</b> ← <b>${esc(t.toName)}</b><span class="amt">${fmt(t.amount)}</span></div>`).join('') : '<div class="hint">היה מאוזן</div>'}
      <details><summary>ההוצאות בסבב</summary>${exps.map(e => `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between"><span>${esc(e.desc || 'הוצאה')}</span><span>${fmt(e.total)}</span></div><div class="hint" style="margin-top:2px">${expenseMeta(e)}</div></div>`).join('')}</details>
    </div>`;
  }).join('');
}

// ---------- expense dialog ----------
$('fab').onclick = () => {
  if (!visiblePeople().length) { showTab('people'); return toast('קודם מוסיפים חברים'); }
  openExpense(null);
};
function openExpense(exp) {
  const ppl = visiblePeople();
  // include hidden people that are part of an edited expense
  const extra = exp ? [exp.payer, ...Object.keys(exp.shares)].filter(id => !ppl.some(p => p.id === id)).map(id => ({ id, name: nameOf(id) })) : [];
  const all = [...ppl, ...extra];
  const f = {
    desc: exp?.desc || '',
    payer: exp?.payer || (all.some(p => p.id === lsGet('eilat-me')) ? lsGet('eilat-me') : all[0].id),
    total: exp ? String(exp.total / 100) : '',
    mode: exp?.mode || 'equal',
    sel: new Set(exp ? Object.keys(exp.shares) : all.map(p => p.id)),
    custom: Object.fromEntries(all.map(p => [p.id, exp && exp.shares[p.id] != null && exp.mode === 'custom' ? String(exp.shares[p.id] / 100) : ''])),
  };
  const body = $('dlgBody');
  body.innerHTML = `
    <h3>${exp ? 'עריכת הוצאה' : 'הוצאה חדשה'}</h3>
    <label class="f">על מה?</label><input id="fDesc" placeholder="בירות, בייגלה, מונית…" value="${esc(f.desc)}" maxlength="60">
    <label class="f">מי שילם?</label>
    <select id="fPayer">${all.map(p => `<option value="${p.id}" ${p.id === f.payer ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <label class="f">כמה שולם סה״כ (₪)?</label><input id="fTotal" inputmode="decimal" placeholder="0" value="${esc(f.total)}">
    <div class="seg"><button data-m="equal">חלוקה שווה</button><button data-m="custom">סכום לכל אחד</button></div>
    <div id="splitArea"></div>
    <div class="hint" id="fHint"></div>
    <div class="actions">
      <button class="btn primary grow" id="fSave">שמור</button>
      ${exp ? '<button class="btn danger" id="fDel">מחק</button>' : ''}
      <button class="btn ghost" id="fCancel">ביטול</button>
    </div>`;
  const totalAg = () => { const v = $('fTotal').value.trim(); return v ? toAg(v) : NaN; };
  function drawSplit() {
    body.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.m === f.mode));
    const area = $('splitArea');
    if (f.mode === 'equal') {
      area.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px"><span class="hint" style="margin:0">בין מי מתחלק?</span>
        <span><button class="linkbtn" id="selAll">כולם</button><button class="linkbtn" id="selNone">אף אחד</button></span></div>
        <div class="chips">${all.map(p => `<button class="chip ${f.sel.has(p.id) ? 'on' : ''}" data-p="${p.id}">${esc(p.name)}</button>`).join('')}</div>`;
      area.querySelectorAll('.chip').forEach(c => c.onclick = () => { f.sel.has(c.dataset.p) ? f.sel.delete(c.dataset.p) : f.sel.add(c.dataset.p); drawSplit(); });
      $('selAll').onclick = () => { all.forEach(p => f.sel.add(p.id)); drawSplit(); };
      $('selNone').onclick = () => { f.sel.clear(); drawSplit(); };
    } else {
      area.innerHTML = `<div class="hint">כמה כל אחד צריך לשלם (משאירים ריק למי שלא השתתף):</div>` +
        all.map(p => `<div class="custom-row"><span>${esc(p.name)}</span><input inputmode="decimal" data-c="${p.id}" placeholder="0" value="${esc(f.custom[p.id])}"></div>`).join('');
      area.querySelectorAll('[data-c]').forEach(i => i.oninput = () => { f.custom[i.dataset.c] = i.value; validate(); });
    }
    validate();
  }
  function compute() {
    const t = totalAg();
    if (f.mode === 'equal') {
      const ids = [...f.sel];
      if (!(t > 0)) return { err: 'צריך להזין סכום' };
      if (!ids.length) return { err: 'צריך לבחור לפחות אדם אחד' };
      const shares = equalShares(t, ids);
      return { total: t, shares, info: `${fmt(Math.floor(t / ids.length))} לכל אחד (${ids.length} אנשים)` };
    }
    const shares = {};
    for (const [id, v] of Object.entries(f.custom)) {
      if (!v.trim()) continue;
      const a = toAg(v);
      if (isNaN(a) || a < 0) return { err: 'סכום לא תקין' };
      if (a > 0) shares[id] = a;
    }
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (!sum) return { err: 'צריך להזין סכומים' };
    if (isNaN(t)) return { total: sum, shares, info: `סה״כ ${fmt(sum)} (יחושב אוטומטית)` };
    if (sum !== t) return { err: sum < t ? `נשאר לחלק ${fmt(t - sum)}` : `חרגת ב-${fmt(sum - t)}` };
    return { total: t, shares, info: 'הסכומים מסתדרים ✔' };
  }
  function validate() {
    const r = compute();
    $('fHint').textContent = r.err || r.info; $('fHint').classList.toggle('err', !!r.err);
    $('fSave').disabled = !!r.err;
  }
  body.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    if (b.dataset.m === 'custom' && f.mode === 'equal') { // prefill from equal split
      const t = totalAg(); const ids = [...f.sel];
      if (t > 0 && ids.length) { const sh = equalShares(t, ids); all.forEach(p => f.custom[p.id] = sh[p.id] ? String(sh[p.id] / 100) : ''); }
    }
    f.mode = b.dataset.m; drawSplit();
  });
  $('fTotal').oninput = validate;
  $('fSave').onclick = () => {
    const r = compute(); if (r.err) return;
    const payer = $('fPayer').value; lsSet('eilat-me', payer);
    be.saveExpense(exp?.id || null, {
      desc: $('fDesc').value.trim(), payer, total: r.total, shares: r.shares, mode: f.mode,
      round: exp?.round ?? S.meta.round, createdAt: exp?.createdAt ?? Date.now(), updatedAt: Date.now(),
    });
    $('dlg').close(); toast(exp ? 'עודכן ✔' : 'נשמר ✔');
  };
  if (exp) $('fDel').onclick = () => { if (confirm('למחוק את ההוצאה?')) { be.deleteExpense(exp.id); $('dlg').close(); toast('נמחק'); } };
  $('fCancel').onclick = () => $('dlg').close();
  drawSplit();
  $('dlg').showModal();
}
