import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

// One APK serves both restaurants -- same pattern as الفهد دليفري -- the
// waiter picks once on first launch, and every API call below is prefixed
// with whichever base URL that resolved to.
const RESTAURANTS = {
  tabarak: { label: 'مطعم ومشاوي تبارك', base: 'https://tabarak.al-fahad.co' },
  superkentucky: { label: 'سوبر كنتاكي', base: 'https://super-kentucky.al-fahad.co' },
};

const RESTAURANT_KEY = 'waiterapp.restaurant';
const AUTH_KEY = 'waiterapp.auth'; // base64 "user:pass" Basic token, same scheme as the dashboard's own authFetch
const USERNAME_KEY = 'waiterapp.username';

let state = {
  restaurant: null,
  authToken: null,
  username: null,
};

let callsPollTimer = null;
let ordersPollTimer = null;
let tablesPollTimer = null;
let activeTab = 'calls';
// Whether طلب مباشر's menu/tables have been fetched yet -- see switchTab.
let moLoadedOnce = false;

function $(id) { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
  $('tab-bar').style.display = id === 'screen-main' ? 'flex' : 'none';
}

function apiBase() {
  return RESTAURANTS[state.restaurant].base;
}

// Mirrors index.html's own authFetch/basicToken exactly -- a waiter account
// is a real dashboard_users row (permission 'waiter'), authenticated the
// same stateless-Basic-Auth way as any other staff login, not a separate
// token system like the driver app's phone+PIN.
async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers, state.authToken ? { Authorization: `Basic ${state.authToken}` } : {});
  const res = await fetch(`${apiBase()}${path}`, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    state.authToken = null;
    await Preferences.remove({ key: AUTH_KEY });
    stopPolling();
    $('login-restaurant-label').textContent = RESTAURANTS[state.restaurant].label;
    showScreen('screen-login');
  }
  return res;
}

function basicToken(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  return btoa(String.fromCharCode(...bytes));
}

// --- Boot -------------------------------------------------------------
async function boot() {
  const [{ value: restaurant }, { value: authToken }, { value: username }] = await Promise.all([
    Preferences.get({ key: RESTAURANT_KEY }),
    Preferences.get({ key: AUTH_KEY }),
    Preferences.get({ key: USERNAME_KEY }),
  ]);
  state.restaurant = restaurant || null;
  state.authToken = authToken || null;
  state.username = username || null;

  CapacitorUpdater.notifyAppReady().catch(() => {});

  if (!state.restaurant) return showScreen('screen-picker');
  checkForBundleUpdate();
  if (!state.authToken) {
    $('login-restaurant-label').textContent = RESTAURANTS[state.restaurant].label;
    return showScreen('screen-login');
  }
  enterMainScreen();
}

// Web-only OTA update (JS/HTML/CSS -- no reinstall) via capacitor-updater,
// same mechanism as الفهد دليفري's own checkForBundleUpdate. A native-level
// change (new permission/plugin) still needs a real new APK; this only
// covers everything else, which is most day-to-day changes (this exact
// category/order-list UI update is itself the first thing shipped this
// way). Best-effort: a failed check/download just leaves the current
// bundle running, never surfaced as an error.
async function checkForBundleUpdate() {
  try {
    const current = await CapacitorUpdater.current();
    const res = await fetch(`${apiBase()}/api/waiter-app/bundle-version?current=${encodeURIComponent(current.bundle.version)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (current.bundle.version === data.version) return;
    const next = await CapacitorUpdater.download({ version: data.version, url: data.url });
    await CapacitorUpdater.set(next); // reloads the WebView onto the new bundle
  } catch {
    // offline, download failed, or a corrupt zip -- capacitor-updater's own
    // checksum verification already refuses to `set()` a bad bundle, so the
    // app just keeps running the current one until the next check.
  }
}

// --- Restaurant picker --------------------------------------------------
document.querySelectorAll('#screen-picker button[data-restaurant]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    state.restaurant = btn.dataset.restaurant;
    await Preferences.set({ key: RESTAURANT_KEY, value: state.restaurant });
    checkForBundleUpdate();
    $('login-restaurant-label').textContent = RESTAURANTS[state.restaurant].label;
    showScreen('screen-login');
  });
});

$('change-restaurant-btn').addEventListener('click', async () => {
  stopPolling();
  state = { restaurant: null, authToken: null, username: null };
  await Promise.all([
    Preferences.remove({ key: RESTAURANT_KEY }),
    Preferences.remove({ key: AUTH_KEY }),
    Preferences.remove({ key: USERNAME_KEY }),
  ]);
  showScreen('screen-picker');
});

// --- Login ---------------------------------------------------------------
$('login-btn').addEventListener('click', async () => {
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  const errEl = $('login-error');
  errEl.style.display = 'none';
  if (!user || !pass) return;

  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'جاري الدخول...';
  try {
    const token = basicToken(user, pass);
    const res = await fetch(`${apiBase()}/api/me`, { headers: { Authorization: `Basic ${token}` } });
    if (!res.ok) {
      errEl.textContent = res.status === 401 ? 'اسم المستخدم أو كلمة المرور غير صحيحة.' : 'تعذر تسجيل الدخول.';
      errEl.style.display = 'block';
      return;
    }
    const me = await res.json();
    const canUseApp = me.isOwner || (me.permissions || []).includes('waiter') || (me.permissions || []).includes('orders');
    if (!canUseApp) {
      errEl.textContent = 'هذا الحساب ماكو عنده صلاحية نادل -- اطلب من صاحب المطعم يضيفها.';
      errEl.style.display = 'block';
      return;
    }
    state.authToken = token;
    state.username = me.username;
    await Promise.all([
      Preferences.set({ key: AUTH_KEY, value: token }),
      Preferences.set({ key: USERNAME_KEY, value: me.username }),
    ]);
    $('login-pass').value = '';
    enterMainScreen();
  } catch {
    errEl.textContent = 'تعذر الاتصال بالسيرفر.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'دخول';
  }
});

$('logout-btn').addEventListener('click', async () => {
  stopPolling();
  state.authToken = null;
  state.username = null;
  await Preferences.remove({ key: AUTH_KEY });
  $('login-restaurant-label').textContent = RESTAURANTS[state.restaurant].label;
  showScreen('screen-login');
});

function stopPolling() {
  if (callsPollTimer) clearInterval(callsPollTimer);
  if (ordersPollTimer) clearInterval(ordersPollTimer);
  if (tablesPollTimer) clearInterval(tablesPollTimer);
  callsPollTimer = null;
  ordersPollTimer = null;
  tablesPollTimer = null;
}

// --- Main shell / tabs ---------------------------------------------------
function enterMainScreen() {
  $('main-username').textContent = state.username || '';
  $('main-restaurant-label').textContent = RESTAURANTS[state.restaurant].label;
  showScreen('screen-main');
  switchTab('calls');
  loadCalls();
  loadOrders();
  // NOT loaded here -- it's the heaviest fetch (full menu + tables) and
  // firing it immediately alongside the two calls above right after login
  // was making the very first seconds after login noticeably janky
  // (reported as the keyboard/IME being slow to show up on later screens
  // too -- the WebView's JS thread was still busy rendering this tab's
  // markup). Deferred to switchTab() so it only runs once the الطلب
  // المباشر tab is actually opened.
  if (callsPollTimer) clearInterval(callsPollTimer);
  if (ordersPollTimer) clearInterval(ordersPollTimer);
  // Calls are time-sensitive (a customer is sitting there waiting) -- a
  // tighter poll than the 15s orders list, which is only "did the kitchen
  // move this order forward" and can afford to lag a bit more.
  callsPollTimer = setInterval(loadCalls, 6000);
  ordersPollTimer = setInterval(loadOrders, 15000);
  setupPushNotifications();
}

document.querySelectorAll('#tab-bar button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#tab-bar button[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-page').forEach((el) => {
    el.classList.toggle('active', el.id === `tab-page-${tab}`);
  });
  // Lazy: only fetched the first time this tab is actually opened, not at
  // login alongside نداءات/الطلبات (see enterMainScreen's own comment).
  if (tab === 'order' && !moLoadedOnce) {
    moLoadedOnce = true;
    loadManualOrderData();
  }
  // الطاولات only polls while it's the visible tab -- unlike نداءات/الطلبات
  // (time-sensitive, a customer or a hot order is waiting), a table's
  // occupied/empty status has no urgency once the waiter has moved on to
  // something else, so there's no reason to keep hitting the endpoint for a
  // screen nobody's looking at.
  if (tab === 'tables') {
    loadTables();
    if (!tablesPollTimer) tablesPollTimer = setInterval(loadTables, 10000);
  } else if (tablesPollTimer) {
    clearInterval(tablesPollTimer);
    tablesPollTimer = null;
  }
}

// --- نداءات (waiter calls) -----------------------------------------------
// calledAt is a raw epoch-ms number (see waiterCalls.js's record(), an
// in-memory Date.now() -- not a SQL datetime string like everywhere else in
// this app, since a call is never persisted to the database at all).
function timeAgo(epochMs) {
  const then = Number(epochMs);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'الحين';
  const mins = Math.round(secs / 60);
  return `قبل ${mins} د`;
}

async function loadCalls() {
  let res;
  try {
    res = await apiFetch('/api/waiter-calls');
  } catch {
    return; // transient network hiccup -- next poll retries
  }
  if (!res.ok) return;
  const calls = await res.json();
  renderCalls(calls);
}

function renderCalls(calls) {
  const container = $('calls-container');
  const dot = $('tab-calls-dot');
  dot.classList.toggle('show', calls.length > 0);
  if (calls.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="big">🔕</div><div>ماكو نداءات حالياً</div></div>';
    return;
  }
  container.innerHTML = `<div class="call-list">${calls.map((c) => `
    <div class="call-card">
      <div>
        <div class="table-label">🔔 طاولة ${escapeHtml(c.tableLabel)}</div>
        <div class="call-time">${timeAgo(c.calledAt)}</div>
      </div>
      <button type="button" data-dismiss-call="${c.tableId}">تم ✓</button>
    </div>`).join('')}</div>`;
  container.querySelectorAll('button[data-dismiss-call]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiFetch(`/api/waiter-calls/${btn.dataset.dismissCall}/dismiss`, { method: 'POST' });
      } catch {
        // best-effort -- if it fails, the call just reappears on the next poll
      }
      loadCalls();
    });
  });
}

// --- الطلبات (dine-in orders) ---------------------------------------------
async function loadOrders() {
  let res;
  try {
    res = await apiFetch('/api/waiter-app/orders');
  } catch {
    return;
  }
  if (!res.ok) return;
  const orders = await res.json();
  renderOrders(orders);
}

function renderOrders(orders) {
  const container = $('orders-container');
  if (orders.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="big">📭</div><div>ماكو طلبات صالة حالياً</div></div>';
    return;
  }
  container.innerHTML = `<div class="order-list">${orders.map((o) => renderOrderCard(o)).join('')}</div>`;
  container.querySelectorAll('button[data-served]').forEach((btn) => {
    btn.addEventListener('click', () => markServed(btn.dataset.served, btn));
  });
}

function renderOrderCard(o) {
  const itemsText = (o.items || []).map((it) => `${escapeHtml(displayItemName(it.name))} ×${it.qty}${it.note ? ` (${escapeHtml(it.note)})` : ''}`).join('<br>');
  return `
    <div class="order-card">
      <div class="row">
        <span class="order-id">#${o.daily_seq != null ? o.daily_seq : o.id}${o.customer_name ? ` — ${escapeHtml(o.customer_name)}` : ''}</span>
        <span class="total">${Number(o.total).toLocaleString('en-US')} د.ع</span>
      </div>
      ${o.tableLabel ? `<div class="table-line">🪑 طاولة ${escapeHtml(o.tableLabel)}</div>` : ''}
      <div class="items">${itemsText}</div>
      <div class="actions">
        <button class="primary" data-served="${o.id}">✅ تم التسليم</button>
      </div>
    </div>`;
}

async function markServed(orderId, btn) {
  btn.disabled = true;
  btn.textContent = 'جاري...';
  try {
    const res = await apiFetch(`/api/waiter-app/orders/${orderId}/served`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'تعذر التحديث.');
      btn.disabled = false;
      btn.textContent = '✅ تم التسليم';
      return;
    }
    loadOrders();
  } catch {
    alert('تعذر الاتصال بالسيرفر.');
    btn.disabled = false;
    btn.textContent = '✅ تم التسليم';
  }
}

// --- الطاولات (table status + تفريغ) --------------------------------------
async function loadTables() {
  let res;
  try {
    res = await apiFetch('/api/tables');
  } catch {
    return; // transient network hiccup -- next poll retries
  }
  if (!res.ok) return;
  renderTables(await res.json());
}

function renderTables(list) {
  const container = $('tables-container');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="big">🪑</div><div>ماكو طاولات مضافة</div></div>';
    return;
  }
  container.innerHTML = `<div class="table-list">${list.map((t) => `
    <div class="table-row">
      <span class="table-label">🪑 طاولة ${escapeHtml(t.label)}
        <span class="status-pill ${t.status === 'occupied' ? 'occupied' : 'empty'}">${t.status === 'occupied' ? 'مشغولة' : 'فارغة'}</span>
      </span>
      ${t.status === 'occupied' ? `<button data-clear-table="${t.id}">🧹 تفريغ</button>` : ''}
    </div>
  `).join('')}</div>`;
  container.querySelectorAll('button[data-clear-table]').forEach((btn) => {
    btn.addEventListener('click', () => clearTable(btn.dataset.clearTable, btn));
  });
}

async function clearTable(tableId, btn) {
  btn.disabled = true;
  btn.textContent = 'جاري...';
  try {
    const res = await apiFetch(`/api/tables/${tableId}/clear`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'تعذر التفريغ.');
      btn.disabled = false;
      btn.textContent = '🧹 تفريغ';
      return;
    }
    loadTables();
  } catch {
    alert('تعذر الاتصال بالسيرفر.');
    btn.disabled = false;
    btn.textContent = '🧹 تفريغ';
  }
}

// --- طلب مباشر (direct dine-in order) -------------------------------------
// Ported from each restaurant's own public/index.html mo-* manual-order
// code -- same touch-tile mechanics, dine_in only (see POST /api/orders/
// manual's server-side waiter restriction, which rejects pickup here anyway).
let moCart = []; // [{ id, name, price, qty, note }]
let moMenuItems = [];
let moTablesCache = [];
let moTableId = null;
let moLastFilter = '';
// Collapsed by default (see renderMoTableGrid) -- a waiter picking a table
// doesn't need every other table's button competing for screen space once
// theirs is chosen; tapping the collapsed summary re-opens the grid to
// change it.
let moTableGridOpen = false;

function moError(msg) {
  const el = $('mo-error');
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = msg;
  el.style.display = 'block';
}

function renderMoTableGrid() {
  const grid = $('mo-table-grid');
  if (!moTablesCache.length) {
    grid.innerHTML = '<div class="mo-empty-list">ماكو طاولات مضافة</div>';
    return;
  }
  if (!moTableGridOpen) {
    const selected = moTablesCache.find((t) => t.id === moTableId);
    grid.innerHTML = `
      <button type="button" class="mo-table-btn mo-table-summary" id="mo-table-open">
        <span class="mo-table-num">${selected ? escapeHtml(selected.label) : 'اختر الطاولة'}</span>
        <span class="mo-table-hint">${selected ? 'تغيير ▾' : '▾'}</span>
      </button>
    `;
    $('mo-table-open').addEventListener('click', () => {
      moTableGridOpen = true;
      renderMoTableGrid();
    });
    return;
  }
  grid.innerHTML = moTablesCache.map((t) => `
    <button type="button" class="mo-table-btn ${moTableId === t.id ? 'selected' : ''}" data-mo-table="${t.id}">
      <span class="mo-table-num">${escapeHtml(t.label)}</span>
      ${t.status === 'occupied' ? '<span class="mo-table-occupied">مشغولة</span>' : ''}
    </button>
  `).join('');
  grid.querySelectorAll('button[data-mo-table]').forEach((btn) => {
    btn.addEventListener('click', () => {
      moTableId = Number(btn.dataset.moTable);
      moTableGridOpen = false;
      renderMoTableGrid();
    });
  });
}

// null = showing the category grid; a category name = showing that
// category's own items with a "الأقسام" back button to the grid. Ported
// from each restaurant's own dashboard manual-order page so a waiter who's
// also cashiered there gets the identical picking flow, instead of every
// category's tiles stacked one under the other in one long scroll.
let moActiveCategory = null;

function categoryOf(it) { return (it.category || '').trim() || 'أخرى'; }

function moTileHtml(it) {
  const inCart = moCart.find((l) => l.id === it.id);
  const price = itemEffectivePrice(it);
  return `
    <button type="button" class="mo-item-tile${inCart ? ' in-cart' : ''}" data-mo-add="${it.id}">
      ${inCart ? `<span class="mo-tile-badge">${inCart.qty}</span>` : ''}
      <span class="mo-tile-name">${escapeHtml(displayItemName(it.name))}</span>
      <span class="mo-tile-price">${Number(price).toLocaleString()} د.ع</span>
    </button>`;
}

function wireMoTileButtons(container) {
  container.querySelectorAll('button[data-mo-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemId = Number(btn.dataset.moAdd);
      const item = moMenuItems.find((it) => it.id === itemId);
      // The picker only opens on the FIRST unit of an item with active
      // options -- same rule as the dashboard's own manual-order page:
      // once it's in the cart, tapping the tile again (or the cart's own
      // +/-) just adjusts quantity, since there's nowhere a second,
      // differently-chosen selection could live on one cart line anyway.
      const activeOptions = (item?.options || []).filter((o) => o.active);
      if (!moCart.find((l) => l.id === itemId) && activeOptions.length > 0) {
        openItemOptionsPicker(item, activeOptions, (picked) => {
          addToMoCart(itemId, picked.length > 0 ? picked.join('، ') : '');
        });
      } else {
        addToMoCart(itemId);
      }
    });
  });
}

// Multi-select sub-options picker (مقبلات -> باذنجانية/رمانية/...) -- same
// modal the dashboard's own manual-order page shows (openItemOptionsPicker
// there). `onConfirm` receives the array of picked option NAMES (not ids),
// joined with '، ' into the cart line's own note field.
let itemOptionsConfirmHandler = null;
function openItemOptionsPicker(item, activeOptions, onConfirm) {
  const maxSelect = item.option_max_select > 0 ? item.option_max_select : null;
  $('item-options-title').textContent = displayItemName(item.name);
  const introEl = $('item-options-intro');
  introEl.textContent = maxSelect
    ? `اختر حتى ${maxSelect} ${maxSelect === 1 ? 'خيار' : 'خيارات'}:`
    : 'اختار وحدة أو أكثر (اختياري):';
  const list = $('item-options-list');
  list.innerHTML = activeOptions.map((o) => `
    <label class="option-check">
      <input type="checkbox" value="${o.id}" data-opt-name="${escapeHtml(o.name)}">
      <span>${escapeHtml(o.name)}</span>
    </label>
  `).join('');
  if (maxSelect) {
    const checkboxes = [...list.querySelectorAll('input[type=checkbox]')];
    const applyLimit = () => {
      const checkedCount = checkboxes.filter((c) => c.checked).length;
      checkboxes.forEach((c) => {
        if (c.checked) return;
        c.disabled = checkedCount >= maxSelect;
        c.closest('.option-check').classList.toggle('option-check-disabled', c.disabled);
      });
      introEl.textContent = `اختر حتى ${maxSelect} ${maxSelect === 1 ? 'خيار' : 'خيارات'} (${checkedCount}/${maxSelect}):`;
    };
    checkboxes.forEach((c) => c.addEventListener('change', applyLimit));
    applyLimit();
  }
  itemOptionsConfirmHandler = () => {
    const picked = [...list.querySelectorAll('input:checked')].map((el) => el.dataset.optName);
    closeItemOptionsPicker();
    onConfirm(picked);
  };
  $('item-options-overlay').classList.add('open');
}
function closeItemOptionsPicker() {
  $('item-options-overlay').classList.remove('open');
  itemOptionsConfirmHandler = null;
}
$('item-options-close').addEventListener('click', closeItemOptionsPicker);
$('item-options-confirm').addEventListener('click', () => {
  if (itemOptionsConfirmHandler) itemOptionsConfirmHandler();
});

// A search query is a global override: it bypasses category mode entirely
// and flat-lists every matching item, since someone already typing a name
// doesn't want it scoped to whichever category tile happened to be open.
function renderMoItemList(filter) {
  moLastFilter = filter || '';
  const list = $('mo-item-list');
  const q = moLastFilter.trim();
  if (q) {
    const shown = moMenuItems.filter((it) => it.name.includes(q));
    list.innerHTML = shown.length === 0
      ? '<div class="mo-empty-list">ماكو أصناف مطابقة.</div>'
      : `<div class="mo-item-grid">${shown.map(moTileHtml).join('')}</div>`;
    wireMoTileButtons(list);
    return;
  }
  if (!moActiveCategory) {
    renderMoCategoryGrid();
    return;
  }
  // A category can empty out mid-open (its last item deactivated elsewhere)
  // -- fall back to the grid instead of leaving a dead, itemless screen up.
  const items = moMenuItems.filter((it) => categoryOf(it) === moActiveCategory);
  if (items.length === 0) { moActiveCategory = null; renderMoCategoryGrid(); return; }
  renderMoCategoryItems(moActiveCategory, items);
}

function renderMoCategoryGrid() {
  const list = $('mo-item-list');
  const categories = [...new Set(moMenuItems.map(categoryOf))];
  if (categories.length === 0) {
    list.innerHTML = '<div class="mo-empty-list">ماكو أصناف بالمنيو.</div>';
    return;
  }
  // Badge shows how many units from THIS category are already in the cart
  // -- lets the waiter see at a glance what's picked without opening it.
  list.innerHTML = `<div class="mo-category-grid">${categories.map((cat) => {
    const idsInCat = new Set(moMenuItems.filter((it) => categoryOf(it) === cat).map((it) => it.id));
    const cartQty = moCart.filter((l) => idsInCat.has(l.id)).reduce((s, l) => s + l.qty, 0);
    return `
      <button type="button" class="mo-category-tile" data-mo-category="${escapeHtml(cat)}">
        ${cartQty > 0 ? `<span class="mo-tile-badge">${cartQty}</span>` : ''}
        <span class="mo-category-name">${escapeHtml(cat)}</span>
      </button>`;
  }).join('')}</div>`;
  list.querySelectorAll('button[data-mo-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      moActiveCategory = btn.dataset.moCategory;
      renderMoItemList('');
    });
  });
}

function renderMoCategoryItems(cat, items) {
  const list = $('mo-item-list');
  list.innerHTML = `
    <div class="mo-category-header">
      <button type="button" class="secondary" id="mo-back-to-categories">🔙 الأقسام</button>
      <h4>${escapeHtml(cat)}</h4>
    </div>
    <div class="mo-item-grid">${items.map(moTileHtml).join('')}</div>`;
  $('mo-back-to-categories').addEventListener('click', () => {
    moActiveCategory = null;
    renderMoItemList('');
  });
  wireMoTileButtons(list);
}

// Super Kentucky's menu uses a trailing "(...)" on some item names as an
// internal variant note -- ported from its own index.html/order.html so
// this shared app displays the same trimmed name either restaurant hands
// it. A no-op for Tabarak, whose names never contain "(".
function displayItemName(name) {
  const i = name.indexOf('(');
  return i === -1 ? name : name.slice(0, i).trim();
}

// Same offer_price rule as each restaurant's own index.html/order.html
// itemEffectivePrice: only takes priority when it's a real, positive
// discount, never a stale/zero/higher value.
function itemEffectivePrice(item) {
  return item.offer_price != null && item.offer_price > 0 && item.offer_price < item.price
    ? item.offer_price
    : item.price;
}

function addToMoCart(itemId, note) {
  const item = moMenuItems.find((it) => it.id === itemId);
  if (!item) return;
  const existing = moCart.find((l) => l.id === itemId);
  if (existing) existing.qty += 1;
  else moCart.push({ id: item.id, name: displayItemName(item.name), price: itemEffectivePrice(item), qty: 1, note: note || '' });
  renderMoCart();
  renderMoItemList(moLastFilter);
}

function renderMoCart() {
  const container = $('mo-cart');
  if (moCart.length === 0) {
    container.innerHTML = '<div class="mo-empty-cart">السلة فارغة -- ضيف أصناف من فوق.</div>';
    return;
  }
  const total = moCart.reduce((sum, l) => sum + l.price * l.qty, 0);
  container.innerHTML = moCart.map((l) => `
    <div class="mo-cart-line">
      <div class="mo-cart-row">
        <span class="mo-cart-name">${escapeHtml(l.name)}</span>
        <span class="mo-cart-qty">
          <button type="button" data-mo-dec="${l.id}">−</button>
          <span>${l.qty}</span>
          <button type="button" data-mo-inc="${l.id}">+</button>
        </span>
        <span>${(l.price * l.qty).toLocaleString()} د.ع</span>
        <button type="button" class="mo-cart-remove" data-mo-remove="${l.id}">✕</button>
      </div>
      <input type="text" class="mo-cart-note" data-mo-note="${l.id}" placeholder="📝 ملاحظة (اختياري)" value="${escapeHtml(l.note || '')}">
    </div>`).join('') + `<div class="mo-cart-total">المجموع: ${total.toLocaleString()} د.ع</div>`;
  container.querySelectorAll('button[data-mo-inc]').forEach((btn) => {
    btn.addEventListener('click', () => addToMoCart(Number(btn.dataset.moInc)));
  });
  container.querySelectorAll('button[data-mo-dec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const line = moCart.find((l) => l.id === Number(btn.dataset.moDec));
      if (!line) return;
      line.qty -= 1;
      if (line.qty <= 0) moCart = moCart.filter((l) => l.id !== line.id);
      renderMoCart();
      renderMoItemList(moLastFilter);
    });
  });
  container.querySelectorAll('button[data-mo-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      moCart = moCart.filter((l) => l.id !== Number(btn.dataset.moRemove));
      renderMoCart();
      renderMoItemList(moLastFilter);
    });
  });
  // Updates the data model directly, WITHOUT calling renderMoCart() --
  // rebuilding the list's innerHTML on every keystroke would blur the
  // input and reset the cursor mid-word.
  container.querySelectorAll('input[data-mo-note]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const line = moCart.find((l) => l.id === Number(inp.dataset.moNote));
      if (line) line.note = inp.value.slice(0, 200);
    });
  });
}

async function loadManualOrderData() {
  moCart = [];
  moTableId = null;
  moTableGridOpen = false;
  moActiveCategory = null;
  moError(null);
  renderMoCart();
  $('mo-item-list').innerHTML = '<div class="mo-empty-list">جاري التحميل...</div>';
  $('mo-table-grid').innerHTML = '<div class="mo-empty-list">جاري التحميل...</div>';

  const [menuRes, tablesRes] = await Promise.all([
    apiFetch('/api/menu'),
    apiFetch('/api/tables'),
  ]);
  if (menuRes.ok) {
    const items = await menuRes.json();
    moMenuItems = items.filter((it) => it.active);
    renderMoItemList('');
  } else {
    $('mo-item-list').innerHTML = '<div class="mo-empty-list">تعذر تحميل المنيو.</div>';
  }
  if (tablesRes.ok) {
    moTablesCache = await tablesRes.json();
    renderMoTableGrid();
  } else {
    $('mo-table-grid').innerHTML = '<div class="mo-empty-list">تعذر تحميل الطاولات.</div>';
  }
}

$('mo-submit-btn').addEventListener('click', async () => {
  if (!moTableId) return moError('اختر الطاولة.');
  if (moCart.length === 0) return moError('السلة فارغة -- ضيف صنف وحد على الأقل.');
  moError(null);

  const btn = $('mo-submit-btn');
  btn.disabled = true;
  btn.textContent = 'جاري التثبيت...';
  try {
    const res = await apiFetch('/api/orders/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveryType: 'dine_in',
        tableId: moTableId,
        items: moCart.map((l) => ({ id: l.id, qty: l.qty, note: l.note || undefined })),
      }),
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      moError(info.error || 'تعذر تثبيت الطلب.');
      return;
    }
    switchTab('orders');
    loadOrders();
    loadManualOrderData();
  } catch {
    moError('تعذر الاتصال بالسيرفر.');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ تثبيت الطلب';
  }
});

// --- Push notifications ---------------------------------------------------
const NOTIFICATION_CHANNEL_ID = 'waiter_calls_v1';
async function ensureNotificationChannel() {
  try {
    await PushNotifications.createChannel({
      id: NOTIFICATION_CHANNEL_ID,
      name: 'نداءات النادل',
      description: 'إشعار عندما تنادي طاولة على النادل',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
    });
  } catch {
    // no-op on iOS, or a channel that already exists -- nothing fatal here
  }
}

async function setupPushNotifications() {
  try {
    const perm = await PushNotifications.checkPermissions();
    if (perm.receive !== 'granted') {
      const requested = await PushNotifications.requestPermissions();
      if (requested.receive !== 'granted') return;
    }
    await ensureNotificationChannel();
    await PushNotifications.register();
  } catch {
    // No Google Play services, or some other device-level limitation --
    // the 6s calls poll already covers it either way.
  }
}

PushNotifications.addListener('registration', (token) => {
  if (!state.authToken) return; // not logged in yet -- nothing to attach it to
  apiFetch('/api/waiter-app/fcm-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.value }),
  }).catch(() => {});
});

PushNotifications.addListener('registrationError', (err) => {
  console.error('Push registration failed:', err);
});

// Android only calls this while the app is foregrounded (a background/killed
// tap opens via the OS tray instead, which already played push.js's own
// sound) -- refresh the calls list immediately instead of waiting for the
// next 6s poll.
PushNotifications.addListener('pushNotificationReceived', (notification) => {
  if (notification?.data?.type === 'waiter_call' && document.getElementById('screen-main').classList.contains('active')) {
    loadCalls();
  }
});

boot();
