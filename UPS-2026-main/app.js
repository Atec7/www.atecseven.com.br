// ===== FIREBASE CONFIG =====
var DB_BASE_URL = 'https://babearia-jhosuan-default-rtdb.firebaseio.com';

// Versão atual do app. Ao publicar uma nova versão, atualize ESTE valor,
// o VERSION em sw.js e o "version" em version.json (devem ser iguais).
var APP_VERSION = '1.4.4';

// ===== UTILITIES =====
var currentUser = null;
var map = null;
var mapMarkers = [];
var refreshInterval = null;
var teamCatalogCache = [];
var userCache = [];
var rulesCache = [];
var adminLocation = null;
var adminAddress = '';
var celebratedTeams = new Set();
var adminBound = false;

function $(id) { return document.getElementById(id); }

// ===== PREFERÊNCIAS LOCAIS (tema, visualização, aba) =====
function loadPref(key, def) {
  try { var v = localStorage.getItem('ups_' + key); return v === null ? def : v; } catch (e) { return def; }
}
function savePref(key, value) {
  try { localStorage.setItem('ups_' + key, value); } catch (e) {}
}

// ===== TEMA CLARO / ESCURO =====
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var icons = document.querySelectorAll('.theme-icon');
  for (var i = 0; i < icons.length; i++) icons[i].textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1120' : '#2563eb');
}
function toggleTheme() {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  savePref('theme', next);
  applyTheme(next);
}

function togglePassword(inputId, btn) {
  var input = $(inputId);
  if (!input) return;
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (btn) btn.innerHTML = '<span class="material-symbols-outlined">' + (show ? 'visibility_off' : 'visibility') + '</span>';
}

// Equipes são usuários com role 'equipe' (ou sem role, padrão legado)
function isTeamUser(u) {
  return !!u && (!u.role || u.role === 'equipe');
}

// ===== FILTROS (componentes reutilizáveis) =====
function toggleFilterBar(id) {
  var bar = $(id);
  if (bar) bar.classList.toggle('open');
}

function valOf(id) {
  var el = $(id);
  return el ? el.value : '';
}

// Preenche um <select> preservando o valor atual
function fillSelect(id, options, placeholder) {
  var sel = $(id);
  if (!sel) return;
  var current = sel.value;
  var html = '<option value="">' + escapeHtml(placeholder) + '</option>';
  options.forEach(function(o) {
    html += '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>';
  });
  sel.innerHTML = html;
  var exists = options.some(function(o) { return o.value === current; });
  sel.value = exists ? current : '';
}

// Destaca selects com filtro ativo e atualiza o contador do botão "Filtros"
function markActiveFilters(ids, countId) {
  var n = 0;
  ids.forEach(function(id) {
    var el = $(id);
    if (!el) return;
    var active = !!el.value;
    if (el.tagName === 'SELECT') el.classList.toggle('is-set', active);
    if (active) n++;
  });
  var c = $(countId);
  if (c) { c.textContent = n; c.classList.toggle('show', n > 0); }
  return n;
}

function clearFilters(ids, cb) {
  ids.forEach(function(id) { var el = $(id); if (el) el.value = ''; });
  if (cb) cb();
}

function uniqueSorted(values) {
  var seen = {};
  var out = [];
  values.forEach(function(v) { if (v && !seen[v]) { seen[v] = true; out.push(v); } });
  return out.sort(function(a, b) { return a.localeCompare(b, 'pt-BR'); });
}

function supervisorOptions(teams) {
  var opts = uniqueSorted(teams.map(function(t) { return t.supervisor; })).map(function(s) { return { value: s, label: s }; });
  if (teams.some(function(t) { return !t.supervisor; })) opts.push({ value: '__none__', label: 'Sem supervisor' });
  return opts;
}

function processOptions(teams) {
  var opts = uniqueSorted(teams.map(function(t) { return t.process; })).map(function(p) { return { value: p, label: p }; });
  if (teams.some(function(t) { return !t.process; })) opts.push({ value: '__none__', label: 'Sem processo' });
  return opts;
}

function classOptions() {
  return (rulesCache || []).map(function(r) { return { value: r.class, label: 'Classe ' + r.class }; });
}

// ===== METAS DE PERDAS (por categoria de execução, não por dinheiro) =====
var PERDAS_CATS = [
  { key: 'fiscalizacao', label: 'Fiscalização', short: 'Fisc.' },
  { key: 'normalizacao', label: 'Normalização', short: 'Norm.' },
  { key: 'fraude', label: 'Fraude', short: 'Fraude' }
];

// Cada lançamento conta 1 execução em cada categoria marcada na atividade
function perdasCounts(services) {
  var c = { fiscalizacao: 0, normalizacao: 0, fraude: 0 };
  (services || []).forEach(function(s) {
    (s.categories || []).forEach(function(k) { if (c[k] !== undefined) c[k]++; });
  });
  return c;
}

function perdasGoalsOf(user) {
  return {
    fiscalizacao: Number(user && user.goal_fiscalizacao) || 0,
    normalizacao: Number(user && user.goal_normalizacao) || 0,
    fraude: Number(user && user.goal_fraude) || 0
  };
}

// Lista das metas de PERDAS definidas para a equipe, com o realizado
function perdasGoalRows(t) {
  if (!t || t.sector !== 'PERDAS' || !t.perdasGoals) return [];
  var counts = t.perdas || {};
  return PERDAS_CATS.filter(function(c) { return t.perdasGoals[c.key] > 0; }).map(function(c) {
    var goal = t.perdasGoals[c.key], done = counts[c.key] || 0;
    return { key: c.key, label: c.label, short: c.short, goal: goal, done: done, pct: (done / goal) * 100 };
  });
}

// Texto curto da meta para tabelas (R$ no STC, quantidades em PERDAS)
function goalLabelOf(t) {
  if (t.sector === 'PERDAS') {
    var rows = perdasGoalRows(t);
    return rows.length ? rows.map(function(r) { return r.short + ' ' + r.goal; }).join(' · ') : '';
  }
  return t.goal_money > 0 ? fmtMoney(t.goal_money) : '';
}

// Completa um resumo de equipe com setor, metas e contagens de PERDAS
function withSectorInfo(summary, user, services) {
  summary.sector = sectorOf(user);
  summary.perdasGoals = perdasGoalsOf(user);
  summary.perdas = perdasCounts(services);
  return summary;
}

function teamGoalPct(t) {
  if (t.sector === 'PERDAS') {
    var rows = perdasGoalRows(t);
    if (!rows.length) return -1;
    return rows.reduce(function(s, r) { return s + Math.min(r.pct, 100); }, 0) / rows.length;
  }
  return t.goal_money > 0 ? (t.totalMoney / t.goal_money) * 100 : -1;
}

function matchOptional(filterValue, actual) {
  if (!filterValue) return true;
  if (filterValue === '__none__') return !actual;
  return actual === filterValue;
}

// Filtro comum para listas de equipes (painel, monitor, mapa)
function applyTeamFilters(data, f) {
  return data.filter(function(t) {
    if (f.search && String(t.username || '').toLowerCase().indexOf(f.search) === -1) return false;
    if (!matchOptional(f.supervisor, t.supervisor)) return false;
    if (!matchOptional(f.process, t.process)) return false;
    if (f.sector && t.sector !== f.sector) return false;
    if (f.cls && t.class !== f.cls) return false;
    if (f.status && getStatusInfo(t.lastSeen).status !== f.status) return false;
    if (f.goal) {
      var p = teamGoalPct(t);
      if (f.goal === 'hit' && !(p >= 100)) return false;
      if (f.goal === 'below' && !(p >= 0 && p < 100)) return false;
      if (f.goal === 'none' && p !== -1) return false;
      if (f.goal === 'idle' && t.count > 0) return false;
    }
    return true;
  });
}

function sortTeams(arr, key) {
  var cmp = {
    ups: function(a, b) { return b.totalUps - a.totalUps; },
    money: function(a, b) { return b.totalMoney - a.totalMoney; },
    count: function(a, b) { return b.count - a.count; },
    goal: function(a, b) { return teamGoalPct(b) - teamGoalPct(a); },
    name: function(a, b) { return String(a.username || '').localeCompare(String(b.username || ''), 'pt-BR'); }
  }[key] || function(a, b) { return b.totalUps - a.totalUps; };
  return arr.slice().sort(cmp);
}

// Posição real de cada equipe por UPS (não muda com filtros/ordenação)
function upsRankMap(data) {
  var rank = {};
  data.slice().sort(function(a, b) { return b.totalUps - a.totalUps; }).forEach(function(t, i) { rank[t.userId] = i + 1; });
  return rank;
}

function medalFor(pos) {
  return pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : '#' + pos;
}

function kpi(iconCls, icon, value, label, sub, wrap) {
  return '<div class="stat-box"><span class="stat-box-icon ' + iconCls + '"><span class="material-symbols-outlined">' + icon + '</span></span>' +
    '<div><div class="stat-box-value' + (wrap ? ' wrap' : '') + '" title="' + escapeHtml(String(value).replace(/<[^>]+>/g, '')) + '">' + value + '</div>' +
    '<div class="stat-box-label">' + label + '</div>' +
    (sub ? '<div class="stat-box-sub">' + sub + '</div>' : '') + '</div></div>';
}

function goalColor(pct) {
  return pct >= 100 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--money)';
}

function progressHtml(label, pct, color, valueLabel) {
  var w = Math.max(0, Math.min(100, pct));
  return '<div><div class="progress-meta"><span>' + label + '</span><strong style="color:' + color + ';">' + (valueLabel || Math.round(pct) + '%') + '</strong></div>' +
    '<div class="progress"><span style="width:' + w + '%;background:' + color + ';"></span></div></div>';
}

function goalProgressHtml(t) {
  if (t.sector === 'PERDAS') {
    return perdasGoalRows(t).map(function(r) {
      return progressHtml(r.label + ': ' + r.done + ' / ' + r.goal, r.pct, goalColor(r.pct));
    }).join('');
  }
  if (!(t.goal_money > 0)) return '';
  var pct = (t.totalMoney / t.goal_money) * 100;
  return progressHtml('Meta: ' + fmtMoney(t.goal_money), pct, goalColor(pct));
}

function typeLabelOf(type) {
  return type === 'miscellany' ? 'Miscelânea' : (type === 'emergency' ? 'Emergência' : (type === 'commercial' ? 'Comercial' : (type === 'perdas' ? 'Perdas' : (type || '—'))));
}

// ===== PERÍODOS RÁPIDOS =====
var RANGE_TARGETS = {
  admin: { start: 'adminStartDate', end: 'adminEndDate', presets: 'adminPresets', load: function() { loadAllAdminData(); } },
  mon: { start: 'monStartDate', end: 'monEndDate', presets: 'monPresets', load: function() { loadMonitorView(); } },
  auditoria: { start: 'auditoriaStartDate', end: 'auditoriaEndDate', presets: 'auditoriaPresets', load: function() { loadAuditoria(); } },
  classificacao: { start: 'classificacaoStartDate', end: 'classificacaoEndDate', presets: 'classificacaoPresets', load: function() { loadClassificacao(); } },
  apontamento: { start: 'apontamentoStartDate', end: 'apontamentoEndDate', presets: 'apontamentoPresets', load: function() { loadApontamentos(); } }
};

function presetRange(key) {
  var now = new Date();
  var today = todayStr();
  if (key === 'today') return { start: today, end: today };
  if (key === 'yesterday') { var y = daysAgoStr(1); return { start: y, end: y }; }
  if (key === '7d') return { start: daysAgoStr(6), end: today };
  if (key === 'month') return currentMonthRange();
  if (key === 'lastmonth') {
    return {
      start: formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      end: formatDate(new Date(now.getFullYear(), now.getMonth(), 0))
    };
  }
  return null;
}

function setRangePreset(target, key) {
  var t = RANGE_TARGETS[target];
  var r = presetRange(key);
  if (!t || !r) return;
  $(t.start).value = clampDateToAllowed(r.start);
  $(t.end).value = clampDateToAllowed(r.end);
  markPresets(target);
  t.load();
}

function markPresets(target) {
  var t = RANGE_TARGETS[target];
  if (!t) return;
  var box = $(t.presets);
  if (!box) return;
  var s = valOf(t.start), e = valOf(t.end);
  var chips = box.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    var r = presetRange(chips[i].getAttribute('data-preset'));
    chips[i].classList.toggle('active', !!r && r.start === s && r.end === e);
  }
}

function periodLabel(start, end) {
  if (!start || !end) return '';
  if (start === end) return start === todayStr() ? 'Hoje' : formatDateBr(start);
  return formatDateBr(start) + ' a ' + formatDateBr(end);
}

function toast(text, type) {
  type = type || 'info';
  var container = $('toastContainer');
  var el = document.createElement('div');
  var icons = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info' };
  el.className = 'toast toast-' + type;
  el.innerHTML = '<span class="material-symbols-outlined">' + (icons[type] || 'info') + '</span>' + text;
  container.appendChild(el);
  setTimeout(function() {
    el.classList.add('removing');
    setTimeout(function() { el.remove(); }, 250);
  }, 3500);
}

function showMsg(id, type, text) {
  var el = $(id);
  if (!el) return;
  var icons = { error: 'error', success: 'check_circle', warning: 'warning' };
  el.className = 'msg ' + type;
  el.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">' + (icons[type] || 'info') + '</span> ' + text;
  if (type === 'success') {
    setTimeout(function() { el.style.display = 'none'; }, 3500);
  }
}

function clearMsg(id) {
  var el = $(id);
  if (el) { el.className = 'msg'; el.style.display = 'none'; }
}

function showView(id) {
  var views = document.querySelectorAll('.view, #loginView');
  for (var i = 0; i < views.length; i++) views[i].classList.remove('active');
  var target = $(id);
  if (target) target.classList.add('active');
}

function loading(show) {
  $('loadingOverlay').classList.toggle('hidden', !show);
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatDateBr(dateStr) {
  var parts = dateStr.split('-');
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function fmtMoney(v) {
  var n = Number(v) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ===== FIREBASE HELPERS (REST API + OFFLINE) =====
// Todas as chamadas passam pelo OfflineDB (db.js): leem do espelho local
// quando offline e enfileiram escritas para sincronizar quando houver rede.
function fbUrl(path) {
  return DB_BASE_URL + (path ? '/' + path : '') + '.json';
}

function fbOnce(path) {
  return OfflineDB.read(path);
}

function fbPush(path, data) {
  return OfflineDB.push(path, data);
}

function fbUpdate(path, data) {
  return OfflineDB.update(path, data);
}

function fbRemove(path) {
  return OfflineDB.remove(path);
}

function toArray(obj) {
  if (!obj) return [];
  return Object.keys(obj).map(function(k) {
    var item = obj[k];
    if (typeof item === 'object' && item !== null) {
      item.id = k;
    }
    return item;
  });
}

function nowTimestamp() {
  return Date.now();
}

// ===== CACHE DE LEITURA COM TTL (economia de download) =====
// Reutiliza a MESMA Promise em cache por TTL: painéis que leem o mesmo
// caminho várias vezes no ciclo de 30s fazem UM único download compartilhado.
var memoryCache = {};
var CACHE_TTL = 30000;

function fbCached(path, ttl) {
  ttl = ttl || CACHE_TTL;
  var key = path + '|' + ttl;
  var now = Date.now();
  var entry = memoryCache[key];
  if (entry && (now - entry.t) < ttl) return entry.p;
  var p = OfflineDB.readCached(path, ttl).catch(function(err) {
    delete memoryCache[key];
    throw err;
  });
  memoryCache[key] = { t: now, p: p };
  return p;
}

function clearCachedReads() {
  memoryCache = {};
}

// ===== PERÍODO E FUNÇÕES DE ROLE =====
function formatDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function currentMonthRange() {
  var now = new Date();
  var start = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
  var end = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  return { start: start, end: end };
}

function roleLabel(role) {
  if (role === 'admin') return 'Administrador';
  if (role === 'supervisor') return 'Supervisor';
  if (role === 'equipe') return 'Equipe';
  if (role === 'user') return 'Usuário';
  return role || '';
}

// Equipes que o usuário atual pode VISUALIZAR. admin = todas (null).
function getUserTeamIds() {
  if (!currentUser) return [];
  if (currentUser.role === 'admin') return null;
  if (currentUser.role === 'equipe') return [currentUser.id];
  var list = [];
  var map = currentUser.authorized_teams || {};
  Object.keys(map).forEach(function(k) { if (map[k]) list.push(k); });
  return list;
}

// Verifica se um usuário de monitor (supervisor/user) pode ver determinada equipe
function canViewTeam(userId) {
  var ids = getUserTeamIds();
  if (ids === null) return true;
  return ids.indexOf(userId) !== -1;
}

function isAdmin() {
  return !!(currentUser && currentUser.role === 'admin');
}

function isSupervisor() {
  return !!(currentUser && currentUser.role === 'supervisor');
}

function ensureAdmin() {
  if (isAdmin()) return true;
  toast('Ação restrita ao administrador', 'error');
  return false;
}

// Supervisor e equipe só acessam os últimos 3 dias (hoje até 2 dias atrás).
// O admin não tem limite de período (null).
function daysAgoStr(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

function getAllowedDateRange() {
  if (isAdmin()) return null;
  return { start: daysAgoStr(2), end: todayStr() };
}

function clampDateToAllowed(value) {
  var range = getAllowedDateRange();
  if (!range || !value) return value;
  if (value < range.start) return range.start;
  if (value > range.end) return range.end;
  return value;
}

// ===== SEED DATA =====
function seedData() {
  return fbOnce('_initialized').then(function(init) {
    if (init) return;
    // offline sem dados locais: não tenta criar seed (evita conflitos)
    if (!navigator.onLine) return;
    var promises = [];
    promises.push(fbPush('users', {
      username: 'ARNALDO.LIMA', password: '159753', role: 'admin',
      latitude: '', longitude: '', last_seen: null, created_at: nowTimestamp()
    }));
    var rules = [
      { class: 'A', min_ups: 42, max_ups: 9999, color: '#2ecc71' },
      { class: 'B', min_ups: 31, max_ups: 41, color: '#3498db' },
      { class: 'C', min_ups: 19, max_ups: 30, color: '#f39c12' },
      { class: 'D', min_ups: 0, max_ups: 18, color: '#e74c3c' }
    ];
    rules.forEach(function(r) { promises.push(fbPush('rules', r)); });
    var catalog = [
      { name: 'Instalacao', ups_value: 10, money_value: 50.00, active: true },
      { name: 'Manutencao', ups_value: 8, money_value: 35.00, active: true },
      { name: 'Suporte', ups_value: 5, money_value: 25.00, active: true }
    ];
    catalog.forEach(function(c) { c.created_at = nowTimestamp(); promises.push(fbPush('catalog_services', c)); });
    promises.push(fbUpdate('', { _initialized: true }));
    return Promise.all(promises);
  });
}

// ===== AUTH =====
function doLogin() {
  var username = $('loginUser').value.trim();
  var password = $('loginPass').value;
  var remember = $('rememberMe').checked;

  if (!username || !password) {
    showMsg('loginMsg', 'error', 'Preencha usuário e senha');
    return;
  }
  clearMsg('loginMsg');
  loading(true);
  fbOnce('users').then(function(users) {
    loading(false);
    if (!users) { showMsg('loginMsg', 'error', 'Nenhum usuário encontrado'); return; }
    var found = null;
    var keys = Object.keys(users);
    for (var i = 0; i < keys.length; i++) {
      var u = users[keys[i]];
      if (u.username === username && u.password === password) {
        found = { id: keys[i], username: u.username, role: u.role || 'equipe', shift_start: u.shift_start || '', shift_end: u.shift_end || '', authorized_teams: u.authorized_teams || {}, sector: sectorOf(u) };
        break;
      }
    }
    if (found) {
      if (remember) {
        localStorage.setItem('ups_user', username);
        localStorage.setItem('ups_pass', password);
      } else {
        localStorage.removeItem('ups_user');
        localStorage.removeItem('ups_pass');
      }
      currentUser = found;
      toast('Bem-vindo, ' + found.username + '!', 'success');
      if (found.role === 'admin' || found.role === 'supervisor') {
        initAdminView();
      } else if (found.role === 'user') {
        initMonitorView(false);
      } else {
        initTeamView();
      }
    } else {
      showMsg('loginMsg', 'error', 'Usuário ou senha inválidos');
    }
}).catch(function(err) {
    loading(false);
    toast('Erro ao fazer login: ' + err.message, 'error');
  });
}

// Compõe as linhas de exportação para uma lista de equipes e período.
function buildCsvReport(teams, start, end) {
  return Promise.all([fbCached('services', 60000), fbCached('shift_notes', CACHE_TTL)]).then(function(results) {
    var allServices = toArray(results[0]);
    var allNotes = toArray(results[1]);
    var notesMap = {};
    allNotes.forEach(function(n) { notesMap[n.team_id + '_' + n.date] = n; });
    var servicesByTeamDate = {};
    allServices.forEach(function(s) {
      if (s.date >= start && s.date <= end) {
        var key = s.user_id + '_' + s.date;
        if (!servicesByTeamDate[key]) servicesByTeamDate[key] = [];
        servicesByTeamDate[key].push(s);
      }
    });
    var filtered = [];
    var currentDate = new Date(start + 'T00:00:00');
    var endDateObj = new Date(end + 'T00:00:00');
    while (currentDate <= endDateObj) {
      var dateStr = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0') + '-' + String(currentDate.getDate()).padStart(2, '0');
      var dayOfWeek = currentDate.getDay();
      for (var i = 0; i < teams.length; i++) {
        var t = teams[i];
        var key = t.id + '_' + dateStr;
        var dayServices = servicesByTeamDate[key] || [];
        var isScheduled = t.days_of_week && t.days_of_week.indexOf(dayOfWeek) !== -1;
        var classification = '';
        if (dayServices.length > 0 && isScheduled) {
          classification = 'Abriu';
        } else if (dayServices.length === 0 && isScheduled) {
          classification = 'Não abriu';
        } else if (dayServices.length > 0 && !isScheduled) {
          classification = 'Extra';
        } else {
          continue;
        }
        var noteKey = t.id + '_' + dateStr;
        var note = notesMap[noteKey];
        var motivo = (note && note.reason) ? note.reason : '';
        if (dayServices.length > 0) {
          for (var j = 0; j < dayServices.length; j++) {
            var s = dayServices[j];
            filtered.push({
              equipe: t.username || 'Desconhecido',
              processo: t.process || '',
              setor: sectorOf(t),
              servico: s.service_name,
              fase: PHASE_LABELS[s.phase] || '',
              categorias: (s.categories || []).map(function(k) { var c = PERDAS_CATS.find(function(x) { return x.key === k; }); return c ? c.label : k; }).join(', '),
              ups: s.ups_value,
              quantidade: s.quantity,
              valor_total: s.total_money,
              nota: s.grade,
              data: s.date,
              meta_diaria: t.goal_money || 0,
              classificacao: classification,
              motivo: motivo,
              latitude: s.latitude,
              longitude: s.longitude,
              endereco_equipe: t.address || ''
            });
          }
        } else {
          filtered.push({
            equipe: t.username || 'Desconhecido',
            processo: t.process || '',
            setor: sectorOf(t),
            servico: '',
            fase: '',
            categorias: '',
            ups: 0,
            quantidade: 0,
            valor_total: 0,
            nota: '',
            data: dateStr,
            meta_diaria: t.goal_money || 0,
            classificacao: classification,
            motivo: motivo,
            latitude: '',
            longitude: '',
            endereco_equipe: t.address || ''
          });
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return filtered;
  });
}

function downloadCsv(filtered, filename) {
  var csv = '\uFEFF';
  var headers = Object.keys(filtered[0]);
  csv += headers.join(';') + '\n';
  for (var i = 0; i < filtered.length; i++) {
    var row = headers.map(function(h) { return '"' + String(filtered[i][h]).replace(/"/g, '""') + '"'; });
    csv += row.join(';') + '\n';
  }
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.setAttribute('href', URL.createObjectURL(blob));
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('Exportação concluída!', 'success');
}

function toggleFullscreen() {
  var mapEl = document.getElementById('map');
  if (!document.fullscreenElement) {
    if (mapEl.requestFullscreen) {
      mapEl.requestFullscreen();
    } else if (mapEl.webkitRequestFullscreen) {
      mapEl.webkitRequestFullscreen();
    } else if (mapEl.msRequestFullscreen) {
      mapEl.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
}

function showCelebration(team) {
  var overlay = $('celebrationOverlay');
  var details = $('celebrationDetails');
  details.innerHTML = 'Equipe: <strong>' + escapeHtml(team.username) + '</strong><br>' +
                      'UPS: <strong>' + fmtUps(team.totalUps) + '</strong> | R$: <strong>' + fmtMoney(team.totalMoney) + '</strong>';
  overlay.classList.add('active');
  setTimeout(function() {
    overlay.classList.remove('active');
  }, 5000);
}

// ===== TEAM VIEW =====
function initTeamView() {
  $('teamUserName').textContent = currentUser.username;
  $('teamDate').textContent = formatDateBr(todayStr());
  teamSector = sectorOf(currentUser);
  applyTeamSectorUI();
  setTeamPhase('');
  showView('teamView');
  loadTeamCatalog();
  refreshTeamView();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(refreshTeamView, 30000);
  heartbeat();
  if (window.heartbeatInterval) clearInterval(window.heartbeatInterval);
  window.heartbeatInterval = setInterval(heartbeat, 120000);
  startLocationTracking();
}

function heartbeat() {
  if (!currentUser) return;
  OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
}

var watchId = null;
var currentTeamLat = '';
var currentTeamLng = '';
var currentTeamAddress = '';
var currentTeamCity = '';
var lastLocationHistorySave = 0;

function startLocationTracking() {
  if (!navigator.geolocation) return;
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(function(pos) {
    if (!currentUser) return;
    var lat = pos.coords.latitude;
    var lng = pos.coords.longitude;
    currentTeamLat = lat;
    currentTeamLng = lng;
    OfflineDB.bestEffortUpdate('users/' + currentUser.id, {
      latitude: lat,
      longitude: lng,
      last_seen: nowTimestamp()
    });
    var now = Date.now();
    if (now - lastLocationHistorySave > 60000) {
      lastLocationHistorySave = now;
      saveLocationHistoryPoint(currentUser.id, lat, lng);
    }
  }, function(err) {
    console.warn('Geolocation error:', err.message);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 });
}

function saveLocationHistoryPoint(userId, lat, lng) {
  var point = {
    lat: lat,
    lng: lng,
    timestamp: nowTimestamp(),
    date: todayStr()
  };
  reverseGeocode(lat, lng, function(addr) {
    point.address = addr;
    var cityParts = addr.split(',');
    point.city = cityParts.length > 1 ? cityParts[1].trim() : cityParts[0].trim();
    currentTeamAddress = addr;
    currentTeamCity = point.city;
    OfflineDB.bestEffortPush('location_history/' + userId + '/' + todayStr(), point);
  });
}

function captureTeamLocationForService(callback) {
  var lat = currentTeamLat;
  var lng = currentTeamLng;
  if (!lat || !lng) {
    if (!navigator.geolocation) {
      callback('', '', '', '');
      return;
    }
    navigator.geolocation.getCurrentPosition(function(pos) {
      currentTeamLat = pos.coords.latitude;
      currentTeamLng = pos.coords.longitude;
      reverseGeocode(currentTeamLat, currentTeamLng, function(addr) {
        currentTeamAddress = addr;
        currentTeamCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
        callback(currentTeamLat, currentTeamLng, currentTeamCity, currentTeamAddress);
      });
    }, function(err) {
      callback('', '', '', '');
    }, { enableHighAccuracy: true, timeout: 8000 });
  } else if (currentTeamAddress) {
    callback(lat, lng, currentTeamCity, currentTeamAddress);
  } else {
    reverseGeocode(lat, lng, function(addr) {
      currentTeamAddress = addr;
      currentTeamCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
      callback(lat, lng, currentTeamCity, currentTeamAddress);
    });
  }
}

function stopLocationTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function captureAdminLocation() {
  if (!navigator.geolocation) {
    var el = $('locationText');
    if (el) el.textContent = 'Geolocalização não disponível';
    return;
  }
  var icon = $('locationIcon');
  var text = $('locationText');
  if (icon) icon.textContent = 'location_searching';
  if (text) text.textContent = 'Detectando localização...';
  navigator.geolocation.getCurrentPosition(function(pos) {
    adminLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (icon) icon.textContent = 'location_on';
    if (text) text.textContent = adminLocation.lat.toFixed(6) + ', ' + adminLocation.lng.toFixed(6);
    reverseGeocode(adminLocation.lat, adminLocation.lng, function(addr) {
      adminAddress = addr;
      if (text) text.textContent = addr + ' (' + adminLocation.lat.toFixed(4) + ', ' + adminLocation.lng.toFixed(4) + ')';
    });
  }, function(err) {
    console.warn('Erro ao capturar localização do admin:', err.message);
    if (icon) icon.textContent = 'location_off';
    if (text) text.textContent = 'Não foi possível obter localização. Clique para tentar novamente.';
  }, { enableHighAccuracy: true, timeout: 10000 });
}

function reverseGeocode(lat, lng, callback) {
  var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&addressdetails=1&accept-language=pt';
  fetch(url, { headers: { 'User-Agent': 'UPS-System/1.0' } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var addr = data.display_name || (lat.toFixed(4) + ', ' + lng.toFixed(4));
      callback(addr);
    })
    .catch(function() {
      callback(lat.toFixed(4) + ', ' + lng.toFixed(4));
    });
}

// ===== SETORES (STC / PERDAS) =====
// STC: regra original (tipo de registro + UPS e R$ por unidade).
// PERDAS: sem valor em dinheiro; cada atividade tem UPS para MONO, BI e TRI.
var SECTORS = ['STC', 'PERDAS'];
var PHASE_LABELS = { mono: 'MONO', bi: 'BI', tri: 'TRI' };
var teamSector = 'STC';

// Registros sem setor (legado) pertencem ao STC
function sectorOf(x) {
  return (x && x.sector === 'PERDAS') ? 'PERDAS' : 'STC';
}

function perdasUps(svc, phase) {
  return Number(svc && svc['ups_' + phase]) || 0;
}

// Categorias marcadas na atividade de PERDAS (lista de chaves)
function serviceCategories(svc) {
  var c = (svc && svc.categories) || {};
  return PERDAS_CATS.filter(function(cat) { return !!c[cat.key]; }).map(function(cat) { return cat.key; });
}

function categoryTags(keys) {
  return (keys || []).map(function(k) {
    var cat = PERDAS_CATS.find(function(c) { return c.key === k; });
    return cat ? '<span class="tag tag-neutral">' + cat.label + '</span>' : '';
  }).join(' ');
}

function categoryCheckboxes(prefix, selected) {
  selected = selected || {};
  return '<div class="day-picker">' + PERDAS_CATS.map(function(c) {
    return '<label class="day-chip"><input type="checkbox" id="' + prefix + '_cat_' + c.key + '"' + (selected[c.key] ? ' checked' : '') + '> ' + c.label.toUpperCase() + '</label>';
  }).join('') + '</div>';
}

function perdasUpsSummary(svc) {
  return 'MONO ' + fmtUps(perdasUps(svc, 'mono')) + ' · BI ' + fmtUps(perdasUps(svc, 'bi')) + ' · TRI ' + fmtUps(perdasUps(svc, 'tri'));
}

function sectorTag(sector) {
  return '<span class="tag ' + (sector === 'PERDAS' ? 'tag-warning' : 'tag-primary') + '">' + sector + '</span>';
}

function applyTeamSectorUI() {
  var isPerdas = teamSector === 'PERDAS';
  if ($('teamTypeGroup')) $('teamTypeGroup').style.display = isPerdas ? 'none' : '';
  if ($('teamPhaseGroup')) $('teamPhaseGroup').style.display = isPerdas ? '' : 'none';
  if ($('teamCalcMoneyItem')) $('teamCalcMoneyItem').style.display = isPerdas ? 'none' : '';
  if ($('teamTotalMoney')) $('teamTotalMoney').style.display = isPerdas ? 'none' : '';
  if ($('teamSectorLabel')) $('teamSectorLabel').textContent = teamSector;
  var calc = $('teamCalcDisplay');
  if (calc) calc.style.gridTemplateColumns = isPerdas ? 'repeat(3, 1fr)' : '';
}

function setTeamPhase(phase) {
  $('teamPhase').value = phase;
  var btns = document.querySelectorAll('#teamPhaseSeg button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-phase') === phase);
  onTeamGradeChange();
}

function loadTeamCatalog() {
  // Lê o setor atualizado da equipe junto com o catálogo
  Promise.all([fbOnce('catalog_services'), fbOnce('users/' + currentUser.id).catch(function() { return null; })]).then(function(results) {
    var services = results[0];
    var me = results[1];
    teamSector = sectorOf(me || currentUser);
    currentUser.sector = teamSector;
    applyTeamSectorUI();
    // A equipe só enxerga as atividades do próprio setor
    var arr = toArray(services).filter(function(s) { return s.active && sectorOf(s) === teamSector; });
    teamCatalogCache = arr;
    var container = $('teamActivitiesList');
    container.innerHTML = '';
    if (!arr || arr.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhuma atividade disponível para o setor ' + teamSector + '</div>';
      return;
    }
    arr.sort(function(a, b) { return String(a.name).localeCompare(String(b.name), 'pt-BR'); });
    var selected = document.querySelector('input[name="teamActivityRadio"]:checked');
    var selectedId = selected ? selected.value : '';
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var svc = arr[i];
      var values = teamSector === 'PERDAS'
        ? '<b>' + perdasUpsSummary(svc) + '</b><br>' + serviceCategories(svc).map(function(k) { return PERDAS_CATS.find(function(c) { return c.key === k; }).label; }).join(' · ')
        : '<b>' + fmtUps(svc.ups_value || 0) + ' UPS</b>' + (svc.money_value ? '<br>' + fmtMoney(svc.money_value) : '');
      html += '<label class="activity-option' + (svc.id === selectedId ? ' selected' : '') + '" data-name="' + escapeHtml(String(svc.name).toLowerCase()) + '">' +
        '<input type="radio" name="teamActivityRadio" value="' + svc.id + '"' + (svc.id === selectedId ? ' checked' : '') + ' onchange="onTeamActivityToggle(\'' + svc.id + '\')">' +
        '<span class="act-name">' + escapeHtml(svc.name) + '</span>' +
        '<span class="act-values">' + values + '</span>' +
        '</label>';
    }
    container.innerHTML = html;
    var searchWrap = $('teamActivitySearchWrap');
    if (searchWrap) searchWrap.style.display = arr.length > 6 ? 'block' : 'none';
    filterTeamActivities();
  });
}

function filterTeamActivities() {
  var q = valOf('teamActivitySearch').trim().toLowerCase();
  var items = document.querySelectorAll('#teamActivitiesList .activity-option');
  for (var i = 0; i < items.length; i++) {
    var name = items[i].getAttribute('data-name') || '';
    items[i].style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
  }
}

function setTeamEntryType(type) {
  $('teamEntryType').value = type;
  var btns = document.querySelectorAll('#teamTypeSeg button');
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-type') === type);
  onTeamEntryTypeChange();
}

function onTeamEntryTypeChange() {
  onTeamGradeChange();
}

function onTeamActivityToggle(svcId) {
  var options = document.querySelectorAll('#teamActivitiesList .activity-option');
  for (var i = 0; i < options.length; i++) {
    var radio = options[i].querySelector('input');
    options[i].classList.toggle('selected', !!(radio && radio.checked));
  }
  var qtyContainer = $('teamDynamicQuantities');
  qtyContainer.innerHTML = '';
  var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
  if (svc) {
    var div = document.createElement('div');
    div.className = 'qty-input-row';
    div.id = 'qty_row_' + svcId;
    div.innerHTML = '<label for="qty_' + svcId + '">Quantidade · ' + escapeHtml(svc.name) + '</label>' +
                    '<div class="stepper">' +
                    '<button type="button" onclick="stepQty(\'' + svcId + '\', -1)" aria-label="Diminuir">−</button>' +
                    '<input type="number" id="qty_' + svcId + '" value="1" min="1" inputmode="numeric" oninput="onTeamGradeChange()">' +
                    '<button type="button" onclick="stepQty(\'' + svcId + '\', 1)" aria-label="Aumentar">+</button>' +
                    '</div>';
    qtyContainer.appendChild(div);
  }
  onTeamGradeChange();
}

function stepQty(svcId, delta) {
  var input = $('qty_' + svcId);
  if (!input) return;
  var v = (parseInt(input.value, 10) || 1) + delta;
  input.value = Math.max(1, v);
  onTeamGradeChange();
}

function fmtUps(v) {
  var n = Number(v) || 0;
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function onTeamGradeChange() {
  var raw = $('teamGrade').value;
  var nota = parseInt(raw);
  if (isNaN(nota)) nota = 0;
  var type = $('teamEntryType').value;
  var isPerdas = teamSector === 'PERDAS';
  var calc = $('teamCalcDisplay');
  var totalUps = 0;
  var totalMoney = 0;
  var totalQty = 0;
  var selectedRadio = document.querySelector('input[name="teamActivityRadio"]:checked');
  if (selectedRadio) {
    var svcId = selectedRadio.value;
    var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
    if (svc) {
      var qtyInput = $('qty_' + svcId);
      var qty = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
      totalQty = qty;
      if (isPerdas) {
        totalUps = qty * perdasUps(svc, valOf('teamPhase'));
      } else if (type !== 'miscellany') {
        totalUps = qty * (svc.ups_value || 0);
      } else {
        totalUps = 5.6;
      }
      totalMoney = isPerdas ? 0 : qty * (svc.money_value || 0);
    }
  }
  if (totalUps > 0 || (!isPerdas && (type === 'emergency' || type === 'commercial')) || (isPerdas && selectedRadio)) {
    calc.style.display = 'grid';
    $('teamCalcUps').textContent = fmtUps(totalUps);
    $('teamCalcMoney').textContent = fmtMoney(totalMoney);
    if ($('teamCalcQty')) $('teamCalcQty').textContent = totalQty;
    if ($('teamCalcGrade')) $('teamCalcGrade').textContent = nota;
  } else {
    calc.style.display = 'none';
  }
}

function addTeamService() {
  var type = $('teamEntryType').value;
  var raw = $('teamGrade').value;
  var nota = parseInt(raw);
  if (isNaN(nota)) { showMsg('teamFormMsg', 'error', 'Informe uma nota válida'); return; }
  var selectedRadio = document.querySelector('input[name="teamActivityRadio"]:checked');
  if (!selectedRadio) { showMsg('teamFormMsg', 'error', 'Selecione exatamente uma atividade'); return; }
  var svcId = selectedRadio.value;
  var svc = teamCatalogCache.find(function(s) { return s.id == svcId; });
  if (!svc) { showMsg('teamFormMsg', 'error', 'Atividade não encontrada'); return; }
  // Uma equipe nunca lança atividade de outro setor
  if (sectorOf(svc) !== teamSector) { showMsg('teamFormMsg', 'error', 'Esta atividade não pertence ao setor ' + teamSector); return; }
  var qtyInput = $('qty_' + svcId);
  var qty = qtyInput ? parseFloat(qtyInput.value) || 1 : 1;
  var totalUps;
  var totalMoney = 0;
  var phase = '';
  if (teamSector === 'PERDAS') {
    phase = valOf('teamPhase');
    if (!PHASE_LABELS[phase]) { showMsg('teamFormMsg', 'error', 'Selecione o tipo de ligação: MONO, BI ou TRI'); return; }
    type = 'perdas';
    totalUps = qty * perdasUps(svc, phase);
  } else if (type === 'miscellany') {
    totalUps = 5.6;
    totalMoney = qty * (svc.money_value || 0);
  } else {
    totalUps = qty * (svc.ups_value || 0);
    totalMoney = qty * (svc.money_value || 0);
  }

  loading(true);
  // Consulta no servidor APENAS os serviços desta equipe (economia de download)
  OfflineDB.query('services', { orderBy: 'user_id', equalTo: currentUser.id, limitToLast: 2000 }).then(function(arr) {
    var duplicateGrade = (arr || []).some(function(s) {
      return s.grade === nota && s.grade > 0;
    });
    if (duplicateGrade) {
      loading(false);
      showMsg('teamFormMsg', 'error', 'Esta nota (' + nota + ') já foi utilizada por esta equipe. Informe um número de nota diferente.');
      return;
    }
    captureTeamLocationForService(function(lat, lng, city, address) {
      var selectedSvcs = [{ svc: svc, qty: qty }];
      submitNewEntry(type, nota, selectedSvcs, totalUps, totalMoney, lat, lng, city, address, phase);
    });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro ao validar nota: ' + err.message);
  });
}

function submitNewEntry(type, grade, selectedSvcs, upsValue, moneyValue, lat, lng, city, address, phase) {
  var svcNames = selectedSvcs.map(function(s) { return s.svc.name; }).join(', ');
  var totalQty = selectedSvcs.reduce(function(sum, s) { return sum + s.qty; }, 0);
  var upsPerUnit = totalQty > 0 ? upsValue / totalQty : upsValue;
  var moneyPerUnit = totalQty > 0 && moneyValue > 0 ? moneyValue / totalQty : 0;
  var typeLabel = type === 'perdas' ? 'Perdas ' + (PHASE_LABELS[phase] || '') : typeLabelOf(type);
  var now = new Date();
  var timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
  var serviceData = {
    user_id: currentUser.id,
    service_name: typeLabel + ': ' + svcNames,
    ups_value: upsValue,
    quantity: totalQty,
    ups_per_unit: upsPerUnit,
    money_per_unit: moneyPerUnit,
    total_money: moneyValue,
    grade: grade,
    type: type,
    sector: teamSector,
    phase: phase || '',
    categories: teamSector === 'PERDAS' ? serviceCategories(selectedSvcs[0] && selectedSvcs[0].svc) : [],
    activities: selectedSvcs.map(function(s) { return { id: s.svc.id, name: s.svc.name, qty: s.qty }; }),
    date: todayStr(),
    created_at: nowTimestamp(),
    latitude: lat || '',
    longitude: lng || '',
    city: city || '',
    address: address || '',
    time: timeStr,
    edited_by: '',
    edited_at: null
  };
  fbPush('services', serviceData).then(function(key) {
    loading(false);
    $('teamGrade').value = '';
    var radios = document.querySelectorAll('input[name="teamActivityRadio"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = false;
    var opts = document.querySelectorAll('#teamActivitiesList .activity-option');
    for (var o = 0; o < opts.length; o++) opts[o].classList.remove('selected');
    $('teamDynamicQuantities').innerHTML = '';
    if ($('teamActivitySearch')) { $('teamActivitySearch').value = ''; filterTeamActivities(); }
    setTeamEntryType('miscellany');
    if ($('teamPhase')) setTeamPhase('');
    clearMsg('teamFormMsg');
    toast('Registro adicionado!', 'success');
    refreshTeamView();
    updateSyncStatus();
    return OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function submitService(svc, qty, grade, totalUps, totalMoney, lat, lng) {
  clearMsg('teamFormMsg');
  loading(true);
  var serviceData = {
    user_id: currentUser.id,
    service_name: svc.name,
    ups_value: totalUps,
    quantity: qty,
    ups_per_unit: svc.ups_value,
    money_per_unit: svc.money_value,
    total_money: totalMoney,
    grade: grade,
    type: 'catalog',
    latitude: lat || '',
    longitude: lng || '',
    catalog_service_id: svc.id,
    date: todayStr(),
    created_at: nowTimestamp()
  };
  fbPush('services', serviceData).then(function(key) {
    loading(false);
    if ($('teamCatalogSelect')) $('teamCatalogSelect').value = '';
    if ($('teamQuantity')) $('teamQuantity').value = '1';
    if ($('teamGrade')) $('teamGrade').value = '0';
    var calc = $('teamCalcDisplay');
    if (calc) calc.style.display = 'none';
    toast('Serviço adicionado!', 'success');
    refreshTeamView();
    updateSyncStatus();
    return OfflineDB.bestEffortUpdate('users/' + currentUser.id, { last_seen: nowTimestamp() });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function refreshTeamView() {
  if (!currentUser) return;
  getTeamSummary(currentUser.id, todayStr(), todayStr()).then(function(summary) {
    renderTeamSummary(summary);
    renderTeamServices(summary.services);
    lastShift = { shift_start: summary.shift_start, shift_end: summary.shift_end };
    renderTeamShift();
  }).catch(function(err) {
    console.error('Erro ao atualizar:', err);
  });
}

function renderTeamSummary(summary) {
  var badge = $('teamBadge');
  badge.textContent = summary.class;
  badge.style.background = summary.color || '#94a3b8';
  $('teamTotal').textContent = fmtUps(summary.totalUps);
  $('teamTotalMoney').textContent = fmtMoney(summary.totalMoney || 0);
  $('teamCount').textContent = summary.count + ' servi\u00E7o' + (summary.count !== 1 ? 's' : '') + ' hoje';
  var goalSection = $('teamGoalSection');
  // PERDAS: metas por categoria (Fiscalização / Normalização / Fraude)
  var perdasBox = $('teamPerdasGoals');
  if (perdasBox) {
    var rows = perdasGoalRows(summary);
    var isPerdas = summary.sector === 'PERDAS';
    perdasBox.style.display = isPerdas ? 'block' : 'none';
    if (isPerdas) {
      var counts = summary.perdas || {};
      perdasBox.innerHTML = rows.length
        ? rows.map(function(r) {
            return '<div class="hero-progress"><div class="progress-meta"><span>' + r.label + ': ' + r.done + ' / ' + r.goal + '</span><strong>' + Math.round(r.pct) + '%' + (r.pct >= 100 ? ' ✓' : '') + '</strong></div>' +
              '<div class="progress progress-lg"><span style="width:' + Math.min(100, r.pct) + '%;background:#fff;"></span></div></div>';
          }).join('')
        : '<div class="meta" style="margin-top:6px;">' + PERDAS_CATS.map(function(c) { return c.label + ': <strong>' + (counts[c.key] || 0) + '</strong>'; }).join(' · ') + '</div>';
    }
  }
  if (summary.sector === 'PERDAS') {
    goalSection.style.display = 'none';
  } else if (summary.goal_money > 0) {
    var goalPct = Math.round((summary.totalMoney / summary.goal_money) * 100);
    goalSection.style.display = 'block';
    $('teamGoalValue').textContent = fmtMoney(summary.goal_money);
    $('teamGoalPercent').textContent = goalPct + '%' + (goalPct >= 100 ? ' \u2713' : '');
    $('teamGoalBar').style.width = Math.min(100, goalPct) + '%';
  } else {
    goalSection.style.display = 'none';
  }
}

function renderTeamServices(services) {
  var container = $('teamServiceList');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">assignment</span><p>Nenhum servi\u00E7o registrado hoje</p></div>';
    return;
  }
  var html = '<div class="service-list">';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var detail = '';
    if (s.time) detail = s.time.slice(0, 5);
    if (s.quantity > 1) detail += (detail ? ' \u00B7 ' : '') + s.quantity + ' un \u00D7 ' + fmtUps(s.upsPerUnit) + ' UPS';
    if (s.grade > 0) detail += (detail ? ' \u00B7 ' : '') + 'Nota ' + s.grade;
    var typeIcon = s.type === 'perdas' ? 'electric_meter' : s.type === 'emergency' ? 'emergency' : (s.type === 'commercial' ? 'storefront' : (s.type === 'miscellany' ? 'category' : 'task_alt'));
    html += '<div class="service-item">' +
      '<div class="srv-icon"><span class="material-symbols-outlined">' + typeIcon + '</span></div>' +
      '<div class="srv-body">' +
      '<span class="name">' + escapeHtml(s.serviceName) + '</span>' +
      (detail ? '<span class="detail">' + detail + '</span>' : '') +
      '</div>' +
      '<div class="srv-values">' +
      '<span class="ups">' + fmtUps(s.upsValue) + ' UPS</span>' +
      (s.totalMoney ? '<span class="money">' + fmtMoney(s.totalMoney) + '</span>' : '') +
      '</div>' +
      '<button class="del-btn" onclick="deleteService(\'' + s.id + '\')" title="Remover"><span class="material-symbols-outlined">close</span></button>' +
      '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function deleteService(serviceId) {
  if (!confirm('Remover este servi\u00E7o?')) return;
  loading(true);
  fbRemove('services/' + serviceId).then(function() {
    loading(false);
    toast('Serviço removido', 'info');
    updateSyncStatus();
    refreshTeamView();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

// ===== TURNO (HORÁRIO DA EQUIPE) =====
var lastShift = null;

function getShiftProgress(user) {
  var start = user && user.shift_start;
  var end = user && user.shift_end;
  if (!start || !end) return { enabled: false };
  var sp = start.split(':').map(Number);
  var ep = end.split(':').map(Number);
  if (isNaN(sp[0]) || isNaN(sp[1]) || isNaN(ep[0]) || isNaN(ep[1])) return { enabled: false };
  var now = new Date();
  var startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sp[0], sp[1]).getTime();
  var endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ep[0], ep[1]).getTime();
  if (endMs <= startMs) endMs += 86400000;
  var nowMs = now.getTime();
  var result = { enabled: true, start: start, end: end, pct: 0 };
  if (nowMs < startMs) {
    result.status = 'antes';
    result.label = 'Início às ' + start;
    result.pct = 0;
  } else if (nowMs > endMs) {
    result.status = 'depois';
    result.label = 'Turno encerrado';
    result.pct = 100;
  } else {
    var total = endMs - startMs;
    var elapsed = nowMs - startMs;
    result.status = 'durante';
    result.pct = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
    result.remaining = endMs - nowMs;
    result.label = 'Faltam ' + formatDuration(result.remaining);
  }
  return result;
}

function formatDuration(ms) {
  var totalMin = Math.max(0, Math.round(ms / 60000));
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'min' : '');
  return m + 'min';
}

function shiftColor(sp) {
  if (sp.status === 'durante') {
    if (sp.pct >= 85) return 'var(--danger)';
    if (sp.pct >= 60) return 'var(--warning)';
    return 'var(--primary)';
  }
  return 'var(--text-muted)';
}

function renderTeamShift() {
  var section = $('teamShiftSection');
  if (!section) return;
  var sp = getShiftProgress(lastShift || currentUser);
  if (!sp.enabled) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  $('teamShiftTimes').textContent = sp.start + ' – ' + sp.end;
  $('teamShiftLabel').textContent = sp.label;
  var bar = $('teamShiftBar');
  bar.style.width = sp.pct + '%';
  // No cartão azul, a barra fica branca e só muda de cor perto do fim do turno
  bar.style.background = (sp.status === 'durante' && sp.pct >= 85) ? '#fca5a5' : (sp.status === 'durante' && sp.pct >= 60) ? '#fde68a' : '#fff';
}

function shiftMiniBar(user) {
  var sp = getShiftProgress(user);
  if (!sp.enabled) return '';
  return progressHtml('Turno: ' + sp.start + ' – ' + sp.end, sp.pct, shiftColor(sp), sp.label);
}

// ===== DATA FUNCTIONS =====
function getTeamSummary(userId, startDate, endDate) {
  return Promise.all([
    OfflineDB.query('services', { orderBy: 'user_id', equalTo: userId, limitToLast: 4000 }).catch(function() { return []; }),
    fbCached('users/' + userId, CACHE_TTL)
  ]).then(function(results) {
    var allServices = results[0];
    var userData = results[1];
    var filtered = allServices.filter(function(s) {
      return s.date >= startDate && s.date <= endDate;
    });
    var services = filtered.map(function(s) { return formatService(s); });
    var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
    var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
    var classInfo = getClassification(totalUps);
    return withSectorInfo({
      userId: userId, startDate: startDate, endDate: endDate,
      goal_money: (userData && userData.goal_money) || 0,
      shift_start: (userData && userData.shift_start) || '',
      shift_end: (userData && userData.shift_end) || '',
      services: services, totalUps: totalUps, totalMoney: totalMoney,
      class: classInfo.class, color: classInfo.color, count: services.length
    }, userData, services);
  });
}

function getAllTeamsSummaryForPeriod(startDate, endDate) {
  return Promise.all([fbCached('users', CACHE_TTL), fbCached('services', CACHE_TTL)]).then(function(results) {
    var users = toArray(results[0]);
    var allServices = toArray(results[1]);
    var byUser = {};
    allServices.forEach(function(s) {
      if (s.date >= startDate && s.date <= endDate) (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
    });
    return users.filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); }).map(function(user) {
      var svcs = byUser[user.id] || [];
      var services = svcs.map(function(s) { return formatService(s); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
      var classInfo = getClassification(totalUps);
      return withSectorInfo({
        userId: user.id, username: user.username,
        supervisor: user.supervisor || '',
        process: user.process || '',
        sector: sectorOf(user),
        goal_money: user.goal_money || 0,
        shift_start: user.shift_start || '',
        shift_end: user.shift_end || '',
        latitude: user.latitude || '', longitude: user.longitude || '',
        address: user.address || '',
        lastSeen: user.last_seen || null,
        services: services, totalUps: totalUps, totalMoney: totalMoney,
        class: classInfo.class, color: classInfo.color, count: services.length
      }, user, services);
    });
  });
}

function loadStatistics() {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  Promise.all([fbCached('services', CACHE_TTL), fbCached('users', CACHE_TTL)]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var teams = users.filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });

    fillSelect('sfTeam', teams.map(function(t) { return { value: t.id, label: t.username }; })
      .sort(function(a, b) { return a.label.localeCompare(b.label, 'pt-BR'); }), 'Todas equipes');
    fillSelect('sfSupervisor', supervisorOptions(teams), 'Todos supervisores');
    fillSelect('sfProcess', processOptions(teams), 'Todos processos');
    markActiveFilters(['sfSector', 'sfTeam', 'sfSupervisor', 'sfProcess', 'sfType'], 'sfCount');

    var fTeam = valOf('sfTeam'), fSup = valOf('sfSupervisor'), fProc = valOf('sfProcess'), fType = valOf('sfType'), fSector = valOf('sfSector');
    var teamMap = {};
    teams.forEach(function(t) { teamMap[t.id] = t; });
    var allowed = {};
    teams.forEach(function(t) {
      if (fTeam && t.id !== fTeam) return;
      if (fSector && sectorOf(t) !== fSector) return;
      if (!matchOptional(fSup, t.supervisor || '')) return;
      if (!matchOptional(fProc, t.process || '')) return;
      allowed[t.id] = true;
    });

    var filtered = allServices.filter(function(s) {
      return s.date >= start && s.date <= end && allowed[s.user_id] && (!fType || s.type === fType);
    });

    var totalUps = 0, totalMoney = 0, gradeCount = 0;
    var svcCount = {}, svcUps = {}, typeAgg = {}, dailyData = {}, teamAgg = {}, teamDays = {};
    var catCount = { fiscalizacao: 0, normalizacao: 0, fraude: 0 };
    filtered.forEach(function(s) {
      var ups = s.ups_value || 0, money = s.total_money || 0, qty = s.quantity || 1;
      totalUps += ups; totalMoney += money;
      if (s.grade > 0) gradeCount++;
      (s.categories || []).forEach(function(k) { if (catCount[k] !== undefined) catCount[k]++; });
      var name = (s.activities && s.activities.length)
        ? s.activities.map(function(a) { return a.name; }).join(', ')
        : (s.service_name || 'Desconhecido');
      svcCount[name] = (svcCount[name] || 0) + qty;
      svcUps[name] = (svcUps[name] || 0) + ups;
      var tk = s.type === 'perdas' ? 'perdas_' + (s.phase || '') : (s.type || 'catalog');
      if (!typeAgg[tk]) typeAgg[tk] = { count: 0, ups: 0, money: 0 };
      typeAgg[tk].count++; typeAgg[tk].ups += ups; typeAgg[tk].money += money;
      if (!dailyData[s.date]) dailyData[s.date] = { ups: 0, money: 0, count: 0 };
      dailyData[s.date].ups += ups; dailyData[s.date].money += money; dailyData[s.date].count++;
      if (!teamAgg[s.user_id]) teamAgg[s.user_id] = { ups: 0, money: 0, count: 0, grades: 0, days: {} };
      var ta = teamAgg[s.user_id];
      ta.ups += ups; ta.money += money; ta.count++; if (s.grade > 0) ta.grades++;
      ta.days[s.date] = true;
      teamDays[s.user_id + '_' + s.date] = true;
    });

    var svcNames = Object.keys(svcCount).sort(function(a, b) { return svcCount[b] - svcCount[a]; });
    var teamRanking = Object.keys(teamAgg).map(function(uid) {
      var a = teamAgg[uid];
      var days = Object.keys(a.days).length;
      var avg = days > 0 ? a.ups / days : 0;
      var cls = getClassification(avg);
      return {
        userId: uid, username: teamMap[uid] ? teamMap[uid].username : 'Desconhecido',
        supervisor: teamMap[uid] ? teamMap[uid].supervisor || '' : '',
        ups: a.ups, money: a.money, count: a.count, grades: a.grades, days: days, avg: avg,
        class: cls.class, color: cls.color
      };
    }).sort(function(a, b) { return b.ups - a.ups; });

    // Série diária completa (inclui dias sem produção) quando o período é curto
    var dates = [];
    var d0 = new Date(start + 'T00:00:00'), d1 = new Date(end + 'T00:00:00');
    var spanDays = Math.round((d1 - d0) / 86400000) + 1;
    if (spanDays > 0 && spanDays <= 92) {
      for (var d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) dates.push(formatDate(d));
    } else {
      dates = Object.keys(dailyData).sort();
    }

    var teamDayCount = Object.keys(teamDays).length;
    renderStatistics({
      start: start, end: end,
      totalUps: totalUps, totalMoney: totalMoney, totalServices: filtered.length, gradeCount: gradeCount,
      activeTeams: teamRanking.length, totalTeams: Object.keys(allowed).length,
      avgPerTeamDay: teamDayCount > 0 ? totalUps / teamDayCount : 0,
      ticket: filtered.length > 0 ? totalMoney / filtered.length : 0,
      svcCount: svcCount, svcUps: svcUps, svcNames: svcNames,
      typeAgg: typeAgg, catCount: catCount, dailyData: dailyData, dates: dates, teamRanking: teamRanking
    });
  }).catch(function(err) {
    console.error('Erro ao carregar estatísticas:', err);
  });
}

function hbarChart(rows, valueFmt, fillClass) {
  if (!rows.length) return '<div class="empty-state"><p>Sem dados no período</p></div>';
  var max = rows.reduce(function(m, r) { return Math.max(m, r.value); }, 0);
  var html = '<div class="chart-bars">';
  rows.forEach(function(r) {
    var pct = max > 0 ? (r.value / max) * 100 : 0;
    html += '<div class="chart-row" title="' + escapeHtml(r.label + ': ' + (r.tip || valueFmt(r.value))) + '">' +
      '<div class="chart-label">' + escapeHtml(r.label) + '</div>' +
      '<div class="chart-track"><div class="chart-fill ' + (fillClass || '') + '" style="width:' + pct + '%;"></div></div>' +
      '<div class="chart-value">' + valueFmt(r.value) + (r.sub ? ' <small>' + r.sub + '</small>' : '') + '</div></div>';
  });
  return html + '</div>';
}

function columnChart(dates, dailyData) {
  if (!dates.length) return '<div class="empty-state"><p>Sem dados no período</p></div>';
  var max = dates.reduce(function(m, d) { return Math.max(m, dailyData[d] ? dailyData[d].ups : 0); }, 0);
  var dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var minWidth = dates.length * 16;
  var html = '<div class="col-chart-wrap" style="overflow-x:' + (dates.length > 31 ? 'auto' : 'visible') + ';"><div class="col-chart" style="min-width:' + (minWidth + 40) + 'px;">';
  if (max > 0) {
    html += '<div class="gridline" style="bottom:calc((100% - 18px) * 1);"><span>' + fmtUps(max) + '</span></div>' +
      '<div class="gridline" style="bottom:calc((100% - 18px) * 0.5);"><span>' + fmtUps(max / 2) + '</span></div>';
  }
  dates.forEach(function(d) {
    var dd = dailyData[d] || { ups: 0, money: 0, count: 0 };
    var h = max > 0 ? (dd.ups / max) * 100 : 0;
    var dow = dayNames[new Date(d + 'T00:00:00').getDay()];
    html += '<div class="col' + (dd.ups === 0 ? ' zero' : '') + '">' +
      '<div class="bar" style="height:calc((100% - 18px) * ' + (h / 100) + ');"></div>' +
      '<div class="tip"><strong>' + dow + ' ' + formatDateBr(d) + '</strong><br>' + fmtUps(dd.ups) + ' UPS · ' + fmtMoney(dd.money) + '<br>' + dd.count + ' lançamento' + (dd.count !== 1 ? 's' : '') + '</div>' +
      '</div>';
  });
  html += '</div><div class="col-axis" style="min-width:' + (minWidth + 40) + 'px;">';
  var step = Math.ceil(dates.length / 12);
  dates.forEach(function(d, i) {
    html += '<span>' + ((i % step === 0) ? d.slice(8, 10) + '/' + d.slice(5, 7) : '') + '</span>';
  });
  return html + '</div></div>';
}

function renderStatistics(stats) {
  var container = $('statsContent');
  if (!container) return;
  var topService = stats.svcNames[0];
  var html = '<div class="stats-overview">' +
    kpi('ups', 'trending_up', fmtUps(stats.totalUps), 'Total UPS') +
    kpi('money', 'payments', fmtMoney(stats.totalMoney), 'Total R$') +
    kpi('services', 'assignment', stats.totalServices, 'Lançamentos', stats.gradeCount + ' com nota') +
    kpi('teams', 'groups', stats.activeTeams + '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + stats.totalTeams + '</small>', 'Equipes ativas') +
    kpi('avg', 'speed', fmtUps(stats.avgPerTeamDay), 'Média UPS/equipe-dia') +
    kpi('goal', 'sell', fmtMoney(stats.ticket), 'Ticket médio') +
    kpi('grade', 'star', topService ? escapeHtml(topService) : '—', 'Serviço mais executado', topService ? stats.svcCount[topService] + ' execuções' : '', true) +
    '</div>';

  html += '<div class="card"><div class="card-head"><div class="card-title"><span class="material-symbols-outlined">calendar_month</span> Evolução diária de UPS</div>' +
    '<span class="tag tag-neutral">' + periodLabel(stats.start, stats.end) + '</span></div>' +
    columnChart(stats.dates, stats.dailyData) + '</div>';

  var typeKeys = Object.keys(stats.typeAgg).sort(function(a, b) { return stats.typeAgg[b].ups - stats.typeAgg[a].ups; });
  var typeRows = typeKeys.map(function(k) {
    var t = stats.typeAgg[k];
    var pct = stats.totalUps > 0 ? Math.round((t.ups / stats.totalUps) * 100) : 0;
    var lbl = k.indexOf('perdas_') === 0 ? 'Perdas ' + (PHASE_LABELS[k.slice(7)] || '') : typeLabelOf(k);
    return { label: lbl, value: t.ups, sub: pct + '%', tip: fmtUps(t.ups) + ' UPS · ' + t.count + ' lançamentos · ' + fmtMoney(t.money) };
  });
  var svcRows = stats.svcNames.slice(0, 10).map(function(n) {
    return { label: n, value: stats.svcCount[n], tip: stats.svcCount[n] + ' execuções · ' + fmtUps(stats.svcUps[n]) + ' UPS' };
  });

  html += '<div class="chart-grid" style="margin-bottom:14px;">' +
    '<div class="card"><div class="card-title"><span class="material-symbols-outlined">donut_small</span> UPS por tipo de registro</div>' +
    hbarChart(typeRows, function(v) { return fmtUps(v); }) + '</div>' +
    '<div class="card"><div class="card-title"><span class="material-symbols-outlined">bar_chart</span> Serviços mais executados' +
    (stats.svcNames.length > 10 ? ' <span class="tag tag-neutral">top 10 de ' + stats.svcNames.length + '</span>' : '') + '</div>' +
    hbarChart(svcRows, function(v) { return v + 'x'; }) + '</div>' +
    '</div>';

  var catTotal = PERDAS_CATS.reduce(function(s, c) { return s + stats.catCount[c.key]; }, 0);
  if (catTotal > 0) {
    html += '<div class="card"><div class="card-title"><span class="material-symbols-outlined">electric_meter</span> PERDAS · execuções por categoria</div>' +
      hbarChart(PERDAS_CATS.map(function(c) { return { label: c.label, value: stats.catCount[c.key] }; }), function(v) { return v; }) + '</div>';
  }

  html += '<div class="card"><div class="card-title"><span class="material-symbols-outlined">leaderboard</span> Ranking de equipes no período</div>';
  if (stats.teamRanking.length > 0) {
    var maxUps = stats.teamRanking[0].ups || 1;
    html += '<div class="table-wrap"><table><thead><tr><th>#</th><th>Equipe</th><th class="hide-sm">Supervisor</th><th>Classe</th><th class="num">UPS</th><th class="num">Média/dia</th><th class="num">R$</th><th class="num">Lanç.</th><th class="num hide-sm">Dias</th><th class="hide-md" style="min-width:120px;">Participação</th></tr></thead><tbody>';
    stats.teamRanking.forEach(function(tr, i) {
      html += '<tr class="clickable" onclick="openTeamModal(\'' + tr.userId + '\')">' +
        '<td style="font-weight:700;">' + medalFor(i + 1) + '</td>' +
        '<td><strong>' + escapeHtml(tr.username) + '</strong></td>' +
        '<td class="hide-sm muted">' + (tr.supervisor ? escapeHtml(tr.supervisor) : '—') + '</td>' +
        '<td><span class="badge badge-xs" style="background:' + tr.color + ';">' + tr.class + '</span></td>' +
        '<td class="num ups">' + fmtUps(tr.ups) + '</td>' +
        '<td class="num">' + fmtUps(tr.avg) + '</td>' +
        '<td class="num money">' + fmtMoney(tr.money) + '</td>' +
        '<td class="num">' + tr.count + '</td>' +
        '<td class="num hide-sm">' + tr.days + '</td>' +
        '<td class="hide-md"><div class="progress"><span style="width:' + (tr.ups / maxUps * 100) + '%;background:var(--primary);"></span></div></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<div class="empty-state"><span class="material-symbols-outlined">query_stats</span><p>Nenhum lançamento no período com os filtros atuais</p></div>';
  }
  html += '</div>';

  container.innerHTML = html;
}


function formatService(s) {
  return {
    id: s.id,
    userId: s.user_id,
    serviceName: s.service_name,
    upsValue: s.ups_value || 0,
    quantity: s.quantity || 1,
    upsPerUnit: s.ups_per_unit || s.ups_value || 0,
    moneyPerUnit: s.money_per_unit || 0,
    totalMoney: s.total_money || 0,
    grade: s.grade || 0,
    latitude: s.latitude || '',
    longitude: s.longitude || '',
    city: s.city || '',
    address: s.address || '',
    time: s.time || '',
    date: s.date,
    type: s.type || 'catalog',
    activities: s.activities || [],
    editedBy: s.edited_by || '',
    editedAt: s.edited_at || null,
    categories: s.categories || [],
    phase: s.phase || '',
    sector: s.sector || ''
  };
}

function getClassification(totalUps) {
  if (!rulesCache || rulesCache.length === 0) {
    return { class: '-', color: '#94a3b8' };
  }
  for (var i = rulesCache.length - 1; i >= 0; i--) {
    var r = rulesCache[i];
    if (totalUps >= r.minUps && totalUps <= r.maxUps) {
      return { class: r.class, color: r.color };
    }
  }
  return { class: '-', color: '#94a3b8' };
}

// ===== LOGOUT =====
function logout() {
  if (refreshInterval) clearInterval(refreshInterval);
  if (window.heartbeatInterval) clearInterval(window.heartbeatInterval);
  stopLocationTracking();
  currentUser = null;
  monitorLocked = false;
  celebratedTeams = new Set();
  painelData = [];
  monitorData = [];
  mapData = [];
  supervisoresData = [];
  auditoriaData = null;
  classificacaoData = null;
  apontamentoItems = null;
  document.body.classList.remove('is-supervisor');
  clearCachedReads();
  showView('loginView');
  toast('Sessão encerrada', 'info');
}

// ===== MONITOR VIEW (SUPERVISOR / USUÁRIO) =====
// O supervisor tem a visão TRAVADA no mês vigente (sem seletor de data).
// O usuário (role 'user') pode escolher o período livremente.
var monitorLocked = false;

function initMonitorView(locked) {
  monitorLocked = !!locked;
  $('monUserName').textContent = currentUser.username + ' · ' + roleLabel(currentUser.role);
  var range = getMonitorRange();
  $('monPeriod').textContent = formatDateBr(range.start) + ' a ' + formatDateBr(range.end) + (monitorLocked ? ' · Mês vigente' : '');
  var banner = $('monLockBanner');
  var filters = $('monFilters');
  if (monitorLocked) {
    if (banner) banner.style.display = 'flex';
    if (filters) filters.style.display = 'none';
  } else {
    if (banner) banner.style.display = 'none';
    if (filters) {
      filters.style.display = 'flex';
      $('monStartDate').value = range.start;
      $('monEndDate').value = range.end;
      markPresets('mon');
    }
  }
  showView('monitorView');
  loadMonitorView();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadMonitorView, 30000);
}

// Supervisor: sempre o mês vigente (bloqueado). Usuário: período selecionado.
function getMonitorRange() {
  if (monitorLocked) return currentMonthRange();
  var start = $('monStartDate') && $('monStartDate').value;
  var end = $('monEndDate') && $('monEndDate').value;
  if (!start || !end) return currentMonthRange();
  return { start: start, end: end };
}

// Equipes autorizadas do usuário atual (sem admin)
function getMonitorTeamUsers() {
  return fbCached('users', CACHE_TTL).then(function(users) {
    var arr = toArray(users);
    var teams = arr.filter(isTeamUser);
    var ids = getUserTeamIds();
    if (ids === null) return teams;
    var idMap = {};
    ids.forEach(function(i) { idMap[i] = true; });
    return teams.filter(function(u) { return idMap[u.id]; });
  });
}

function loadMonitorView() {
  if (!currentUser) return;
  var range = getMonitorRange();
  var periodEl = $('monPeriod');
  if (periodEl) periodEl.textContent = formatDateBr(range.start) + ' a ' + formatDateBr(range.end) + (monitorLocked ? ' · Mês vigente' : '');
  if (!monitorLocked) markPresets('mon');
  // Spinner só na primeira carga; os refreshes de 30s são silenciosos
  if (!monitorData.length) loading(true);
  Promise.all([fbCached('rules', CACHE_TTL), getMonitorTeamUsers(), fbCached('catalog_services', 60000)]).then(function(results) {
    var rules = toArray(results[0]);
    if (rules.length) {
      rulesCache = rules.map(function(r) {
        return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
      });
    }
    var teams = results[1];
    loadMonitorServices(teams, range.start, range.end);
  }).catch(function(err) {
    loading(false);
    console.error('Erro ao carregar monitor:', err);
  });
}

// Baixa APENAS os serviços das equipes vinculadas (query no servidor)
// e filtra o período no cliente (o RTDB não combina orderBy com faixa de data).
var monitorData = [];
var monitorOpen = {};

function loadMonitorServices(teams, start, end) {
  var teamIds = teams.map(function(t) { return t.id; });
  if (teamIds.length === 0) {
    loading(false);
    monitorData = [];
    renderMonitorSummary([]);
    renderMonitorFiltered();
    return;
  }
  var queries = teamIds.map(function(id) {
    return OfflineDB.query('services', { orderBy: 'user_id', equalTo: id, limitToLast: 3000 }).catch(function() { return []; });
  });
  Promise.all(queries).then(function(results) {
    loading(false);
    monitorData = teams.map(function(team, i) {
      var recs = results[i] || [];
      var svcs = recs.filter(function(s) { return s.date >= start && s.date <= end; });
      var services = svcs.map(function(s) { return formatService(s); });
      services.sort(function(a, b) { return a.date === b.date ? String(b.time).localeCompare(String(a.time)) : (a.date > b.date ? -1 : 1); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);
      var classInfo = getClassification(totalUps);
      return withSectorInfo({
        userId: team.id, username: team.username,
        supervisor: team.supervisor || '',
        process: team.process || '',
        sector: sectorOf(team),
        goal_money: team.goal_money || 0,
        shift_start: team.shift_start || '', shift_end: team.shift_end || '',
        latitude: team.latitude || '', longitude: team.longitude || '',
        address: team.address || '', lastSeen: team.last_seen || null,
        services: services, totalUps: totalUps, totalMoney: totalMoney,
        class: classInfo.class, color: classInfo.color, count: services.length
      }, team, services);
    });
    fillSelect('mfClass', classOptions(), 'Todas classes');
    renderMonitorSummary(monitorData);
    renderMonitorFiltered();
  }).catch(function(err) {
    loading(false);
    console.error('Erro ao carregar serviços do monitor:', err);
  });
}

function renderMonitorSummary(teamsData) {
  var container = $('monSummaries');
  if (!container) return;
  if (!teamsData || teamsData.length === 0) {
    container.innerHTML = '';
    return;
  }
  var totalUps = teamsData.reduce(function(s, t) { return s + t.totalUps; }, 0);
  var totalMoney = teamsData.reduce(function(s, t) { return s + t.totalMoney; }, 0);
  var totalCount = teamsData.reduce(function(s, t) { return s + t.count; }, 0);
  var gradeCount = 0;
  teamsData.forEach(function(t) {
    t.services.forEach(function(s) { if (s.grade > 0) gradeCount++; });
  });
  var withGoal = teamsData.filter(function(t) { return teamGoalPct(t) >= 0; });
  var hitGoal = withGoal.filter(function(t) { return teamGoalPct(t) >= 100; }).length;
  var active = teamsData.filter(function(t) { return t.count > 0; }).length;
  container.innerHTML = '<div class="stats-overview">' +
    kpi('teams', 'groups', teamsData.length, 'Equipes', active + ' com produção') +
    kpi('ups', 'trending_up', fmtUps(totalUps), 'Total UPS') +
    kpi('money', 'payments', fmtMoney(totalMoney), 'Total R$') +
    kpi('services', 'assignment', totalCount, 'Serviços', gradeCount + ' com nota') +
    (withGoal.length ? kpi('goal', 'flag', hitGoal + '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + withGoal.length + '</small>', 'Metas atingidas') : '') +
    '</div>';
}

function renderMonitorFiltered() {
  var container = $('monTeamsContent');
  if (!container) return;
  if (!monitorData || monitorData.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe vinculada à sua conta. Procure o administrador.</p></div>';
    return;
  }
  markActiveFilters(['mfClass', 'mfGoal'], 'mfCount');
  var f = {
    search: valOf('mfSearch').trim().toLowerCase(),
    cls: valOf('mfClass'), goal: valOf('mfGoal')
  };
  var rank = upsRankMap(monitorData);
  var maxUps = monitorData.reduce(function(m, t) { return Math.max(m, t.totalUps); }, 0);
  var list = sortTeams(applyTeamFilters(monitorData, f), valOf('mfSort') || 'ups');
  var html = '<div class="result-info">Mostrando <strong>' + list.length + '</strong> de ' + monitorData.length + ' equipes</div>';
  if (!list.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">filter_alt_off</span><p>Nenhuma equipe corresponde aos filtros</p></div>';
    return;
  }
  list.forEach(function(t) {
    var accId = 'monAcc_' + t.userId;
    var isOpen = !!monitorOpen[t.userId];
    var color = t.color || '#94a3b8';
    var statusInfo = getStatusInfo(t.lastSeen);
    var barWidth = maxUps > 0 ? Math.max(t.totalUps > 0 ? 4 : 0, (t.totalUps / maxUps) * 100) : 0;
    html += '<div class="card acc-card">' +
      '<div class="ranking-item' + (isOpen ? ' open' : '') + '" onclick="toggleMonitorTeam(\'' + t.userId + '\', this)">' +
      '<div class="ranking-pos">' + medalFor(rank[t.userId]) + '</div>' +
      '<div class="badge badge-sm" style="background:' + color + ';">' + t.class + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name">' + escapeHtml(t.username) + '</div>' +
      '<div class="ranking-tags"><span class="ranking-status ' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></span></div>' +
      (goalProgressHtml(t) ? '<div class="ranking-extra">' + goalProgressHtml(t) + '</div>' : '') +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + fmtUps(t.totalUps) + ' UPS</div>' +
      (t.totalMoney ? '<div class="ranking-money">' + fmtMoney(t.totalMoney) + '</div>' : '') +
      '<div class="ranking-count">' + t.count + ' serviço' + (t.count !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<span class="material-symbols-outlined ranking-chevron">expand_more</span>' +
      '<div class="ranking-bar"><div class="ranking-bar-fill" style="width:' + barWidth + '%;background:' + color + ';"></div></div>' +
      '</div>';
    html += '<div class="acc-body' + (isOpen ? ' open' : '') + '" id="' + accId + '">';
    if (t.services && t.services.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>Data</th><th>Serviço</th><th class="num">Qtd</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Nota</th></tr></thead><tbody>';
      t.services.forEach(function(s) {
        html += '<tr>' +
          '<td style="white-space:nowrap;">' + formatDateBr(s.date) + (s.time ? ' <span class="muted" style="font-size:11px;color:var(--text-muted);">' + s.time.slice(0, 5) + '</span>' : '') + '</td>' +
          '<td>' + escapeHtml(s.serviceName) + '</td>' +
          '<td class="num">' + s.quantity + '</td>' +
          '<td class="num ups">' + fmtUps(s.upsValue) + '</td>' +
          '<td class="num money">' + (s.totalMoney ? fmtMoney(s.totalMoney) : '-') + '</td>' +
          '<td class="num">' + (s.grade || '-') + '</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="empty-state"><p>Nenhum serviço no período</p></div>';
    }
    html += '</div></div>';
  });
  container.innerHTML = html;
}

// Compatibilidade: chamadas antigas
function renderMonitorTeams(teamsData) {
  monitorData = teamsData || [];
  renderMonitorFiltered();
}


function toggleMonitorTeam(teamId, row) {
  monitorOpen[teamId] = !monitorOpen[teamId];
  var el = $('monAcc_' + teamId);
  if (el) el.classList.toggle('open', monitorOpen[teamId]);
  if (row) row.classList.toggle('open', monitorOpen[teamId]);
}

function exportMonitorData() {
  var range = getMonitorRange();
  if (!range.start || !range.end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  getMonitorTeamUsers().then(function(teams) {
    return buildCsvReport(teams, range.start, range.end);
  }).then(function(filtered) {
    loading(false);
    if (!filtered || filtered.length === 0) { toast('Nenhum dado para exportar no período', 'info'); return; }
    downloadCsv(filtered, 'exportacao_ups_' + range.start + '_to_' + range.end + '.csv');
  }).catch(function(err) {
    loading(false);
    toast('Erro ao exportar: ' + err.message, 'error');
  });
}

// ===== ADMIN: USUÁRIOS E SUPERVISORES =====
// Processos aos quais uma equipe pode ser vinculada.
var TEAM_PROCESSES = [
  'Construção 5 - Linha Morta Emergencial',
  'Construção 7 - Linha Morta',
  'Corte e Religação Leve',
  'Equipe Inspeção',
  'Inspeção de Obra',
  'Ligação Nova - Mini Sky',
  'Ligação Nova Leve',
  'Linha Viva 3 (04) e Linha Viva 4 (02)',
  'Manutenção',
  'Plantão - Mini Sky - 4x2',
  'Plantão 3 - 4x4',
  'Plantão 6 - 4x4',
  'Poda',
  'Poda Mid Sky',
  'Recolhimentos (Podas)'
];

function populateProcessSelect(selectId, selected) {
  var sel = $(selectId);
  if (!sel) return;
  var html = '<option value="">— Selecione o processo —</option>';
  TEAM_PROCESSES.forEach(function(p) {
    html += '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>';
  });
  // Preserva um processo legado que não esteja mais na lista
  if (selected && TEAM_PROCESSES.indexOf(selected) === -1) {
    html += '<option value="' + escapeHtml(selected) + '">' + escapeHtml(selected) + '</option>';
  }
  sel.innerHTML = html;
  sel.value = selected || '';
}

function populateSupervisorSelect(selectId, selectedId) {
  var sel = $(selectId);
  if (!sel) return;
  var supervisors = userCache.filter(function(u) { return u.role === 'supervisor'; });
  var current = selectedId || sel.value || '';
  sel.innerHTML = '<option value="">— Sem supervisor —</option>';
  supervisors.forEach(function(s) {
    var selAttr = (s.id === current) ? ' selected' : '';
    sel.innerHTML += '<option value="' + s.id + '"' + selAttr + '>' + escapeHtml(s.username) + '</option>';
  });
  sel.value = current;
}

function getCheckedTeams(containerId) {
  var container = $(containerId);
  var ids = [];
  if (!container) return ids;
  var boxes = container.querySelectorAll('input[type="checkbox"]:checked');
  for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
  return ids;
}

function populateTeamChecklist(containerId, selectedMap) {
  var container = $(containerId);
  if (!container) return;
  var teams = userCache.filter(isTeamUser);
  if (!teams.length) {
    container.innerHTML = '<div class="empty-state" style="padding:8px;">Nenhuma equipe cadastrada</div>';
    return;
  }
  var html = '';
  teams.forEach(function(t) {
    var checked = selectedMap && selectedMap[t.id] ? ' checked' : '';
    var boxId = containerId + '_' + t.id;
    html += '<div class="activity-item"><input type="checkbox" value="' + t.id + '" id="' + boxId + '"' + checked + '>' +
      '<label for="' + boxId + '" style="font-size:12px;cursor:pointer;">' + escapeHtml(t.username) + '</label></div>';
  });
  container.innerHTML = html;
}

function populateAdminForms() {
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    populateSupervisorSelect('newTeamSupervisor', '');
    populateProcessSelect('newTeamProcess', $('newTeamProcess') ? $('newTeamProcess').value : '');
    populateTeamChecklist('newUserTeams', null);
  }).catch(function() {});
}

// Vincula/desvincula uma equipe a uma conta de supervisor (em ambos os sentidos).
// Su-pervisores atualizam também o campo supervisor_id/supervisor da equipe;
// usuários visualizadores só recebem a permissão de visualização.
function linkTeamToSupervisor(supId, teamId, link) {
  if (!supId) return Promise.resolve();
  return fbOnce('users/' + supId).then(function(sup) {
    if (!sup) return;
    var name = sup.username || supId;
    var auth = sup.authorized_teams || {};
    if (link) {
      auth[teamId] = true;
    } else {
      delete auth[teamId];
    }
    var ops = [fbUpdate('users/' + supId, { authorized_teams: auth })];
    if (sup.role === 'supervisor') {
      if (link) {
        ops.push(fbUpdate('users/' + teamId, { supervisor_id: supId, supervisor: name }));
      } else {
        ops.push(fbOnce('users/' + teamId).then(function(team) {
          if (team && team.supervisor_id === supId) {
            return fbUpdate('users/' + teamId, { supervisor_id: '', supervisor: '' });
          }
        }));
      }
    }
    return Promise.all(ops);
  });
}

function createUser() {
  if (!ensureAdmin()) return;
  var name = $('newUserName').value.trim();
  var pass = $('newUserPass').value.trim();
  var role = $('newUserRole').value;
  if (!name || !pass) { showMsg('userFormMsg', 'error', 'Preencha nome de usuário e senha'); return; }
  clearMsg('userFormMsg');
  var teamIds = getCheckedTeams('newUserTeams');
  loading(true);
  fbOnce('users').then(function(users) {
    var arr = toArray(users);
    var exists = arr.some(function(u) { return u.username === name; });
    if (exists) {
      loading(false);
      showMsg('userFormMsg', 'error', 'Nome de usuário já existe');
      return;
    }
    var userData = {
      username: name, password: pass, role: role,
      authorized_teams: {},
      created_at: nowTimestamp(),
      created_by: currentUser ? currentUser.id : ''
    };
    teamIds.forEach(function(tid) { userData.authorized_teams[tid] = true; });
    return fbPush('users', userData).then(function(key) {
      var chain = Promise.resolve();
      teamIds.forEach(function(tid) {
        chain = chain.then(function() { return linkTeamToSupervisor(key, tid, true); });
      });
      return chain;
    });
  }).then(function() {
    loading(false);
    $('newUserName').value = '';
    $('newUserPass').value = '';
    toast('Usuário cadastrado com sucesso!', 'success');
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    showMsg('userFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function loadUsersList() {
  fbCached('users', CACHE_TTL).then(function(users) {
    renderUsersList(toArray(users));
  });
}

function renderUsersList(users) {
  var container = $('usersList');
  if (!container) return;
  var allManagers = users.filter(function(u) { return u.role === 'supervisor' || u.role === 'user'; });
  if (allManagers.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">manage_accounts</span><p>Nenhum usuário ou supervisor cadastrado</p></div>';
    return;
  }
  var q = valOf('usSearch').trim().toLowerCase();
  var managers = allManagers.filter(function(u) { return !q || String(u.username || '').toLowerCase().indexOf(q) !== -1; })
    .sort(function(a, b) { return String(a.username).localeCompare(String(b.username), 'pt-BR'); });
  if (managers.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhum usuário encontrado</p></div>';
    return;
  }
  var teamsMap = {};
  users.forEach(function(t) { if (t.role === 'equipe') teamsMap[t.id] = t.username; });
  var isSup = isSupervisor();
  var html = '<div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Equipes vinculadas</th>' + (isSup ? '' : '<th>Ações</th>') + '</tr></thead><tbody>';
  for (var i = 0; i < managers.length; i++) {
    var u = managers[i];
    var links = [];
    var auth = u.authorized_teams || {};
    Object.keys(auth).forEach(function(tid) {
      if (auth[tid] && teamsMap[tid]) links.push('<span class="tag tag-active">' + escapeHtml(teamsMap[tid]) + '</span>');
    });
    var band = links.length ? links.join(' ') : '<span style="color:var(--text-muted);">Nenhuma equipe</span>';
    html += '<tr>' +
      '<td><strong>' + escapeHtml(u.username) + '</strong></td>' +
      '<td><span class="tag ' + (u.role === 'supervisor' ? 'tag-active' : 'tag-inactive') + '">' + roleLabel(u.role) + '</span></td>' +
      '<td>' + band + '</td>' +
      (isSup ? '' : '<td class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editUser(\'' + u.id + '\')"><span class="material-symbols-outlined">edit</span> Editar</button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteUser(\'' + u.id + '\')"><span class="material-symbols-outlined">delete</span></button>' +
      '</td>') +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function editUser(id) {
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    loading(false);
    if (!user) { toast('Usuário não encontrado', 'error'); return; }
    $('editUserId').value = id;
    $('editUserName').value = user.username || '';
    $('editUserRole').value = (user.role === 'user') ? 'user' : 'supervisor';
    $('editUserPass').value = '';
    populateTeamChecklist('editUserTeams', user.authorized_teams || {});
    clearMsg('editUserMsg');
    $('editUserModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditUser() {
  if (!ensureAdmin()) return;
  var id = $('editUserId').value;
  var name = $('editUserName').value.trim();
  var role = $('editUserRole').value;
  var pass = $('editUserPass').value.trim();
  if (!name) { showMsg('editUserMsg', 'error', 'O nome de usuário é obrigatório'); return; }
  clearMsg('editUserMsg');
  var teamIds = getCheckedTeams('editUserTeams');
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var prevMap = (user && user.authorized_teams) || {};
    var updateData = { username: name, role: role };
    if (pass && pass.length >= 3) updateData.password = pass;
    var auth = {};
    teamIds.forEach(function(tid) { auth[tid] = true; });
    updateData.authorized_teams = auth;
    return fbUpdate('users/' + id, updateData).then(function() {
      var added = teamIds.filter(function(tid) { return !prevMap[tid]; });
      var removed = Object.keys(prevMap).filter(function(tid) { return teamIds.indexOf(tid) === -1; });
      var chain = Promise.resolve();
      added.forEach(function(tid) { chain = chain.then(function() { return linkTeamToSupervisor(id, tid, true); }); });
      removed.forEach(function(tid) { chain = chain.then(function() { return linkTeamToSupervisor(id, tid, false); }); });
      return chain;
    });
  }).then(function() {
    loading(false);
    toast('Usuário atualizado com sucesso!', 'success');
    closeEditUserModal();
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    showMsg('editUserMsg', 'error', 'Erro: ' + err.message);
  });
}

function deleteUser(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este usuário? As equipes vinculadas deixarão de ser visíveis para ele.')) return;
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var auth = (user && user.authorized_teams) || {};
    var teamIds = Object.keys(auth).filter(function(k) { return auth[k]; });
    var chain = Promise.resolve();
    teamIds.forEach(function(tid) {
      chain = chain.then(function() { return linkTeamToSupervisor(id, tid, false); });
    });
    return chain.then(function() { return fbRemove('users/' + id); });
  }).then(function() {
    loading(false);
    toast('Usuário excluído', 'info');
    clearCachedReads();
    loadAllAdminData();
    loadUsersList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeEditUserModal() {
  $('editUserModal').style.display = 'none';
}

function cleanupLocationHistory() {
  if (!ensureAdmin()) return;
  if (!confirm('Remover histórico de localização com mais de 30 dias? Isso libera espaço no banco e no dispositivo.')) return;
  loading(true);
  OfflineDB.pruneLocationHistory(30).then(function(res) {
    loading(false);
    toast('Localização antiga removida (' + ((res && res.removed) || 0) + ' registros).', 'success');
    updateSyncStatus();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function cleanupLocalRetention() {
  if (!ensureAdmin()) return;
  loading(true);
  OfflineDB.prune({ servicesDays: 365, locationDays: 30 }).then(function() {
    loading(false);
    toast('Retenção local aplicada: serviços > 365 dias e localização > 30 dias removidos.', 'success');
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function refreshCachedData() {
  if (!ensureAdmin()) return;
  clearCachedReads();
  toast('Cache de leitura invalidado. Próxima atualização busca dados novos.', 'info');
  loadAllAdminData();
}

// ===== ADMIN VIEW =====
function applyDateRangeTo(id) {
  var el = $(id);
  if (!el) return;
  var range = getAllowedDateRange();
  if (range) {
    el.min = range.start;
    el.max = range.end;
  } else {
    el.removeAttribute('min');
    el.removeAttribute('max');
  }
}

// Aplica restrições visuais/de período para supervisor (somente visualização,
// dados das próprias equipes e últimos 3 dias).
function applyAdminRestrictions() {
  var isSup = isSupervisor();
  document.body.classList.toggle('is-supervisor', isSup);
  var roleEl = $('adminRoleLabel');
  if (roleEl) roleEl.textContent = currentUser ? ' · ' + currentUser.username + ' (' + roleLabel(currentUser.role) + ')' : '';

  ['adminStartDate', 'adminEndDate', 'auditoriaStartDate', 'auditoriaEndDate',
   'classificacaoStartDate', 'classificacaoEndDate', 'apontamentoStartDate', 'apontamentoEndDate']
    .forEach(applyDateRangeTo);

  [['newTeamCard', isSup], ['newUserCard', isSup], ['maintenanceCard', isSup],
   ['newCatalogCard', isSup], ['rulesAddActions', isSup], ['rulesSaveBtn', isSup]]
    .forEach(function(pair) {
      var el = $(pair[0]);
      if (el) el.style.display = pair[1] ? 'none' : '';
    });
}

var activeAdminTab = 'tabPainel';
var PERIOD_TABS = ['tabPainel', 'tabPerdas', 'tabEstatisticas', 'tabSupervisores', 'tabMapa'];

function initAdminView() {
  var today = todayStr();
  var isSup = isSupervisor();
  // Mantém o período escolhido ao reinicializar (ex.: após sincronizar)
  if (!adminBound || !$('adminStartDate').value) {
    $('adminStartDate').value = clampDateToAllowed(today);
    $('adminEndDate').value = clampDateToAllowed(today);
  }
  $('adminDate').textContent = formatDateBr(today);
  applyAdminRestrictions();
  showView('adminView');
  if (!adminBound) {
    adminBound = true;
    initTabs();
    var onDate = function() { loadAllAdminData(); };
    $('adminStartDate').addEventListener('change', onDate);
    $('adminEndDate').addEventListener('change', onDate);
    var pv = loadPref('painelSort', '');
    if (pv && $('pfSort')) $('pfSort').value = pv;
  }
  var lastTab = loadPref('adminTab', 'tabPainel');
  switchAdminTab(lastTab, lastTab === 'tabPainel');
  loadAllAdminData();
  populateAdminForms();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadAllAdminData, 30000);
  if (!isSup) setTimeout(captureAdminLocation, 500);
}

function initTabs() {
  var tabs = document.querySelectorAll('#adminTabs .nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function() {
      switchAdminTab(this.getAttribute('data-tab'));
    });
  }
}

function switchAdminTab(tabId, silent) {
  if (!$(tabId)) tabId = 'tabPainel';
  activeAdminTab = tabId;
  savePref('adminTab', tabId);
  var tabs = document.querySelectorAll('#adminTabs .nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    var on = tabs[i].getAttribute('data-tab') === tabId;
    tabs[i].classList.toggle('active', on);
    tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && tabs[i].scrollIntoView) {
      try { tabs[i].scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }
  }
  var contents = document.querySelectorAll('#adminView .tab-content');
  for (var j = 0; j < contents.length; j++) contents[j].classList.toggle('active', contents[j].id === tabId);
  var bar = $('adminPeriodBar');
  if (bar) bar.style.display = PERIOD_TABS.indexOf(tabId) !== -1 ? '' : 'none';
  if (silent) return;

  if (tabId === 'tabPainel') renderPainelFiltered();
  if (tabId === 'tabPerdas') renderPerdasFiltered();
  if (tabId === 'tabEquipes') { loadTeamsList(); populateAdminForms(); }
  if (tabId === 'tabUsuarios') { loadUsersList(); populateAdminForms(); }
  if (tabId === 'tabServicos') loadCatalogList();
  if (tabId === 'tabMapa') setTimeout(function() { initMap(); if (map) map.invalidateSize(); }, 100);
  if (tabId === 'tabEstatisticas') loadStatistics();
  if (tabId === 'tabRegras') loadRules();
  if (tabId === 'tabSupervisores') loadSupervisores();
  if (tabId === 'tabAuditoria') initAuditoria();
  if (tabId === 'tabClassificacao') initClassificacao();
  if (tabId === 'tabApontamento') initApontamento();
}

function loadAllAdminData() {
  var start = clampDateToAllowed($('adminStartDate').value) || clampDateToAllowed(todayStr());
  var end = clampDateToAllowed($('adminEndDate').value) || start;
  if (start > end) { var tmp = start; start = end; end = tmp; }
  $('adminStartDate').value = start;
  $('adminEndDate').value = end;
  markPresets('admin');
  fbCached('rules', CACHE_TTL).then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
    loadPainel(start, end);
    if (activeAdminTab === 'tabMapa') loadMapData(start, end);
    if (activeAdminTab === 'tabSupervisores') loadSupervisores();
    if (activeAdminTab === 'tabEstatisticas') loadStatistics();
  });
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    syncCurrentUserAutorizations();
    if (activeAdminTab === 'tabEquipes') renderTeamsList(userCache);
  });
  if (activeAdminTab === 'tabServicos') loadCatalogList();
}

// Mantém as autorizações do supervisor atualizadas em tempo real (equipes
// vinculadas pelo admin sem precisar reentrar).
function syncCurrentUserAutorizations() {
  if (!currentUser || currentUser.role !== 'supervisor') return;
  if (!userCache || !userCache.length) return;
  var self = userCache.find(function(u) { return u.id === currentUser.id; });
  if (self) {
    currentUser.authorized_teams = self.authorized_teams || {};
  }
}

// --- Painel ---
var painelData = [];
var painelPeriod = { start: '', end: '' };

function loadPainel(start, end) {
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    painelPeriod = { start: start, end: end };
    renderPainel(data);
  }).catch(function(err) {
    console.error('Erro ao carregar painel:', err);
  });
}

function getStatusInfo(lastSeen) {
  if (!lastSeen) return { status: 'offline', label: 'Offline', className: 'status-offline' };
  var now = Date.now();
  var diffMin = (now - lastSeen) / 60000;
  if (diffMin < 5) return { status: 'online', label: 'Online', className: 'status-online' };
  var d = new Date(lastSeen);
  var sameDay = formatDate(d) === todayStr();
  var timeStr = sameDay
    ? 'hoje ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return { status: 'offline', label: 'Visto ' + timeStr, className: 'status-offline' };
}

function renderPainel(data) {
  painelData = data || [];
  // O Painel principal é do STC; PERDAS tem aba própria
  var stc = painelData.filter(function(t) { return t.sector !== 'PERDAS'; });
  var perdas = painelData.filter(function(t) { return t.sector === 'PERDAS'; });
  fillSelect('pfSupervisor', supervisorOptions(stc), 'Todos supervisores');
  fillSelect('pfProcess', processOptions(stc), 'Todos processos');
  fillSelect('lfSupervisor', supervisorOptions(perdas), 'Todos supervisores');
  fillSelect('lfProcess', processOptions(perdas), 'Todos processos');
  fillSelect('lfClass', classOptions(), 'Todas classes');
  renderPerdasFiltered();
  fillSelect('pfClass', classOptions(), 'Todas classes');
  renderPainelFiltered();
}

var onPainelFilter = function() {
  savePref('painelSort', valOf('pfSort'));
  renderPainelFiltered();
};

function clearPainelFilters() {
  clearFilters(['pfSearch', 'pfSupervisor', 'pfProcess', 'pfClass', 'pfStatus', 'pfGoal'], renderPainelFiltered);
}

function setPainelClass(cls) {
  var sel = $('pfClass');
  if (!sel) return;
  sel.value = sel.value === cls ? '' : cls;
  renderPainelFiltered();
}

function setPainelSort(key) {
  var sel = $('pfSort');
  if (!sel) return;
  sel.value = key;
  onPainelFilter();
}

function setPainelView(mode) {
  savePref('painelView', mode);
  renderPainelFiltered();
}

function readPainelFilters() {
  return {
    search: valOf('pfSearch').trim().toLowerCase(),
    supervisor: valOf('pfSupervisor'), process: valOf('pfProcess'),
    cls: valOf('pfClass'), status: valOf('pfStatus'), goal: valOf('pfGoal')
  };
}

function renderPainelFiltered() {
  var container = $('adminPainelContent');
  if (!container) return;
  var data = painelData.filter(function(t) { return t.sector !== 'PERDAS'; });
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>' +
      (isSupervisor() ? 'Nenhuma equipe STC vinculada à sua conta' : 'Nenhuma equipe STC cadastrada') + '</p></div>';
    return;
  }
  markActiveFilters(['pfSupervisor', 'pfProcess', 'pfClass', 'pfStatus', 'pfGoal'], 'pfCount');
  var f = readPainelFilters();
  var sortKey = valOf('pfSort') || 'ups';
  var viewMode = loadPref('painelView', 'list');
  var list = sortTeams(applyTeamFilters(data, f), sortKey);
  var rank = upsRankMap(data);

  var totalUps = 0, totalMoney = 0, totalServices = 0, gradeCount = 0, online = 0, withGoal = 0, hitGoal = 0, active = 0;
  list.forEach(function(t) {
    totalUps += t.totalUps; totalMoney += t.totalMoney; totalServices += t.count;
    if (t.count > 0) active++;
    t.services.forEach(function(s) { if (s.grade > 0) gradeCount++; });
    if (getStatusInfo(t.lastSeen).status === 'online') online++;
    if (teamGoalPct(t) >= 0) { withGoal++; if (teamGoalPct(t) >= 100) hitGoal++; }
  });
  var filtered = list.length !== data.length;

  var html = '<div class="stats-overview">' +
    kpi('teams', 'groups', list.length + (filtered ? '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + data.length + '</small>' : ''), 'Equipes', active + ' com produção') +
    kpi('online', 'wifi', online, 'Online agora') +
    kpi('ups', 'trending_up', fmtUps(totalUps), 'Total UPS', list.length ? 'média ' + fmtUps(totalUps / list.length) + ' por equipe' : '') +
    kpi('money', 'payments', fmtMoney(totalMoney), 'Total R$') +
    kpi('services', 'assignment', totalServices, 'Serviços', gradeCount + ' com nota') +
    (withGoal ? kpi('goal', 'flag', hitGoal + '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + withGoal + '</small>', 'Metas atingidas') : '') +
    '</div>';

  // Distribuição por classe (clique para filtrar)
  if (rulesCache && rulesCache.length) {
    var fNoClass = {}; Object.keys(f).forEach(function(k) { fNoClass[k] = f[k]; }); fNoClass.cls = '';
    var base = applyTeamFilters(data, fNoClass);
    var counts = {};
    base.forEach(function(t) { counts[t.class] = (counts[t.class] || 0) + 1; });
    html += '<div class="chips" style="margin-bottom:12px;">';
    rulesCache.forEach(function(r) {
      html += '<button class="chip' + (f.cls === r.class ? ' active' : '') + '" onclick="setPainelClass(\'' + escapeHtml(r.class) + '\')" title="Filtrar classe ' + escapeHtml(r.class) + '">' +
        '<span class="chip-dot" style="background:' + r.color + ';"></span>Classe ' + escapeHtml(r.class) + ' <span class="chip-count">' + (counts[r.class] || 0) + '</span></button>';
    });
    if (counts['-']) html += '<span class="chip" style="cursor:default;"><span class="chip-dot" style="background:#94a3b8;"></span>Sem classe <span class="chip-count">' + counts['-'] + '</span></span>';
    html += '</div>';
  }

  html += '<div class="section-label"><span>Ranking de equipes STC · ' + periodLabel(painelPeriod.start, painelPeriod.end) + '</span>' +
    '<div class="segmented-sm" role="group" aria-label="Modo de visualização">' +
    '<button class="' + (viewMode === 'list' ? 'active' : '') + '" onclick="setPainelView(\'list\')" title="Lista"><span class="material-symbols-outlined">view_agenda</span><span class="hide-sm">Lista</span></button>' +
    '<button class="' + (viewMode === 'table' ? 'active' : '') + '" onclick="setPainelView(\'table\')" title="Tabela"><span class="material-symbols-outlined">table_rows</span><span class="hide-sm">Tabela</span></button>' +
    '</div></div>';

  if (filtered) {
    html += '<div class="result-info">Mostrando <strong>' + list.length + '</strong> de ' + data.length + ' equipes · <button class="link-btn" onclick="clearPainelFilters()">limpar filtros</button></div>';
  }

  if (!list.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">filter_alt_off</span><p>Nenhuma equipe corresponde aos filtros</p></div>';
    return;
  }

  var maxUps = data.reduce(function(m, t) { return Math.max(m, t.totalUps); }, 0);
  if (viewMode === 'table') {
    var th = function(key, label, cls) {
      return '<th class="sortable' + (sortKey === key ? ' sorted' : '') + (cls ? ' ' + cls : '') + '" onclick="setPainelSort(\'' + key + '\')">' + label + (sortKey === key ? ' ↓' : '') + '</th>';
    };
    html += '<div class="table-wrap"><table><thead><tr><th>#</th>' + th('name', 'Equipe') + '<th>Classe</th><th class="hide-sm">Supervisor</th><th class="hide-md">Processo</th><th>Status</th>' +
      th('ups', 'UPS', 'num') + th('money', 'R$', 'num') + th('count', 'Serv.', 'num') + th('goal', 'Meta', '') + '</tr></thead><tbody>';
    list.forEach(function(t) {
      var st = getStatusInfo(t.lastSeen);
      var gp = teamGoalPct(t);
      html += '<tr class="clickable" onclick="openTeamModal(\'' + t.userId + '\')">' +
        '<td style="font-weight:700;">' + medalFor(rank[t.userId]) + '</td>' +
        '<td><strong>' + escapeHtml(t.username) + '</strong></td>' +
        '<td><span class="badge badge-xs" style="background:' + (t.color || '#94a3b8') + ';">' + t.class + '</span></td>' +
        '<td class="hide-sm muted">' + (t.supervisor ? escapeHtml(t.supervisor) : '—') + '</td>' +
        '<td class="hide-md muted" style="font-size:12px;">' + sectorTag(t.sector) + ' ' + (t.process ? escapeHtml(t.process) : '—') + '</td>' +
        '<td><span class="' + st.className + '"><span class="status-dot"></span><span class="status-label">' + (st.status === 'online' ? 'Online' : 'Offline') + '</span></span></td>' +
        '<td class="num ups">' + fmtUps(t.totalUps) + '</td>' +
        '<td class="num money">' + fmtMoney(t.totalMoney) + '</td>' +
        '<td class="num">' + t.count + '</td>' +
        '<td style="min-width:110px;">' + (gp >= 0
          ? '<div style="display:flex;align-items:center;gap:6px;"><div class="progress" style="flex:1;"><span style="width:' + Math.min(100, gp) + '%;background:' + goalColor(gp) + ';"></span></div><span style="font-size:11px;font-weight:700;min-width:34px;text-align:right;">' + Math.round(gp) + '%</span></div>'
          : '<span class="muted" style="font-size:11px;color:var(--text-muted);">Sem meta</span>') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
    return;
  }

  html += '<div class="ranking-list">';
  list.forEach(function(t) {
    var color = t.color || '#94a3b8';
    var statusInfo = getStatusInfo(t.lastSeen);
    var barWidth = maxUps > 0 ? Math.max(t.totalUps > 0 ? 4 : 0, (t.totalUps / maxUps) * 100) : 0;
    var teamGradeCount = t.services.filter(function(s) { return s.grade > 0; }).length;
    var extra = goalProgressHtml(t) + shiftMiniBar(t);
    html += '<div class="ranking-item" onclick="openTeamModal(\'' + t.userId + '\')">' +
      '<div class="ranking-pos">' + medalFor(rank[t.userId]) + '</div>' +
      '<div class="badge badge-sm" style="background:' + color + ';">' + t.class + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name">' + escapeHtml(t.username) + (t.supervisor ? ' <small>· ' + escapeHtml(t.supervisor) + '</small>' : '') + '</div>' +
      '<div class="ranking-tags"><span class="ranking-status ' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></span>' +
      sectorTag(t.sector) + (t.process ? '<span class="tag tag-neutral hide-sm">' + escapeHtml(t.process) + '</span>' : '') + '</div>' +
      (extra ? '<div class="ranking-extra">' + extra + '</div>' : '') +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + fmtUps(t.totalUps) + ' UPS</div>' +
      (t.totalMoney ? '<div class="ranking-money">' + fmtMoney(t.totalMoney) + '</div>' : '') +
      '<div class="ranking-count">' + t.count + ' serviço' + (t.count !== 1 ? 's' : '') + '</div>' +
      (teamGradeCount > 0 ? '<div class="ranking-grade">' + teamGradeCount + ' nota' + (teamGradeCount !== 1 ? 's' : '') + '</div>' : '') +
      '</div>' +
      '<div class="ranking-bar"><div class="ranking-bar-fill" style="width:' + barWidth + '%;background:' + color + ';"></div></div>' +
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

// --- Painel de PERDAS (separado do Painel STC) ---
var PERDAS_FILTER_IDS = ['lfSupervisor', 'lfProcess', 'lfClass', 'lfStatus', 'lfGoal'];

function clearPerdasFilters() {
  clearFilters(['lfSearch'].concat(PERDAS_FILTER_IDS), renderPerdasFiltered);
}

function setPerdasSort(key) {
  var sel = $('lfSort');
  if (!sel) return;
  sel.value = key;
  renderPerdasFiltered();
}

// Ordenação específica de PERDAS (inclui as categorias)
function sortPerdasTeams(arr, key) {
  if (PERDAS_CATS.some(function(c) { return c.key === key; })) {
    return arr.slice().sort(function(a, b) { return ((b.perdas || {})[key] || 0) - ((a.perdas || {})[key] || 0); });
  }
  return sortTeams(arr, key);
}

// Célula "realizado / meta" com barra para cada categoria
function perdasCatCell(t, key) {
  var done = (t.perdas || {})[key] || 0;
  var goal = (t.perdasGoals || {})[key] || 0;
  if (!goal) return '<td class="num"><strong>' + done + '</strong></td>';
  var pct = (done / goal) * 100;
  return '<td style="min-width:110px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;gap:6px;">' +
    '<strong>' + done + ' / ' + goal + '</strong><span style="color:' + goalColor(pct) + ';font-weight:700;">' + Math.round(pct) + '%</span></div>' +
    '<div class="progress"><span style="width:' + Math.min(100, pct) + '%;background:' + goalColor(pct) + ';"></span></div></td>';
}

function renderPerdasFiltered() {
  var container = $('perdasContent');
  if (!container) return;
  var data = (painelData || []).filter(function(t) { return t.sector === 'PERDAS'; });
  if (!data.length) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">electric_meter</span><p>' +
      (isSupervisor() ? 'Nenhuma equipe de PERDAS vinculada à sua conta' : 'Nenhuma equipe de PERDAS cadastrada. Defina o setor PERDAS no cadastro da equipe.') + '</p></div>';
    return;
  }
  markActiveFilters(PERDAS_FILTER_IDS, 'lfCount');
  var f = {
    search: valOf('lfSearch').trim().toLowerCase(),
    supervisor: valOf('lfSupervisor'), process: valOf('lfProcess'),
    cls: valOf('lfClass'), status: valOf('lfStatus'), goal: valOf('lfGoal')
  };
  var sortKey = valOf('lfSort') || 'ups';
  var list = sortPerdasTeams(applyTeamFilters(data, f), sortKey);
  var rank = upsRankMap(data);
  var filtered = list.length !== data.length;

  // Totais do conjunto filtrado
  var tot = { ups: 0, count: 0, online: 0, active: 0, withGoal: 0, hitGoal: 0 };
  var cats = { fiscalizacao: 0, normalizacao: 0, fraude: 0 };
  var catGoals = { fiscalizacao: 0, normalizacao: 0, fraude: 0 };
  var phases = { mono: { n: 0, ups: 0 }, bi: { n: 0, ups: 0 }, tri: { n: 0, ups: 0 } };
  list.forEach(function(t) {
    tot.ups += t.totalUps; tot.count += t.count;
    if (t.count > 0) tot.active++;
    if (getStatusInfo(t.lastSeen).status === 'online') tot.online++;
    var gp = teamGoalPct(t);
    if (gp >= 0) { tot.withGoal++; if (gp >= 100) tot.hitGoal++; }
    PERDAS_CATS.forEach(function(c) {
      cats[c.key] += (t.perdas || {})[c.key] || 0;
      catGoals[c.key] += (t.perdasGoals || {})[c.key] || 0;
    });
    t.services.forEach(function(s) {
      if (phases[s.phase]) { phases[s.phase].n++; phases[s.phase].ups += s.upsValue; }
    });
  });

  var small = function(v) { return '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + v + '</small>'; };
  var html = '<div class="stats-overview">' +
    kpi('teams', 'groups', list.length + (filtered ? small(data.length) : ''), 'Equipes PERDAS', tot.active + ' com produção') +
    kpi('online', 'wifi', tot.online, 'Online agora') +
    kpi('ups', 'trending_up', fmtUps(tot.ups), 'Total UPS', list.length ? 'média ' + fmtUps(tot.ups / list.length) + ' por equipe' : '') +
    kpi('services', 'assignment', tot.count, 'Lançamentos') +
    (tot.withGoal ? kpi('goal', 'flag', tot.hitGoal + small(tot.withGoal), 'Metas atingidas') : '') +
    '</div>';

  // Metas consolidadas por categoria + distribuição MONO/BI/TRI
  html += '<div class="chart-grid" style="margin-bottom:14px;">';
  html += '<div class="card"><div class="card-title"><span class="material-symbols-outlined">flag</span> Execuções × metas</div><div style="display:grid;gap:12px;">';
  PERDAS_CATS.forEach(function(c) {
    var done = cats[c.key], goal = catGoals[c.key];
    if (goal > 0) {
      html += progressHtml('<strong style="color:var(--text);font-size:13px;">' + c.label + '</strong> · ' + done + ' de ' + goal, (done / goal) * 100, goalColor((done / goal) * 100));
    } else {
      html += '<div class="progress-meta" style="font-size:12px;"><span><strong style="color:var(--text);font-size:13px;">' + c.label + '</strong> · ' + done + ' execuções</span><span>sem meta</span></div>';
    }
  });
  html += '</div></div>';
  var phaseTotal = phases.mono.n + phases.bi.n + phases.tri.n;
  html += '<div class="card"><div class="card-title"><span class="material-symbols-outlined">electrical_services</span> Lançamentos por tipo de ligação</div>' +
    (phaseTotal ? hbarChart(['mono', 'bi', 'tri'].map(function(k) {
      return { label: PHASE_LABELS[k], value: phases[k].n, sub: fmtUps(phases[k].ups) + ' UPS', tip: phases[k].n + ' lançamentos · ' + fmtUps(phases[k].ups) + ' UPS' };
    }), function(v) { return v; }) : '<div class="empty-state"><p>Nenhum lançamento no período</p></div>') +
    '</div>';
  html += '</div>';

  html += '<div class="section-label"><span>Ranking de equipes PERDAS · ' + periodLabel(painelPeriod.start, painelPeriod.end) + '</span></div>';
  if (filtered) {
    html += '<div class="result-info">Mostrando <strong>' + list.length + '</strong> de ' + data.length + ' equipes · <button class="link-btn" onclick="clearPerdasFilters()">limpar filtros</button></div>';
  }
  if (!list.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">filter_alt_off</span><p>Nenhuma equipe corresponde aos filtros</p></div>';
    return;
  }

  var th = function(key, label, cls) {
    return '<th class="sortable' + (sortKey === key ? ' sorted' : '') + (cls ? ' ' + cls : '') + '" onclick="setPerdasSort(\'' + key + '\')">' + label + (sortKey === key ? ' ↓' : '') + '</th>';
  };
  html += '<div class="table-wrap"><table><thead><tr><th>#</th>' + th('name', 'Equipe') + '<th>Classe</th><th class="hide-sm">Supervisor</th><th>Status</th>' +
    th('ups', 'UPS', 'num') + th('count', 'Lanç.', 'num') +
    th('fiscalizacao', 'Fiscalização') + th('normalizacao', 'Normalização') + th('fraude', 'Fraude') + '</tr></thead><tbody>';
  list.forEach(function(t) {
    var st = getStatusInfo(t.lastSeen);
    html += '<tr class="clickable" onclick="openTeamModal(\'' + t.userId + '\')">' +
      '<td style="font-weight:700;">' + medalFor(rank[t.userId]) + '</td>' +
      '<td><strong>' + escapeHtml(t.username) + '</strong>' + (t.process ? '<br><span style="font-size:11px;color:var(--text-muted);">' + escapeHtml(t.process) + '</span>' : '') + '</td>' +
      '<td><span class="badge badge-xs" style="background:' + (t.color || '#94a3b8') + ';">' + t.class + '</span></td>' +
      '<td class="hide-sm muted">' + (t.supervisor ? escapeHtml(t.supervisor) : '—') + '</td>' +
      '<td><span class="' + st.className + '"><span class="status-dot"></span><span class="status-label">' + (st.status === 'online' ? 'Online' : 'Offline') + '</span></span></td>' +
      '<td class="num ups">' + fmtUps(t.totalUps) + '</td>' +
      '<td class="num">' + t.count + '</td>' +
      perdasCatCell(t, 'fiscalizacao') + perdasCatCell(t, 'normalizacao') + perdasCatCell(t, 'fraude') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}


// --- Equipes ---
function loadTeamsList() {
  fbCached('users', CACHE_TTL).then(function(users) {
    userCache = toArray(users);
    renderTeamsList(userCache);
  });
}

function renderTeamsList(users) {
  var container = $('teamsList');
  if (!container) return;
  var isSup = isSupervisor();
  var allTeams = (users || []).filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
  if (allTeams.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>' +
      (isSup ? 'Nenhuma equipe vinculada à sua conta' : 'Nenhuma equipe cadastrada') + '</p></div>';
    return;
  }
  fillSelect('eqProcess', processOptions(allTeams), 'Todos processos');
  fillSelect('eqSupervisor', supervisorOptions(allTeams), 'Todos supervisores');
  markActiveFilters(['eqSector', 'eqProcess', 'eqSupervisor'], '');
  var q = valOf('eqSearch').trim().toLowerCase();
  var fProc = valOf('eqProcess'), fSup = valOf('eqSupervisor'), fSector = valOf('eqSector');
  var teams = allTeams.filter(function(t) {
    if (q && String(t.username || '').toLowerCase().indexOf(q) === -1) return false;
    if (fSector && sectorOf(t) !== fSector) return false;
    return matchOptional(fProc, t.process || '') && matchOptional(fSup, t.supervisor || '');
  }).sort(function(a, b) { return String(a.username).localeCompare(String(b.username), 'pt-BR'); });

  var dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  var html = '<div class="result-info">Mostrando <strong>' + teams.length + '</strong> de ' + allTeams.length + ' equipes</div>';
  if (!teams.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhuma equipe encontrada</p></div>';
    return;
  }
  html += '<div class="table-wrap"><table><thead><tr><th>Equipe</th><th>Setor</th><th>Processo</th><th>Supervisor</th><th class="num">Meta</th><th>Status</th><th>Turno</th><th>Dias</th><th class="hide-md">Localização</th>' + (isSup ? '' : '<th></th>') + '</tr></thead><tbody>';
  teams.forEach(function(t) {
    var statusInfo = getStatusInfo(t.last_seen);
    var statusHtml = '<span class="' + statusInfo.className + '"><span class="status-dot"></span><span class="status-label">' + statusInfo.label + '</span></span>';
    var locDisplay = (t.latitude && t.longitude)
      ? '<span style="font-size:11px;color:var(--text-muted);" title="' + escapeHtml(t.address || '') + '">' + parseFloat(t.latitude).toFixed(4) + ', ' + parseFloat(t.longitude).toFixed(4) + '</span>'
      : '<span style="color:var(--text-muted);">—</span>';
    var shiftDisplay = '<span style="color:var(--text-muted);">—</span>';
    var shiftSp = getShiftProgress(t);
    if (shiftSp.enabled) {
      shiftDisplay = '<span style="font-size:12px;font-weight:600;white-space:nowrap;">' + shiftSp.start + ' – ' + shiftSp.end + '</span>' +
        '<br><span style="font-size:10.5px;font-weight:700;color:' + shiftColor(shiftSp) + ';">' + shiftSp.label + '</span>';
    }
    var daysDisplay = (t.days_of_week && t.days_of_week.length > 0)
      ? t.days_of_week.map(function(d) { return '<span class="tag tag-primary" style="margin:1px;padding:0 5px;font-size:10px;">' + dayNames[d] + '</span>'; }).join('')
      : '<span style="color:var(--text-muted);">—</span>';
    html += '<tr>' +
      '<td><strong>' + escapeHtml(t.username) + '</strong><br><span style="font-size:10.5px;color:var(--text-muted);">#' + t.id.slice(-6) + '</span></td>' +
      '<td>' + sectorTag(sectorOf(t)) + '</td>' +
      '<td style="font-size:12px;">' + (t.process ? escapeHtml(t.process) : '<span style="color:var(--text-muted);">—</span>') + '</td>' +
      '<td>' + (t.supervisor ? escapeHtml(t.supervisor) : '<span style="color:var(--text-muted);">—</span>') + '</td>' +
      '<td class="num money">' + (goalLabelOf({ sector: sectorOf(t), goal_money: t.goal_money, perdasGoals: perdasGoalsOf(t) }) || '<span style="color:var(--text-muted);">—</span>') + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td>' + shiftDisplay + '</td>' +
      '<td style="min-width:110px;">' + daysDisplay + '</td>' +
      '<td class="hide-md">' + locDisplay + '</td>' +
      (isSup ? '' : '<td><div class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editTeam(\'' + t.id + '\')" title="Editar"><span class="material-symbols-outlined">edit</span></button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteTeam(\'' + t.id + '\')" title="Excluir"><span class="material-symbols-outlined">delete</span></button>' +
      '</div></td>') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}


// PERDAS não trabalha com valor em dinheiro: a meta financeira não se aplica
function onTeamSectorFormChange(prefix) {
  var isPerdas = valOf(prefix + 'TeamSector') === 'PERDAS';
  var goalGroup = $(prefix + 'TeamGoalGroup');
  if (goalGroup) goalGroup.style.display = isPerdas ? 'none' : '';
  var perdasGoals = $(prefix + 'TeamPerdasGoals');
  if (perdasGoals) perdasGoals.style.display = isPerdas ? '' : 'none';
}

// Lê as metas de PERDAS do formulário (zeradas quando a equipe é STC)
function readPerdasGoals(prefix, sector) {
  var n = function(id) { return sector === 'PERDAS' ? Math.max(0, parseInt(valOf(id), 10) || 0) : 0; };
  return {
    goal_fiscalizacao: n(prefix + 'TeamGoalFisc'),
    goal_normalizacao: n(prefix + 'TeamGoalNorm'),
    goal_fraude: n(prefix + 'TeamGoalFraude')
  };
}

function captureLocationForTeam() {
  captureAdminLocation();
}

function getSelectedDaysOfWeek() {
  var days = [];
  var checkboxes = document.querySelectorAll('#newTeamDays input[name="teamDay"]:checked');
  for (var i = 0; i < checkboxes.length; i++) {
    days.push(parseInt(checkboxes[i].value));
  }
  return days;
}

function setSelectedDaysOfWeek(days) {
  var checkboxes = document.querySelectorAll('#editTeamDays input[name="editTeamDay"]');
  for (var i = 0; i < checkboxes.length; i++) {
    checkboxes[i].checked = days && days.indexOf(parseInt(checkboxes[i].value)) !== -1;
  }
}

function createTeam() {
  if (!ensureAdmin()) return;
  var name = $('newTeamName').value.trim();
  var pass = $('newTeamPass').value.trim();
  var supId = $('newTeamSupervisor').value;
  var process = $('newTeamProcess').value;
  var sector = $('newTeamSector').value;
  var goalRaw = $('newTeamGoal').value;
  var goalMoney = sector === 'PERDAS' ? 0 : (parseFloat(goalRaw) || 0);
  var shiftStart = $('newTeamShiftStart').value;
  var shiftEnd = $('newTeamShiftEnd').value;
  var daysOfWeek = getSelectedDaysOfWeek();
  if (!name || !pass) { showMsg('teamFormMsgAdmin', 'error', 'Preencha nome e senha da equipe'); return; }
  if (SECTORS.indexOf(sector) === -1) { showMsg('teamFormMsgAdmin', 'error', 'Selecione o setor da equipe (STC ou PERDAS)'); return; }
  clearMsg('teamFormMsgAdmin');

  if (!adminLocation) {
    showMsg('teamFormMsgAdmin', 'warning', 'Capturando localização... Clique novamente para criar com localização automática, ou clique em "Detectar" primeiro.');
    captureAdminLocation();
    return;
  }

  loading(true);
  fbOnce('users').then(function(users) {
    var arr = toArray(users);
    var exists = arr.some(function(u) { return u.username === name; });
    if (exists) {
      loading(false);
      showMsg('teamFormMsgAdmin', 'error', 'Nome de usuário já existe');
      return;
    }
    var supUser = supId ? arr.find(function(u) { return u.id === supId; }) : null;
    var perdasGoals = readPerdasGoals('new', sector);
    var userData = {
      username: name, password: pass, role: 'equipe',
      supervisor_id: supUser ? supId : '',
      supervisor: supUser ? supUser.username : '',
      process: process || '',
      sector: sector,
      goal_money: goalMoney,
      shift_start: shiftStart || '',
      shift_end: shiftEnd || '',
      days_of_week: daysOfWeek,
      latitude: String(adminLocation.lat),
      longitude: String(adminLocation.lng),
      address: adminAddress || '',
      last_seen: nowTimestamp(),
      created_at: nowTimestamp(),
      registered_by: currentUser ? currentUser.id : '',
      registered_at: nowTimestamp()
    };
    Object.keys(perdasGoals).forEach(function(k) { userData[k] = perdasGoals[k]; });
    return fbPush('users', userData).then(function(key) {
      var linkChain = supUser
        ? linkTeamToSupervisor(supId, key, true)
        : Promise.resolve();
      return linkChain.then(function() { return key; });
    }).then(function(key) {
      loading(false);
      $('newTeamName').value = '';
      $('newTeamPass').value = '';
      $('newTeamSupervisor').value = '';
      $('newTeamSector').value = '';
      ['newTeamGoalFisc', 'newTeamGoalNorm', 'newTeamGoalFraude'].forEach(function(id) { $(id).value = ''; });
      onTeamSectorFormChange('new');
      $('newTeamProcess').value = '';
      $('newTeamGoal').value = '';
      $('newTeamShiftStart').value = '';
      $('newTeamShiftEnd').value = '';
      var dayCheckboxes = document.querySelectorAll('#newTeamDays input[name="teamDay"]');
      for (var d = 0; d < dayCheckboxes.length; d++) { dayCheckboxes[d].checked = false; }
      toast('Equipe criada com sucesso!', 'success');
      loadAllAdminData();
      adminLocation = null;
      adminAddress = '';
      var locText = $('locationText');
      var locIcon = $('locationIcon');
      if (locIcon) locIcon.textContent = 'my_location';
      if (locText) locText.textContent = 'Pronto para capturar localização da próxima equipe';
      captureAdminLocation();
    });
  }).catch(function(err) {
    loading(false);
    showMsg('teamFormMsgAdmin', 'error', 'Erro: ' + err.message);
  });
}

function deleteTeam(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir esta equipe?')) return;
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    var supId = user && user.supervisor_id;
    var unlink = supId ? linkTeamToSupervisor(supId, id, false) : Promise.resolve();
    return unlink.then(function() {
      return fbRemove('users/' + id);
    });
  }).then(function() {
    loading(false);
    toast('Equipe excluída', 'info');
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function showResetPass(id) {
  if (!ensureAdmin()) return;
  var newPass = prompt('Nova senha para a equipe:');
  if (!newPass || newPass.length < 3) return;
  loading(true);
  fbUpdate('users/' + id, { password: newPass }).then(function() {
    loading(false);
    toast('Senha redefinida!', 'success');
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function editTeam(id) {
  loading(true);
  fbOnce('users/' + id).then(function(user) {
    loading(false);
    if (!user) { toast('Equipe não encontrada', 'error'); return; }
    $('editTeamId').value = id;
    $('editTeamName').value = user.username || '';
    var supId = user.supervisor_id || '';
    populateSupervisorSelect('editTeamSupervisor', supId);
    var supSel = $('editTeamSupervisor');
    // Se o supervisor vinculado não estiver na lista carregada, mantém-no como opção
    if (supId && supSel.value !== supId) {
      var opt = document.createElement('option');
      opt.value = supId;
      opt.textContent = user.supervisor || supId;
      supSel.appendChild(opt);
      supSel.value = supId;
    }
    populateProcessSelect('editTeamProcess', user.process || '');
    $('editTeamSector').value = sectorOf(user);
    $('editTeamGoalFisc').value = user.goal_fiscalizacao || '';
    $('editTeamGoalNorm').value = user.goal_normalizacao || '';
    $('editTeamGoalFraude').value = user.goal_fraude || '';
    onTeamSectorFormChange('edit');
    $('editTeamGoal').value = user.goal_money > 0 ? user.goal_money : '';
    $('editTeamShiftStart').value = user.shift_start || '';
    $('editTeamShiftEnd').value = user.shift_end || '';
    setSelectedDaysOfWeek(user.days_of_week || []);
    $('editTeamPass').value = '';
    clearMsg('editTeamMsg');
    $('editTeamModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditTeam() {
  if (!ensureAdmin()) return;
  var id = $('editTeamId').value;
  var name = $('editTeamName').value.trim();
  var supId = $('editTeamSupervisor').value;
  var process = $('editTeamProcess').value;
  var sector = $('editTeamSector').value === 'PERDAS' ? 'PERDAS' : 'STC';
  var goalRaw = $('editTeamGoal').value;
  var goalMoney = sector === 'PERDAS' ? 0 : (parseFloat(goalRaw) || 0);
  var perdasGoals = readPerdasGoals('edit', sector);
  var shiftStart = $('editTeamShiftStart').value;
  var shiftEnd = $('editTeamShiftEnd').value;
  var newPass = $('editTeamPass').value.trim();
  var editCheckboxes = document.querySelectorAll('#editTeamDays input[name="editTeamDay"]');
  var editDays = [];
  for (var i = 0; i < editCheckboxes.length; i++) {
    if (editCheckboxes[i].checked) editDays.push(parseInt(editCheckboxes[i].value));
  }

  if (!name) { showMsg('editTeamMsg', 'error', 'O nome da equipe é obrigatório'); return; }
  clearMsg('editTeamMsg');

  loading(true);
  fbOnce('users/' + id).then(function(team) {
    var oldSupId = team && team.supervisor_id;
    var supUser = null;
    var ops = [];
    if (supId) {
      return fbOnce('users/' + supId).then(function(sup) {
        supUser = sup;
        var updateData = {
          username: name,
          supervisor_id: supUser ? supId : '',
          supervisor: supUser ? supUser.username || '' : '',
          process: process || '',
          sector: sector,
          goal_money: goalMoney,
          goal_fiscalizacao: perdasGoals.goal_fiscalizacao,
          goal_normalizacao: perdasGoals.goal_normalizacao,
          goal_fraude: perdasGoals.goal_fraude,
          shift_start: shiftStart || '',
          shift_end: shiftEnd || '',
          days_of_week: editDays
        };
        if (newPass && newPass.length >= 3) updateData.password = newPass;
        ops.push(fbUpdate('users/' + id, updateData));
        if (supUser && supUser.role === 'supervisor') ops.push(linkTeamToSupervisor(supId, id, true));
        if (oldSupId && oldSupId !== supId) ops.push(linkTeamToSupervisor(oldSupId, id, false));
        return Promise.all(ops);
      });
    }
    var updateData = {
      username: name,
      supervisor_id: '',
      supervisor: '',
      process: process || '',
      sector: sector,
      goal_money: goalMoney,
      goal_fiscalizacao: perdasGoals.goal_fiscalizacao,
      goal_normalizacao: perdasGoals.goal_normalizacao,
      goal_fraude: perdasGoals.goal_fraude,
      shift_start: shiftStart || '',
      shift_end: shiftEnd || '',
      days_of_week: editDays
    };
    if (newPass && newPass.length >= 3) updateData.password = newPass;
    ops.push(fbUpdate('users/' + id, updateData));
    if (oldSupId) ops.push(linkTeamToSupervisor(oldSupId, id, false));
    return Promise.all(ops);
  }).then(function() {
    loading(false);
    toast('Equipe atualizada com sucesso!', 'success');
    closeEditTeamModal();
    loadAllAdminData();
  }).catch(function(err) {
    loading(false);
    showMsg('editTeamMsg', 'error', 'Erro: ' + err.message);
  });
}

function closeEditTeamModal() {
  $('editTeamModal').style.display = 'none';
}

// --- Catálogo de Serviços ---
function loadCatalogList() {
  fbCached('catalog_services', 60000).then(function(services) {
    renderCatalogList(toArray(services));
  });
}

function renderCatalogList(allServices) {
  var container = $('catalogList');
  if (!allServices || allServices.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">build</span><p>Nenhum serviço cadastrado</p></div>';
    return;
  }
  var q = valOf('ctSearch').trim().toLowerCase();
  var fActive = valOf('ctActive');
  var fSector = valOf('ctSector');
  markActiveFilters(['ctActive', 'ctSector'], '');
  var services = allServices.filter(function(s) {
    if (q && String(s.name || '').toLowerCase().indexOf(q) === -1) return false;
    if (fActive === 'active' && !s.active) return false;
    if (fActive === 'inactive' && s.active) return false;
    if (fSector && sectorOf(s) !== fSector) return false;
    return true;
  }).sort(function(a, b) { return String(a.name).localeCompare(String(b.name), 'pt-BR'); });
  var html = '<div class="result-info">Mostrando <strong>' + services.length + '</strong> de ' + allServices.length + ' serviços</div>';
  if (!services.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhum serviço encontrado</p></div>';
    return;
  }
  var canEdit = !isSupervisor();
  var numInput = function(id, value, step) {
    return '<input type="number" id="' + id + '" value="' + (value === undefined || value === null ? '' : value) + '" min="0" step="' + step + '" inputmode="decimal">';
  };
  html += '<div class="service-card-grid">';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    var sector = sectorOf(s);
    var isPerdas = sector === 'PERDAS';
    var activeTag = s.active
      ? '<span class="tag tag-active">Ativo</span>'
      : '<span class="tag tag-inactive">Inativo</span>';
    var editId = 'catalogEdit_' + s.id;
    var detail = isPerdas
      ? 'UPS por unidade · ' + perdasUpsSummary(s) + ' ' + categoryTags(serviceCategories(s))
      : fmtUps(s.ups_value) + ' UPS / un · ' + fmtMoney(s.money_value) + ' / un';
    html += '<div class="service-card-item" id="' + editId + '_card">' +
      '<div class="sc-icon"><span class="material-symbols-outlined">' + (isPerdas ? 'electric_meter' : 'build') + '</span></div>' +
      '<div class="sc-body">' +
      '<div class="sc-name">' + escapeHtml(s.name) + ' ' + sectorTag(sector) + ' ' + activeTag + '</div>' +
      '<div class="sc-detail">' + detail + '</div>' +
      '</div>' +
      (canEdit ? '<div class="sc-actions">' +
      '<button class="btn btn-sm btn-outline" onclick="toggleEditCatalog(\'' + s.id + '\')" title="Editar"><span class="material-symbols-outlined">edit</span></button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteCatalogService(\'' + s.id + '\')" title="Excluir"><span class="material-symbols-outlined">delete</span></button>' +
      '</div>' : '') + '</div>';
    if (!canEdit) continue;
    html += '<div class="card" id="' + editId + '" style="display:none;margin-top:-6px;">' +
      '<div class="form-row">' +
      '<div class="form-group"><label>Nome</label><input type="text" id="' + editId + '_name" value="' + escapeHtml(s.name) + '"></div>' +
      '<div class="form-group"><label>Setor</label><select id="' + editId + '_sector" onchange="onCatalogSectorChange(\'' + editId + '\')">' +
      '<option value="STC"' + (isPerdas ? '' : ' selected') + '>STC</option><option value="PERDAS"' + (isPerdas ? ' selected' : '') + '>PERDAS</option></select></div>' +
      '</div>' +
      '<div class="form-row" id="' + editId + '_stc"' + (isPerdas ? ' style="display:none;"' : '') + '>' +
      '<div class="form-group"><label>UPS/un</label>' + numInput(editId + '_ups', s.ups_value, '0.1') + '</div>' +
      '<div class="form-group"><label>R$/un</label>' + numInput(editId + '_money', s.money_value, '0.01') + '</div>' +
      '</div>' +
      '<div class="form-row" id="' + editId + '_perdas" style="flex-wrap:wrap;' + (isPerdas ? '' : 'display:none;') + '">' +
      '<div class="form-group"><label>UPS MONO</label>' + numInput(editId + '_mono', s.ups_mono, '0.1') + '</div>' +
      '<div class="form-group"><label>UPS BI</label>' + numInput(editId + '_bi', s.ups_bi, '0.1') + '</div>' +
      '<div class="form-group"><label>UPS TRI</label>' + numInput(editId + '_tri', s.ups_tri, '0.1') + '</div>' +
      '<div class="form-group" style="flex-basis:100%;"><label>A execução conta como</label>' + categoryCheckboxes(editId, s.categories) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap;">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:500;margin-right:auto;">' +
      '<input type="checkbox" id="' + editId + '_active" ' + (s.active ? 'checked' : '') + '> Ativo</label>' +
      '<button class="btn btn-sm btn-success" onclick="saveCatalogEdit(\'' + s.id + '\')"><span class="material-symbols-outlined">check</span> Salvar</button>' +
      '<button class="btn btn-sm btn-ghost" onclick="toggleEditCatalog(\'' + s.id + '\')">Cancelar</button>' +
      '</div></div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function toggleEditCatalog(id) {
  var editDiv = $('catalogEdit_' + id);
  if (editDiv) editDiv.style.display = editDiv.style.display === 'none' ? 'block' : 'none';
}

// Alterna os campos de valor: STC (UPS + R$) ou PERDAS (UPS MONO/BI/TRI)
function onCatalogSectorChange(prefix) {
  var isPerdas = valOf(prefix + '_sector') === 'PERDAS';
  if ($(prefix + '_stc')) $(prefix + '_stc').style.display = isPerdas ? 'none' : '';
  if ($(prefix + '_perdas')) $(prefix + '_perdas').style.display = isPerdas ? '' : 'none';
}

// Lê e valida os valores do formulário conforme o setor; retorna { data } ou { error }
function readCatalogValues(prefix, ids) {
  var sector = valOf(ids.sector);
  if (SECTORS.indexOf(sector) === -1) return { error: 'Selecione o setor do serviço (STC ou PERDAS)' };
  if (sector === 'PERDAS') {
    var mono = parseFloat(valOf(ids.mono));
    var bi = parseFloat(valOf(ids.bi));
    var tri = parseFloat(valOf(ids.tri));
    if ([mono, bi, tri].some(function(v) { return isNaN(v) || v < 0; })) {
      return { error: 'Informe os valores de UPS para MONO, BI e TRI' };
    }
    var categories = {};
    var any = false;
    PERDAS_CATS.forEach(function(c) {
      var el = $(prefix + '_cat_' + c.key);
      categories[c.key] = !!(el && el.checked);
      if (categories[c.key]) any = true;
    });
    if (!any) return { error: 'Marque se a execução é FISCALIZAÇÃO, NORMALIZAÇÃO e/ou FRAUDE' };
    return { data: { sector: 'PERDAS', ups_mono: mono, ups_bi: bi, ups_tri: tri, ups_value: mono, money_value: 0, categories: categories } };
  }
  var ups = parseFloat(valOf(ids.ups));
  var money = parseFloat(valOf(ids.money));
  if (isNaN(ups) || ups < 0) return { error: 'Valor UPS inválido' };
  if (isNaN(money) || money < 0) return { error: 'Valor em dinheiro inválido' };
  return { data: { sector: 'STC', ups_value: ups, money_value: money, ups_mono: null, ups_bi: null, ups_tri: null, categories: null } };
}

function createCatalogService() {
  if (!ensureAdmin()) return;
  var name = $('catalogName').value.trim();
  if (!name) { showMsg('catalogFormMsg', 'error', 'Informe o nome do serviço'); return; }
  var res = readCatalogValues('catalog', {
    sector: 'catalog_sector', ups: 'catalogUps', money: 'catalogMoney',
    mono: 'catalogUpsMono', bi: 'catalogUpsBi', tri: 'catalogUpsTri'
  });
  if (res.error) { showMsg('catalogFormMsg', 'error', res.error); return; }
  clearMsg('catalogFormMsg');
  loading(true);
  var data = res.data;
  data.name = name;
  data.active = true;
  data.created_at = nowTimestamp();
  // Campos nulos não precisam ser gravados no cadastro novo
  Object.keys(data).forEach(function(k) { if (data[k] === null) delete data[k]; });
  fbPush('catalog_services', data).then(function() {
    loading(false);
    ['catalogName', 'catalogUps', 'catalogMoney', 'catalogUpsMono', 'catalogUpsBi', 'catalogUpsTri'].forEach(function(id) { $(id).value = ''; });
    PERDAS_CATS.forEach(function(c) { var el = $('catalog_cat_' + c.key); if (el) el.checked = false; });
    toast('Serviço cadastrado!', 'success');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    showMsg('catalogFormMsg', 'error', 'Erro: ' + err.message);
  });
}

function saveCatalogEdit(id) {
  if (!ensureAdmin()) return;
  var editId = 'catalogEdit_' + id;
  var name = $(editId + '_name').value.trim();
  var active = $(editId + '_active').checked;
  if (!name) { toast('Nome obrigatório', 'error'); return; }
  var res = readCatalogValues(editId, {
    sector: editId + '_sector', ups: editId + '_ups', money: editId + '_money',
    mono: editId + '_mono', bi: editId + '_bi', tri: editId + '_tri'
  });
  if (res.error) { toast(res.error, 'error'); return; }
  var data = res.data;
  data.name = name;
  data.active = active;
  loading(true);
  fbUpdate('catalog_services/' + id, data).then(function() {
    loading(false);
    toast('Serviço atualizado!', 'success');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}


function deleteCatalogService(id) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este serviço do catálogo?')) return;
  loading(true);
  fbRemove('catalog_services/' + id).then(function() {
    loading(false);
    toast('Serviço excluído', 'info');
    loadCatalogList();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function exportData() {
  var start = clampDateToAllowed($('adminStartDate').value);
  var end = clampDateToAllowed($('adminEndDate').value);
  $('adminStartDate').value = start;
  $('adminEndDate').value = end;
  if (!start || !end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  fbCached('users', CACHE_TTL).then(function(users) {
    var teams = toArray(users).filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
    return buildCsvReport(teams, start, end);
  }).then(function(filtered) {
    loading(false);
    if (!filtered || filtered.length === 0) { toast('Nenhum dado para exportar no período', 'info'); return; }
    downloadCsv(filtered, 'exportacao_ups_' + start + '_to_' + end + '.csv');
  }).catch(function(err) {
    loading(false);
    toast('Erro ao exportar: ' + err.message, 'error');
  });
}

// --- Apontamento de Turno ---
function defaultPeriodForInputs(startId, endId) {
  var range = getAllowedDateRange();
  if (range) {
    $(startId).value = range.end;
    $(endId).value = range.end;
    return;
  }
  var now = new Date();
  $(startId).value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
  $(endId).value = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

var apontamentoItems = null;

function initApontamento() {
  if (!$('apontamentoStartDate').value) {
    defaultPeriodForInputs('apontamentoStartDate', 'apontamentoEndDate');
  }
  markPresets('apontamento');
  if (apontamentoItems === null) loadApontamentos();
}

function setApontamentoCurrentMonth() {
  defaultPeriodForInputs('apontamentoStartDate', 'apontamentoEndDate');
  loadApontamentos();
}

function loadApontamentos() {
  var start = clampDateToAllowed($('apontamentoStartDate').value);
  var end = clampDateToAllowed($('apontamentoEndDate').value);
  $('apontamentoStartDate').value = start;
  $('apontamentoEndDate').value = end;
  markPresets('apontamento');
  if (!start || !end) { toast('Selecione o período', 'error'); return; }
  loading(true);
  Promise.all([fbOnce('services'), fbOnce('users'), fbOnce('shift_notes')]).then(function(results) {
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var teams = users.filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
    var existingNotes = toArray(results[2]);
    var notesMap = {};
    existingNotes.forEach(function(n) { notesMap[n.team_id + '_' + n.date] = n; });
    var servicesByTeamDate = {};
    allServices.forEach(function(s) {
      var key = s.user_id + '_' + s.date;
      if (!servicesByTeamDate[key]) servicesByTeamDate[key] = [];
      servicesByTeamDate[key].push(s);
    });
    var missing = [];
    var dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    var currentDate = new Date(start + 'T00:00:00');
    var endDate = new Date(end + 'T00:00:00');
    while (currentDate <= endDate) {
      var dateStr = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0') + '-' + String(currentDate.getDate()).padStart(2, '0');
      var dayOfWeek = currentDate.getDay();
      for (var i = 0; i < teams.length; i++) {
        var t = teams[i];
        var isScheduled = t.days_of_week && t.days_of_week.indexOf(dayOfWeek) !== -1;
        if (!isScheduled) continue;
        var key = t.id + '_' + dateStr;
        var dayServices = servicesByTeamDate[key] || [];
        if (dayServices.length === 0) {
          var noteKey = t.id + '_' + dateStr;
          var existing = notesMap[noteKey];
          missing.push({
            team_id: t.id,
            team_name: t.username,
            date: dateStr,
            day_name: dayNames[dayOfWeek],
            note_id: existing ? existing.id : null,
            reason: existing ? existing.reason : ''
          });
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
    loading(false);
    renderApontamentos(missing);
  }).catch(function(err) {
    loading(false);
    toast('Erro ao carregar apontamentos: ' + err.message, 'error');
  });
}

function renderApontamentos(items) {
  apontamentoItems = items || [];
  renderApontamentosFiltered();
}

function renderApontamentosFiltered() {
  var container = $('apontamentoContent');
  var items = apontamentoItems || [];
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">check_circle</span><p>Nenhuma equipe faltou no período selecionado</p></div>';
    return;
  }
  var q = valOf('apfSearch').trim().toLowerCase();
  var fReason = valOf('apfReason');
  var list = items.filter(function(it) {
    if (q && String(it.team_name || '').toLowerCase().indexOf(q) === -1) return false;
    if (fReason === 'pending' && it.reason) return false;
    if (fReason === 'done' && !it.reason) return false;
    return true;
  });
  var pending = items.filter(function(it) { return !it.reason; }).length;
  var html = '<div class="stats-overview">' +
    kpi('services', 'event_busy', items.length, 'Ausências previstas') +
    kpi('grade', 'pending_actions', pending, 'Sem motivo') +
    kpi('online', 'task_alt', items.length - pending, 'Justificadas') +
    '</div>';
  html += '<div class="result-info">Mostrando <strong>' + list.length + '</strong> de ' + items.length + ' registros</div>';
  if (!list.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhum registro corresponde aos filtros</p></div>';
    return;
  }
  var isSup = isSupervisor();
  html += '<div class="table-wrap"><table><thead><tr><th>Equipe</th><th>Data</th><th>Motivo</th>' + (isSup ? '' : '<th></th>') + '</tr></thead><tbody>';
  list.forEach(function(it) {
    var inputId = 'apontamento_' + it.team_id + '_' + it.date.replace(/-/g, '');
    html += '<tr>' +
      '<td><strong>' + escapeHtml(it.team_name) + '</strong></td>' +
      '<td style="white-space:nowrap;">' + formatDateBr(it.date) + ' <span style="color:var(--text-muted);font-size:11.5px;">' + it.day_name + '</span></td>' +
      '<td style="min-width:220px;">' + (isSup
        ? (it.reason ? escapeHtml(it.reason) : '<span class="tag tag-warning">Sem motivo</span>')
        : '<input type="text" id="' + inputId + '" placeholder="Motivo da ausência..." value="' + escapeHtml(it.reason) + '" onkeydown="if(event.key===\'Enter\')saveApontamento(\'' + it.team_id + '\',\'' + it.date + '\',\'' + inputId + '\')">') + '</td>' +
      (isSup ? '' : '<td><button class="btn btn-sm btn-primary" onclick="saveApontamento(\'' + it.team_id + '\',\'' + it.date + '\',\'' + inputId + '\')"><span class="material-symbols-outlined">save</span><span class="btn-label">Salvar</span></button></td>') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function saveApontamento(teamId, date, inputId) {
  if (!ensureAdmin()) return;
  var reason = $(inputId).value.trim();
  if (!reason) { toast('Informe o motivo', 'error'); return; }
  (apontamentoItems || []).forEach(function(it) { if (it.team_id === teamId && it.date === date) it.reason = reason; });
  loading(true);
  var noteKey = teamId + '_' + date;
  var noteData = {
    team_id: teamId,
    date: date,
    reason: reason,
    created_by: currentUser ? currentUser.id : '',
    created_at: nowTimestamp()
  };
  fbOnce('shift_notes').then(function(existing) {
    var notes = toArray(existing);
    var found = notes.find(function(n) { return n.team_id === teamId && n.date === date; });
    if (found) {
      return fbUpdate('shift_notes/' + found.id, noteData).then(function() {
        loading(false);
        toast('Apontamento salvo!', 'success');
      });
    } else {
      return fbPush('shift_notes', noteData).then(function() {
        loading(false);
        toast('Apontamento salvo!', 'success');
      });
    }
  }).catch(function(err) {
    loading(false);
    toast('Erro ao salvar: ' + err.message, 'error');
  });
}

// --- Regras ---
function addRule() {
  if (!ensureAdmin()) return;
  var container = $('rulesContainer');
  var id = 'new_' + Date.now();
  var html = '<div class="rule-card" data-rule-id="' + id + '">' +
    '<div class="badge badge-sm" style="background:#94a3b8;">?</div>' +
    '<div class="fields">' +
    '<div class="form-group"><label>Classe</label><input type="text" class="rule-class" value="Nova Classe"></div>' +
    '<div class="form-group"><label>Mínimo</label><input type="number" class="rule-min" value="0"></div>' +
    '<div class="form-group"><label>Máximo</label><input type="number" class="rule-max" value="100"></div>' +
    '<div class="form-group"><label>Cor</label><input type="color" class="rule-color" value="#94a3b8"></div>' +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()"><span class="material-symbols-outlined">delete</span></button>' +
    '</div>';
  if (container.querySelector('.empty-state')) { container.innerHTML = ''; }
  container.insertAdjacentHTML('beforeend', html);
}

function loadRules() {
  fbOnce('rules').then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
    renderRules(rulesCache);
  });
}

function renderRules(rules) {
  var container = $('rulesContainer');
  if (!rules || rules.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">tune</span><p>Nenhuma regra configurada</p></div>';
    return;
  }
  var html = '<div class="rules-grid">';
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    html += '<div class="rule-card" data-rule-id="' + r.id + '">' +
      '<div class="badge badge-sm" style="background:' + r.color + ';">' + r.class + '</div>' +
      '<div class="fields">' +
      '<div class="form-group"><label>Classe</label><input type="text" class="rule-class" value="' + escapeHtml(r.class) + '"></div>' +
      '<div class="form-group"><label>Mínimo</label><input type="number" class="rule-min" value="' + r.minUps + '"></div>' +
      '<div class="form-group"><label>Máximo</label><input type="number" class="rule-max" value="' + r.maxUps + '"></div>' +
      '<div class="form-group"><label>Cor</label><input type="color" class="rule-color" value="' + r.color + '"></div>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" onclick="this.parentElement.remove()"><span class="material-symbols-outlined">delete</span></button>' +
      '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function saveRules() {
  if (!ensureAdmin()) return;
  var cards = document.querySelectorAll('.rule-card');
  var rules = [];
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    rules.push({
      class: card.querySelector('.rule-class').value,
      min_ups: parseInt(card.querySelector('.rule-min').value),
      max_ups: parseInt(card.querySelector('.rule-max').value),
      color: card.querySelector('.rule-color').value
    });
  }
  loading(true);
  fbRemove('rules').then(function() {
    var promises = rules.map(function(r) { return fbPush('rules', r); });
    return Promise.all(promises);
  }).then(function() {
    loading(false);
    toast('Regras salvas!', 'success');
    loadRules();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

// --- Mapa ---
function loadMapData(start, end) {
  start = start || valOf('adminStartDate') || todayStr();
  end = end || valOf('adminEndDate') || todayStr();
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    mapData = data || [];
    fillSelect('mapfSupervisor', supervisorOptions(mapData), 'Todos supervisores');
    fillSelect('mapfClass', classOptions(), 'Todas classes');
    renderMapFiltered();
  }).catch(function(err) {
    console.error('Erro ao carregar mapa:', err);
  });
}

var mapData = [];

function renderMapFiltered() {
  markActiveFilters(['mapfSupervisor', 'mapfClass', 'mapfStatus'], '');
  var list = applyTeamFilters(mapData, {
    supervisor: valOf('mapfSupervisor'), cls: valOf('mapfClass'), status: valOf('mapfStatus')
  });
  var legend = $('mapLegend');
  if (legend) {
    var counts = {};
    list.forEach(function(t) { counts[t.class] = (counts[t.class] || 0) + 1; });
    legend.innerHTML = '<span class="result-info" style="margin:0;"><strong>' + list.length + '</strong>&nbsp;de ' + mapData.length + ' equipes</span>' +
      (rulesCache || []).map(function(r) {
        return '<span class="chip" style="cursor:default;"><span class="chip-dot" style="background:' + r.color + ';"></span>' + escapeHtml(r.class) + ' <span class="chip-count">' + (counts[r.class] || 0) + '</span></span>';
      }).join('');
  }
  updateMap(list);
}

var OWM_API_KEY ='cb9a3186df512370a0b85db130ca34d1';

function initMap() {
  var container = $('map');
  if (!container) { console.error('Container do mapa nao encontrado'); return; }
  if (container._leaflet_id) { console.log('Mapa ja inicializado'); return; }
  try {
    map = L.map('map', { center: [-15.7939, -47.8828], zoom: 5, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd', maxZoom: 20
    }).addTo(map);
    var terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17
    });
    var weatherLayer = L.tileLayer('https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=' + OWM_API_KEY, {
      attribution: '&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>', opacity: 0.6, maxZoom: 18
    });
    L.control.layers(null, { 'Terreno': terrainLayer, 'Temperatura': weatherLayer }, { collapsed: true }).addTo(map);
    loadMapData();
  } catch (e) {
    console.error('Erro ao inicializar mapa:', e);
    toast('Erro ao carregar mapa: ' + e.message, 'error');
  }
}

function updateMap(data) {
  if (!map) return;
  for (var i = 0; i < mapMarkers.length; i++) map.removeLayer(mapMarkers[i]);
  mapMarkers = [];
  if (!data || data.length === 0) return;
  var bounds = [];
  for (var i = 0; i < data.length; i++) {
    var team = data[i];
    var lat = parseFloat(team.latitude);
    var lng = parseFloat(team.longitude);
    if (isNaN(lat) || isNaN(lng)) {
      var angle = (i / data.length) * 2 * Math.PI;
      var radius = 0.08;
      lat = -15.7939 + radius * Math.cos(angle);
      lng = -47.8828 + radius * Math.sin(angle);
    }
    var color = team.color || '#94a3b8';
    var icon = L.divIcon({
      className: 'custom-marker',
      html: '<div style="background:' + color + ';width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);">' + team.class + '</div>',
      iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -22]
    });
    var radiusPixels = Math.max(20, Math.min(60, 20 + team.totalUps * 0.5));
    var circle = L.circleMarker([lat, lng], {
      radius: radiusPixels,
      fillColor: color,
      color: '#fff',
      weight: 2,
      opacity: 0.8,
      fillOpacity: 0.15
    }).addTo(map);
    mapMarkers.push(circle);

    var statusInfo = getStatusInfo(team.lastSeen);
    var statusDot = statusInfo.status === 'online' ? '🟢' : '🔴';
    var locLabel = '';
    if (team.address) {
      locLabel = escapeHtml(team.address.split(',')[0]);
    } else {
      locLabel = lat.toFixed(4) + ', ' + lng.toFixed(4);
    }
    var popupHtml = '<div class="custom-popup">' +
      '<div style="text-align:center;font-weight:700;font-size:16px;margin-bottom:6px;">' + escapeHtml(team.username) + '</div>' +
      '<div class="popup-header" style="justify-content:center;">' +
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:' + color + ';color:#fff;font-weight:800;font-size:14px;">' + team.class + '</span>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-align:center;">' + statusDot + ' ' + statusInfo.label + ' | <span class="coord-text">' + locLabel + '</span></div>';
    if (team.services && team.services.length > 0) {
      popupHtml += '<div class="popup-services"><table><tr><th>Serviço</th><th>UPS</th><th>R$</th></tr>';
      for (var j = 0; j < team.services.length; j++) {
        var sv = team.services[j];
        popupHtml += '<tr><td>' + escapeHtml(sv.serviceName) + (sv.quantity > 1 ? ' (' + sv.quantity + 'x)' : '') + '</td>' +
          '<td style="font-weight:600;">' + fmtUps(sv.upsValue) + '</td>' +
          '<td style="font-weight:600;color:var(--money);">' + (sv.totalMoney ? fmtMoney(sv.totalMoney) : '-') + '</td></tr>';
      }
      popupHtml += '</table></div>' +
        '<div class="popup-total" style="background:' + color + ';color:#fff;">Total: ' + fmtUps(team.totalUps) + ' UPS ' +
        (team.totalMoney ? '| ' + fmtMoney(team.totalMoney) : '') + '</div>';
    } else {
      popupHtml += '<div style="text-align:center;color:#94a3b8;padding:12px 0;font-size:13px;">Nenhum serviço no período</div>' +
        '<div class="popup-total" style="background:' + color + ';color:#fff;">Total: 0 UPS</div>';
    }
    popupHtml += '</div>';
    var marker = L.marker([lat, lng], { icon: icon }).addTo(map).bindPopup(popupHtml, { maxWidth: 320, className: 'custom-popup' });
    marker.on('mouseover', function() { this.openPopup(); });
    marker.on('mouseout', function() { this.closePopup(); });
    mapMarkers.push(marker);
    bounds.push([lat, lng]);
    if (!team.address) {
      (function(marker, lat, lng) {
        reverseGeocode(lat, lng, function(addr) {
          if (marker.getPopup()) {
            var content = marker.getPopup().getContent();
            var coordSpan = content.match(/<span class="coord-text">[^<]+<\/span>/);
            if (coordSpan) {
              content = content.replace(coordSpan[0], '<span class="coord-text">' + addr.split(',')[0] + '</span>');
              marker.setPopupContent(content);
            }
          }
        });
      })(marker, lat, lng);
    }
  }
  if (bounds.length > 0) { map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 }); }
  for (var i = 0; i < data.length; i++) {
    var t = data[i];
    if (t.class === 'A' && !celebratedTeams.has(t.userId)) {
      celebratedTeams.add(t.userId);
      showCelebration(t);
    }
  }
}

function openTeamModal(userId) {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  loading(true);
  Promise.all([getTeamSummary(userId, start, end), fbOnce('users')]).then(function(results) {
    var summary = results[0];
    var users = toArray(results[1]);
    var user = users.find(function(u) { return u.id === userId; });
    loading(false);
    if (!summary) { toast('Erro ao buscar dados da equipe', 'error'); return; }
    var color = summary.color || '#94a3b8';
    var heroBadge = $('modalHeroBadge');
    heroBadge.textContent = summary.class;
    heroBadge.style.background = color;
    $('modalTeamName').textContent = user ? user.username : 'Desconhecido';
    var addrEl = $('modalAddressText');
    if (user && user.address) {
      addrEl.textContent = user.address;
    } else if (user && user.latitude) {
      addrEl.textContent = parseFloat(user.latitude).toFixed(4) + ', ' + parseFloat(user.longitude).toFixed(4);
    } else {
      addrEl.textContent = '—';
    }
    var supLine = $('modalSupervisorLine');
    if (user && user.supervisor) {
      supLine.style.display = 'block';
      $('modalSupervisorName').textContent = user.supervisor;
    } else {
      supLine.style.display = 'none';
    }
    $('modalTotalUps').textContent = fmtUps(summary.totalUps);
    var isPerdas = summary.sector === 'PERDAS';
    var pc = summary.perdas || {};
    // PERDAS não tem dinheiro: o card mostra Fiscalização / Normalização / Fraude
    $('modalMoneyLabel').textContent = isPerdas ? 'Fisc. / Norm. / Fraude' : 'Total ganho';
    $('modalTotalMoney').textContent = isPerdas
      ? (pc.fiscalizacao || 0) + ' / ' + (pc.normalizacao || 0) + ' / ' + (pc.fraude || 0)
      : fmtMoney(summary.totalMoney || 0);
    $('modalSrvCount').textContent = summary.count;
    var classEl = $('modalClass');
    classEl.textContent = summary.class;
    classEl.style.color = color;
    var goalSection = $('modalGoalSection');
    var perdasGoalsBox = $('modalPerdasGoals');
    var perdasHtml = isPerdas ? goalProgressHtml(summary) : '';
    perdasGoalsBox.style.display = perdasHtml ? 'grid' : 'none';
    perdasGoalsBox.innerHTML = perdasHtml;
    if (isPerdas) {
      goalSection.style.display = 'none';
    } else if (user && user.goal_money > 0) {
      var goalPct = Math.min(100, Math.round((summary.totalMoney / user.goal_money) * 100));
      goalSection.style.display = 'block';
      $('modalGoalValue').textContent = fmtMoney(user.goal_money);
      $('modalGoalPercent').textContent = goalPct + '%';
      $('modalGoalBar').style.width = Math.min(100, (summary.totalMoney / user.goal_money) * 100) + '%';
      $('modalGoalBar').style.background = goalPct >= 100 ? 'var(--success)' : goalPct >= 70 ? 'var(--warning)' : 'var(--money)';
    } else {
      goalSection.style.display = 'none';
    }
    renderTeamDetails(summary.services, isPerdas);
    $('teamModal').style.display = 'flex';
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeTeamModal() { $('teamModal').style.display = 'none'; }

function renderTeamDetails(services, isPerdas) {
  var container = $('modalServiceList');
  if (!services || services.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Nenhum serviço no período</p></div>';
    return;
  }
  services = services.slice().sort(function(a, b) { return a.date === b.date ? String(b.time).localeCompare(String(a.time)) : (a.date > b.date ? -1 : 1); });
  var html = '<div class="table-wrap modal-srv-table"><table><thead><tr><th>Data</th><th>Serviço</th><th class="num">UPS</th>' + (isPerdas ? '' : '<th class="num">R$</th>') + '<th class="num">Nota</th></tr></thead><tbody>';
  for (var i = 0; i < services.length; i++) {
    var s = services[i];
    html += '<tr>' +
      '<td class="date">' + formatDateBr(s.date) + (s.time ? ' ' + s.time.slice(0, 5) : '') + '</td>' +
      '<td class="srv">' + escapeHtml(s.serviceName) + '</td>' +
      '<td class="num ups">' + fmtUps(s.upsValue) + '</td>' +
      (isPerdas ? '' : '<td class="num money">' + fmtMoney(s.totalMoney || 0) + '</td>') +
      '<td class="num">' + (s.grade || '-') + '</td>' +
      '</tr>';
  }
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// --- Supervisores ---
var supervisoresData = [];
var supervisoresOpen = {};

function loadSupervisores() {
  var start = $('adminStartDate').value;
  var end = $('adminEndDate').value;
  getAllTeamsSummaryForPeriod(start, end).then(function(data) {
    renderSupervisores(data);
  }).catch(function(err) {
    console.error('Erro ao carregar supervisores:', err);
  });
}

function renderSupervisores(data) {
  var supervisors = {};
  (data || []).forEach(function(t) {
    var sup = t.supervisor || 'Sem Supervisor';
    if (!supervisors[sup]) {
      supervisors[sup] = { name: sup, teams: [], totalUps: 0, totalMoney: 0, totalGoal: 0, totalServices: 0, active: 0 };
    }
    var s = supervisors[sup];
    s.teams.push(t);
    s.totalUps += t.totalUps;
    s.totalMoney += t.totalMoney;
    s.totalGoal += t.goal_money || 0;
    s.totalServices += t.count;
    if (t.count > 0) s.active++;
  });
  supervisoresData = Object.keys(supervisors).map(function(k) {
    var s = supervisors[k];
    s.avgUps = s.teams.length ? s.totalUps / s.teams.length : 0;
    s.goalPct = s.totalGoal > 0 ? (s.totalMoney / s.totalGoal) * 100 : -1;
    return s;
  });
  renderSupervisoresFiltered();
}

function toggleSupervisor(key, row) {
  supervisoresOpen[key] = !supervisoresOpen[key];
  var el = $('supBody_' + key);
  if (el) el.classList.toggle('open', supervisoresOpen[key]);
  if (row) row.classList.toggle('open', supervisoresOpen[key]);
}

function renderSupervisoresFiltered() {
  var container = $('supervisoresContent');
  if (!container) return;
  if (!supervisoresData.length) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">supervisor_account</span><p>Nenhuma equipe cadastrada</p></div>';
    return;
  }
  var q = valOf('svSearch').trim().toLowerCase();
  var sortKey = valOf('svSort') || 'ups';
  var cmp = {
    ups: function(a, b) { return b.totalUps - a.totalUps; },
    money: function(a, b) { return b.totalMoney - a.totalMoney; },
    avg: function(a, b) { return b.avgUps - a.avgUps; },
    goal: function(a, b) { return b.goalPct - a.goalPct; },
    teams: function(a, b) { return b.teams.length - a.teams.length; },
    name: function(a, b) { return a.name.localeCompare(b.name, 'pt-BR'); }
  }[sortKey];
  var rank = {};
  supervisoresData.slice().sort(function(a, b) { return b.totalUps - a.totalUps; }).forEach(function(s, i) { rank[s.name] = i + 1; });

  var list = supervisoresData.filter(function(s) {
    if (!q) return true;
    if (s.name.toLowerCase().indexOf(q) !== -1) return true;
    return s.teams.some(function(t) { return String(t.username || '').toLowerCase().indexOf(q) !== -1; });
  }).sort(cmp);

  var totalUps = supervisoresData.reduce(function(a, s) { return a + s.totalUps; }, 0);
  var totalMoney = supervisoresData.reduce(function(a, s) { return a + s.totalMoney; }, 0);
  var named = supervisoresData.filter(function(s) { return s.name !== 'Sem Supervisor'; }).length;
  var html = '<div class="stats-overview">' +
    kpi('services', 'supervisor_account', named, 'Supervisores') +
    kpi('ups', 'trending_up', fmtUps(totalUps), 'Total UPS') +
    kpi('money', 'payments', fmtMoney(totalMoney), 'Total R$') +
    (list[0] && sortKey === 'ups' && !q ? kpi('grade', 'emoji_events', escapeHtml(list[0].name), 'Líder em UPS', fmtUps(list[0].totalUps) + ' UPS', true) : '') +
    '</div>';
  html += '<div class="section-label"><span>Desempenho por supervisor · ' + periodLabel(valOf('adminStartDate'), valOf('adminEndDate')) + '</span></div>';
  if (!list.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhum supervisor ou equipe encontrado</p></div>';
    return;
  }
  var maxUps = supervisoresData.reduce(function(m, s) { return Math.max(m, s.totalUps); }, 0);
  list.forEach(function(sup) {
    var key = sup.name.replace(/[^a-zA-Z0-9]/g, '_') + '_' + rank[sup.name];
    var isOpen = !!supervisoresOpen[key] || (!!q && sup.name.toLowerCase().indexOf(q) === -1);
    var barWidth = maxUps > 0 ? (sup.totalUps / maxUps) * 100 : 0;
    html += '<div class="card acc-card">';
    html += '<div class="ranking-item' + (isOpen ? ' open' : '') + '" onclick="toggleSupervisor(\'' + key + '\', this)">' +
      '<div class="ranking-pos">' + medalFor(rank[sup.name]) + '</div>' +
      '<div class="ranking-info">' +
      '<div class="ranking-name" style="font-size:14.5px;">' + escapeHtml(sup.name) + '</div>' +
      '<div class="ranking-tags"><span class="tag tag-neutral">' + sup.teams.length + ' equipe' + (sup.teams.length !== 1 ? 's' : '') + '</span>' +
      '<span class="tag tag-primary">média ' + fmtUps(sup.avgUps) + ' UPS/equipe</span>' +
      '<span class="tag ' + (sup.active === sup.teams.length ? 'tag-active' : 'tag-warning') + '">' + sup.active + ' com produção</span></div>' +
      (sup.totalGoal > 0 ? '<div class="ranking-extra">' + progressHtml('Meta: ' + fmtMoney(sup.totalGoal), sup.goalPct, goalColor(sup.goalPct)) + '</div>' : '') +
      '</div>' +
      '<div class="ranking-stats">' +
      '<div class="ranking-ups">' + fmtUps(sup.totalUps) + ' UPS</div>' +
      '<div class="ranking-money">' + fmtMoney(sup.totalMoney) + '</div>' +
      '<div class="ranking-count">' + sup.totalServices + ' serviço' + (sup.totalServices !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<span class="material-symbols-outlined ranking-chevron">expand_more</span>' +
      '<div class="ranking-bar"><div class="ranking-bar-fill" style="width:' + barWidth + '%;background:var(--primary);"></div></div>' +
      '</div>';

    var teams = sup.teams.slice().sort(function(a, b) { return b.totalUps - a.totalUps; });
    html += '<div class="acc-body' + (isOpen ? ' open' : '') + '" id="supBody_' + key + '">';
    html += '<div class="table-wrap"><table><thead><tr><th>Equipe</th><th>Classe</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Serv.</th><th class="num hide-sm">Meta</th><th>Progresso</th></tr></thead><tbody>';
    teams.forEach(function(t) {
      var gp = teamGoalPct(t);
      var match = q && String(t.username || '').toLowerCase().indexOf(q) !== -1;
      html += '<tr class="clickable" onclick="openTeamModal(\'' + t.userId + '\')"' + (match ? ' style="background:var(--primary-bg);"' : '') + '>' +
        '<td><strong>' + escapeHtml(t.username) + '</strong></td>' +
        '<td><span class="badge badge-xs" style="background:' + (t.color || '#94a3b8') + ';">' + t.class + '</span></td>' +
        '<td class="num ups">' + fmtUps(t.totalUps) + '</td>' +
        '<td class="num money">' + fmtMoney(t.totalMoney) + '</td>' +
        '<td class="num">' + t.count + '</td>' +
        '<td class="num hide-sm">' + (goalLabelOf(t) || '<span style="color:var(--text-muted);">—</span>') + '</td>' +
        '<td style="min-width:120px;">' + (gp >= 0
          ? '<div style="display:flex;align-items:center;gap:6px;"><div class="progress" style="flex:1;"><span style="width:' + Math.min(100, gp) + '%;background:' + goalColor(gp) + ';"></span></div><span style="font-size:11px;font-weight:700;min-width:34px;text-align:right;">' + Math.round(gp) + '%</span></div>'
          : '<span style="color:var(--text-muted);font-size:11px;">Sem meta</span>') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div></div></div>';
  });
  container.innerHTML = html;
}


// --- Auditoria ---
var auditoriaUsersCache = [];

var auditoriaData = null;
var auditoriaLimit = 200;

function initAuditoria() {
  if (!$('auditoriaStartDate').value) {
    defaultPeriodForInputs('auditoriaStartDate', 'auditoriaEndDate');
  }
  markPresets('auditoria');
  if (auditoriaData === null) loadAuditoria();
  fbOnce('users').then(function(users) {
    auditoriaUsersCache = toArray(users).filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
  });
}

function setAuditoriaCurrentMonth() {
  defaultPeriodForInputs('auditoriaStartDate', 'auditoriaEndDate');
  loadAuditoria();
}

function loadAuditoria() {
  var start = clampDateToAllowed($('auditoriaStartDate').value);
  var end = clampDateToAllowed($('auditoriaEndDate').value);
  $('auditoriaStartDate').value = start;
  $('auditoriaEndDate').value = end;
  markPresets('auditoria');
  if (!start || !end) {
    showMsg('auditoriaMsg', 'error', 'Selecione o período');
    return;
  }
  if (start > end) {
    showMsg('auditoriaMsg', 'error', 'Data início deve ser anterior à data fim');
    return;
  }
  clearMsg('auditoriaMsg');
  loading(true);
  Promise.all([fbOnce('services'), fbOnce('users'), fbOnce('catalog_services')]).then(function(results) {
    loading(false);
    var allServices = toArray(results[0]);
    var users = toArray(results[1]);
    var catalog = toArray(results[2]);
    auditoriaUsersCache = users.filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
    var userMap = {};
    users.forEach(function(u) { userMap[u.id] = u.username; });
    var filtered = allServices.filter(function(s) {
      return s.date >= start && s.date <= end && canViewTeam(s.user_id);
    });
    filtered.sort(function(a, b) {
      if (a.date === b.date) return (a.created_at || 0) - (b.created_at || 0);
      return a.date > b.date ? -1 : 1;
    });
    renderAuditoria(filtered, userMap, catalog);
  }).catch(function(err) {
    loading(false);
    showMsg('auditoriaMsg', 'error', 'Erro: ' + err.message);
  });
}

function renderAuditoria(services, userMap) {
  auditoriaData = { services: services || [], userMap: userMap || {} };
  var teamIds = uniqueSorted((services || []).map(function(s) { return s.user_id; }));
  fillSelect('afTeam', teamIds.map(function(id) { return { value: id, label: userMap[id] || 'Desconhecido' }; })
    .sort(function(a, b) { return a.label.localeCompare(b.label, 'pt-BR'); }), 'Todas equipes');
  renderAuditoriaFiltered(true);
}

function showMoreAuditoria() {
  auditoriaLimit += 200;
  renderAuditoriaFiltered(false);
}

function renderAuditoriaFiltered(resetLimit) {
  var container = $('auditoriaContent');
  if (!container || !auditoriaData) return;
  if (resetLimit) auditoriaLimit = 200;
  var all = auditoriaData.services;
  var userMap = auditoriaData.userMap;
  if (!all.length) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">fact_check</span><p>Nenhum lançamento encontrado no período</p></div>';
    return;
  }
  markActiveFilters(['afTeam', 'afType', 'afEdited'], 'afCount');
  var q = valOf('afSearch').trim().toLowerCase();
  var fTeam = valOf('afTeam'), fType = valOf('afType'), fEdited = valOf('afEdited');
  var services = all.filter(function(s) {
    if (fTeam && s.user_id !== fTeam) return false;
    if (fType && s.type !== fType) return false;
    if (fEdited === 'edited' && !s.edited_at) return false;
    if (fEdited === 'original' && s.edited_at) return false;
    if (q) {
      var hay = [(userMap[s.user_id] || ''), s.service_name || '', String(s.grade || ''), s.address || ''].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  var totalUps = services.reduce(function(sum, sv) { return sum + (sv.ups_value || 0); }, 0);
  var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.total_money || 0); }, 0);
  var edited = services.filter(function(s) { return s.edited_at; }).length;
  var html = '<div class="stats-overview">' +
    kpi('services', 'assignment', services.length, 'Lançamentos', services.length !== all.length ? 'de ' + all.length + ' no período' : '') +
    kpi('ups', 'trending_up', fmtUps(totalUps), 'Total UPS') +
    kpi('money', 'payments', fmtMoney(totalMoney), 'Total R$') +
    kpi('grade', 'edit_note', edited, 'Editados') +
    '</div>';
  if (!services.length) {
    container.innerHTML = html + '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhum lançamento corresponde aos filtros</p></div>';
    return;
  }
  var isSup = isSupervisor();
  var shown = services.slice(0, auditoriaLimit);
  html += '<div class="table-wrap"><table><thead><tr>' +
    '<th>Data</th><th>Equipe</th><th>Serviço</th><th class="hide-sm">Tipo</th><th class="num">Qtd</th><th class="num">UPS</th><th class="num">R$</th><th class="num">Nota</th>' + (isSup ? '' : '<th></th>') +
    '</tr></thead><tbody>';
  shown.forEach(function(s) {
    var teamName = userMap[s.user_id] || 'Desconhecido';
    html += '<tr>' +
      '<td style="white-space:nowrap;font-size:12px;">' + formatDateBr(s.date) + (s.time ? '<br><span style="color:var(--text-muted);">' + s.time.slice(0, 5) + '</span>' : '') + '</td>' +
      '<td><strong>' + escapeHtml(teamName) + '</strong></td>' +
      '<td style="font-size:12px;">' + escapeHtml(s.service_name || '') +
      (s.edited_at ? ' <span class="tag tag-warning" title="Editado por ' + escapeHtml(s.edited_by || '') + ' em ' + new Date(s.edited_at).toLocaleString('pt-BR') + '">editado</span>' : '') + '</td>' +
      '<td class="hide-sm" style="font-size:12px;">' + typeLabelOf(s.type) + '</td>' +
      '<td class="num">' + (s.quantity || 1) + '</td>' +
      '<td class="num ups">' + fmtUps(s.ups_value || 0) + '</td>' +
      '<td class="num money">' + fmtMoney(s.total_money || 0) + '</td>' +
      '<td class="num">' + (s.grade > 0 ? s.grade : '-') + '</td>' +
      (isSup ? '' : '<td><div class="actions">' +
      '<button class="btn btn-sm btn-outline" onclick="editAuditoriaService(\'' + s.id + '\')" title="Editar"><span class="material-symbols-outlined">edit</span></button>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteAuditoriaService(\'' + s.id + '\')" title="Excluir"><span class="material-symbols-outlined">delete</span></button>' +
      '</div></td>') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  if (services.length > shown.length) {
    html += '<div class="show-more"><button class="btn btn-outline btn-sm" onclick="showMoreAuditoria()"><span class="material-symbols-outlined">expand_more</span> Mostrar mais (' + shown.length + ' de ' + services.length + ')</button></div>';
  }
  container.innerHTML = html;
}


function editAuditoriaService(serviceId) {
  if (!ensureAdmin()) return;
  loading(true);
  Promise.all([fbOnce('services/' + serviceId), fbOnce('users')]).then(function(results) {
    loading(false);
    var service = results[0];
    if (!service) { toast('Lançamento não encontrado', 'error'); return; }
    var users = toArray(results[1]).filter(isTeamUser);
    $('editServiceId').value = serviceId;
    var userSelect = $('editServiceUserId');
    userSelect.innerHTML = '';
    for (var i = 0; i < users.length; i++) {
      var opt = document.createElement('option');
      opt.value = users[i].id;
      opt.textContent = users[i].username;
      if (users[i].id === service.user_id) opt.selected = true;
      userSelect.appendChild(opt);
    }
    $('editServiceType').value = service.type || 'miscellany';
    $('editServiceGrade').value = service.grade || '';
    $('editServiceQty').value = service.quantity || 1;
    $('editServiceUps').value = service.ups_value || 0;
    $('editServiceMoney').value = service.total_money || 0;
    $('editServiceName').value = service.service_name || '';
    var now = new Date();
    $('editServiceDate').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    $('editServiceTime').value = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    $('editServiceLocationText').textContent = 'Capturando localização...';
    clearMsg('editServiceMsg');
    $('editServiceModal').style.display = 'flex';
    window._editServiceLat = '';
    window._editServiceLng = '';
    window._editServiceCity = '';
    window._editServiceAddress = '';
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        window._editServiceLat = pos.coords.latitude;
        window._editServiceLng = pos.coords.longitude;
        reverseGeocode(pos.coords.latitude, pos.coords.longitude, function(addr) {
          window._editServiceAddress = addr;
          window._editServiceCity = (addr.split(',')[1] || addr.split(',')[0] || '').trim();
          $('editServiceLocationText').textContent = addr;
        });
      }, function(err) {
        $('editServiceLocationText').textContent = 'Não foi possível obter localização';
      }, { enableHighAccuracy: true, timeout: 10000 });
    }
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function saveEditService() {
  if (!ensureAdmin()) return;
  var id = $('editServiceId').value;
  var userId = $('editServiceUserId').value;
  var type = $('editServiceType').value;
  var grade = parseInt($('editServiceGrade').value) || 0;
  var qty = parseInt($('editServiceQty').value) || 1;
  var ups = parseFloat($('editServiceUps').value) || 0;
  var money = parseFloat($('editServiceMoney').value) || 0;
  var serviceName = $('editServiceName').value.trim();
  var date = $('editServiceDate').value;
  var time = $('editServiceTime').value;

  if (!userId) { showMsg('editServiceMsg', 'error', 'Selecione uma equipe'); return; }
  if (!serviceName) { showMsg('editServiceMsg', 'error', 'Informe o nome do serviço'); return; }

  var upsPerUnit = qty > 0 ? ups / qty : ups;
  var moneyPerUnit = qty > 0 && money > 0 ? money / qty : 0;

  var updateData = {
    user_id: userId,
    type: type,
    grade: grade,
    quantity: qty,
    ups_value: ups,
    total_money: money,
    ups_per_unit: upsPerUnit,
    money_per_unit: moneyPerUnit,
    service_name: serviceName,
    date: date,
    time: time,
    latitude: window._editServiceLat || '',
    longitude: window._editServiceLng || '',
    city: window._editServiceCity || '',
    address: window._editServiceAddress || '',
    edited_by: currentUser ? currentUser.username : '',
    edited_at: nowTimestamp()
  };

  loading(true);
  fbUpdate('services/' + id, updateData).then(function() {
    loading(false);
    toast('Lançamento atualizado com sucesso!', 'success');
    closeEditServiceModal();
    loadAuditoria();
  }).catch(function(err) {
    loading(false);
    showMsg('editServiceMsg', 'error', 'Erro: ' + err.message);
  });
}

function deleteAuditoriaService(serviceId) {
  if (!ensureAdmin()) return;
  if (!confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return;
  loading(true);
  fbRemove('services/' + serviceId).then(function() {
    loading(false);
    toast('Lançamento excluído', 'info');
    loadAuditoria();
  }).catch(function(err) {
    loading(false);
    toast('Erro: ' + err.message, 'error');
  });
}

function closeEditServiceModal() {
  $('editServiceModal').style.display = 'none';
}

// --- Classificação ---
function toggleKanbanCard(id) {
  var card = document.getElementById(id);
  if (card) card.classList.toggle('collapsed');
}

var classificacaoData = null;

function initClassificacao() {
  if (!$('classificacaoStartDate').value) {
    defaultPeriodForInputs('classificacaoStartDate', 'classificacaoEndDate');
  }
  markPresets('classificacao');
  if (classificacaoData === null) loadClassificacao();
}

function setClassificacaoCurrentMonth() {
  defaultPeriodForInputs('classificacaoStartDate', 'classificacaoEndDate');
  loadClassificacao();
}

function loadClassificacao() {
  var start = clampDateToAllowed($('classificacaoStartDate').value);
  var end = clampDateToAllowed($('classificacaoEndDate').value);
  $('classificacaoStartDate').value = start;
  $('classificacaoEndDate').value = end;
  markPresets('classificacao');
  if (!start || !end) {
    showMsg('classificacaoMsg', 'error', 'Selecione o período');
    return;
  }
  if (start > end) {
    showMsg('classificacaoMsg', 'error', 'Data início deve ser anterior à data fim');
    return;
  }
  clearMsg('classificacaoMsg');
  loading(true);
  Promise.all([fbOnce('users'), fbOnce('services'), fbOnce('rules')]).then(function(results) {
    loading(false);
    var users = toArray(results[0]).filter(function(u) { return isTeamUser(u) && canViewTeam(u.id); });
    var allServices = toArray(results[1]);
    rulesCache = toArray(results[2]).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });

    var teamsData = users.map(function(user) {
      var svcs = allServices.filter(function(s) {
        return s.user_id === user.id && s.date >= start && s.date <= end;
      });
      var services = svcs.map(function(s) { return formatService(s); });
      var totalUps = services.reduce(function(sum, sv) { return sum + sv.upsValue; }, 0);
      var totalMoney = services.reduce(function(sum, sv) { return sum + (sv.totalMoney || 0); }, 0);

      var uniqueDays = {};
      for (var i = 0; i < services.length; i++) {
        if (services[i].date) uniqueDays[services[i].date] = true;
      }
      var daysCount = Object.keys(uniqueDays).length;
      var avgUps = daysCount > 0 ? totalUps / daysCount : 0;
      var classInfo = getClassification(avgUps);

      return {
        userId: user.id,
        username: user.username,
        supervisor: user.supervisor || '',
        totalUps: totalUps,
        totalMoney: totalMoney,
        daysCount: daysCount,
        avgUps: avgUps,
        servicesCount: services.length,
        class: classInfo.class,
        color: classInfo.color
      };
    });

    // Supervisor aggregation (média das médias das equipes)
    var supMap = {};
    for (var i = 0; i < teamsData.length; i++) {
      var t = teamsData[i];
      var supName = t.supervisor || 'Sem Supervisor';
      if (!supMap[supName]) {
        supMap[supName] = { name: supName, avgUpsSum: 0, teamsCount: 0, totalUps: 0, totalMoney: 0, servicesCount: 0 };
      }
      supMap[supName].avgUpsSum += t.avgUps;
      supMap[supName].teamsCount += 1;
      supMap[supName].totalUps += t.totalUps;
      supMap[supName].totalMoney += t.totalMoney;
      supMap[supName].servicesCount += t.servicesCount;
    }
    var supData = [];
    var supKeys = Object.keys(supMap);
    for (var k = 0; k < supKeys.length; k++) {
      var sup = supMap[supKeys[k]];
      var supAvgUps = sup.teamsCount > 0 ? sup.avgUpsSum / sup.teamsCount : 0;
      var supClass = getClassification(supAvgUps);
      supData.push({
        name: sup.name,
        totalUps: sup.totalUps,
        totalMoney: sup.totalMoney,
        avgUps: supAvgUps,
        teamsCount: sup.teamsCount,
        servicesCount: sup.servicesCount,
        class: supClass.class,
        color: supClass.color
      });
    }

    renderClassificacao(teamsData, supData, start, end);
  }).catch(function(err) {
    loading(false);
    showMsg('classificacaoMsg', 'error', 'Erro: ' + err.message);
  });
}

function buildKanbanHtml(groups, classOrder, classLabels, classIcons, classColors, isSupervisor) {
  var html = '<div class="kanban-board">';
  for (var c = 0; c < classOrder.length; c++) {
    var clsKey = classOrder[c];
    var colTeams = groups[clsKey] || [];
    var colColor = classColors[clsKey] || '#94a3b8';
    html += '<div class="kanban-column">';
    html += '<div class="kanban-column-header" style="border-color:' + colColor + ';">';
    html += '<span class="col-label" style="color:var(--text);"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;color:' + colColor + ';">' + (classIcons[clsKey] || 'label') + '</span>' + escapeHtml(classLabels[clsKey] || ('Classe ' + clsKey)) + '</span>';
    html += '<span class="col-count">' + colTeams.length + '</span>';
    html += '</div>';
    html += '<div class="kanban-column-body">';
    if (colTeams.length === 0) {
      html += '<div class="kanban-empty"><span class="material-symbols-outlined">inbox</span>Nenhum' + (isSupervisor ? ' supervisor' : 'a equipe') + '</div>';
    } else {
      for (var j = 0; j < colTeams.length; j++) {
        var item = colTeams[j];
        var cardId = (isSupervisor ? 'sup-card-' : 'team-card-') + clsKey + '-' + j;
        html += '<div class="kanban-card collapsed" id="' + cardId + '">';
        html += '<div class="card-header" onclick="toggleKanbanCard(\'' + cardId + '\')">';
        html += '<span class="badge badge-xs" style="background:' + colColor + ';width:8px;height:8px;"></span>';
        html += '<div class="card-name" title="' + escapeHtml(item.username || item.name) + '">' + escapeHtml(item.username || item.name) + '</div>';
        html += '<span class="card-avg">' + fmtUps(item.avgUps) + '</span>';
        html += '<button class="card-toggle" aria-label="Detalhes"><span class="material-symbols-outlined">expand_more</span></button>';
        html += '</div>';
        html += '<div class="card-info">';
        html += '<span><span class="material-symbols-outlined">trending_up</span>Média: <strong>' + fmtUps(item.avgUps) + '</strong> UPS/dia</span>';
        if (isSupervisor) {
          html += '<span><span class="material-symbols-outlined">groups</span>' + item.teamsCount + ' equipe' + (item.teamsCount !== 1 ? 's' : '') + '</span>';
        } else {
          html += '<span><span class="material-symbols-outlined">date_range</span>' + item.daysCount + ' dia' + (item.daysCount !== 1 ? 's' : '') + ' trabalhado' + (item.daysCount !== 1 ? 's' : '') + '</span>';
        }
        html += '<span><span class="material-symbols-outlined">functions</span>Total: ' + fmtUps(item.totalUps) + ' UPS em ' + item.servicesCount + ' lançamento' + (item.servicesCount !== 1 ? 's' : '') + '</span>';
        if (item.totalMoney) html += '<span><span class="material-symbols-outlined">payments</span>' + fmtMoney(item.totalMoney) + '</span>';
        if (!isSupervisor && item.supervisor) {
          html += '<span><span class="material-symbols-outlined">supervisor_account</span>' + escapeHtml(item.supervisor) + '</span>';
        }
        html += '</div></div>';
      }
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

function renderClassificacao(teamsData, supData, startDate, endDate) {
  classificacaoData = { teams: teamsData || [], sups: supData || [], start: startDate, end: endDate };
  fillSelect('cfSupervisor', supervisorOptions(classificacaoData.teams), 'Todos supervisores');
  renderClassificacaoFiltered();
}

function renderClassificacaoFiltered() {
  var container = $('classificacaoContent');
  if (!container || !classificacaoData) return;
  var d = classificacaoData;
  if (!d.teams.length) {
    container.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined">groups</span><p>Nenhuma equipe encontrada</p></div>';
    return;
  }
  markActiveFilters(['cfSupervisor'], '');
  var q = valOf('cfSearch').trim().toLowerCase();
  var fSup = valOf('cfSupervisor');
  var teamsData = d.teams.filter(function(t) {
    if (q && String(t.username || '').toLowerCase().indexOf(q) === -1) return false;
    return matchOptional(fSup, t.supervisor || '');
  });
  var supData = d.sups.filter(function(s) {
    if (!fSup) return true;
    return fSup === '__none__' ? s.name === 'Sem Supervisor' : s.name === fSup;
  });

  // Colunas a partir das regras cadastradas (ordem de maior para menor UPS)
  var rules = (rulesCache || []).slice().sort(function(a, b) { return b.minUps - a.minUps; });
  var defaultIcons = ['emoji_events', 'military_tech', 'workspace_premium', 'trending_down', 'label'];
  var classOrder = [], classLabels = {}, classIcons = {}, classColors = {};
  rules.forEach(function(r, i) {
    classOrder.push(r.class);
    classLabels[r.class] = 'Classe ' + r.class;
    classIcons[r.class] = defaultIcons[Math.min(i, defaultIcons.length - 1)];
    classColors[r.class] = r.color;
  });
  if (!classOrder.length) {
    classOrder = ['A', 'B', 'C', 'D'];
    classOrder.forEach(function(k, i) { classLabels[k] = 'Classe ' + k; classIcons[k] = defaultIcons[i]; });
    classColors = { A: '#2ecc71', B: '#3498db', C: '#f39c12', D: '#e74c3c' };
  }
  var groupBy = function(items) {
    var g = {};
    items.forEach(function(it) { (g[it.class] = g[it.class] || []).push(it); });
    Object.keys(g).forEach(function(k) { g[k].sort(function(a, b) { return b.avgUps - a.avgUps; }); });
    if (g['-'] && classOrder.indexOf('-') === -1) { classOrder.push('-'); classLabels['-'] = 'Sem classe'; classIcons['-'] = 'help'; classColors['-'] = '#94a3b8'; }
    return g;
  };
  var groups = groupBy(teamsData);
  var supGroups = groupBy(supData);

  var avgAll = teamsData.length ? teamsData.reduce(function(s, t) { return s + t.avgUps; }, 0) / teamsData.length : 0;
  var top = classOrder.length ? (groups[classOrder[0]] || []).length : 0;
  var html = '<div class="stats-overview">' +
    kpi('teams', 'groups', teamsData.length + (teamsData.length !== d.teams.length ? '<small style="font-size:12px;color:var(--text-muted);font-weight:600;"> / ' + d.teams.length + '</small>' : ''), 'Equipes') +
    kpi('services', 'supervisor_account', supData.length, 'Supervisores') +
    kpi('avg', 'speed', fmtUps(avgAll), 'Média UPS/dia') +
    (classOrder.length ? kpi('online', 'emoji_events', top, 'Na ' + escapeHtml(classLabels[classOrder[0]])) : '') +
    kpi('ups', 'calendar_month', periodLabel(d.start, d.end), 'Período', '', true) +
    '</div>';

  html += '<div class="kanban-section-title"><span class="material-symbols-outlined">groups</span> Classificação das equipes</div>';
  html += teamsData.length ? buildKanbanHtml(groups, classOrder, classLabels, classIcons, classColors, false)
    : '<div class="empty-state"><span class="material-symbols-outlined">search_off</span><p>Nenhuma equipe corresponde aos filtros</p></div>';

  html += '<div class="kanban-section-title"><span class="material-symbols-outlined">supervisor_account</span> Classificação dos supervisores</div>';
  html += buildKanbanHtml(supGroups, classOrder, classLabels, classIcons, classColors, true);

  container.innerHTML = html;
}


// ===== OFFLINE / SINCRONIZAÇÃO / ATUALIZAÇÃO =====
var syncStatusTimer = null;
var updateCheckTimer = null;

function updateSyncStatus() {
  if (!window.OfflineDB) return;
  OfflineDB.getStatus().then(function(st) {
    var chip = $('syncChip');
    if (!chip) return;
    var txt = $('syncText');
    if (st.pending > 0) {
      chip.className = 'sync-chip sync-pending';
      txt.textContent = (st.online ? 'Sincronizando' : 'Offline') + ' • ' + st.pending + ' pendente' + (st.pending !== 1 ? 's' : '');
    } else if (!st.online) {
      chip.className = 'sync-chip sync-offline';
      txt.textContent = 'Offline';
    } else {
      chip.className = 'sync-chip sync-online';
      txt.textContent = 'Online • Sincronizado';
    }
  }).catch(function() {});
}

function onOnline() {
  updateSyncStatus();
  OfflineDB.requestSync().then(function(flushed) {
    updateSyncStatus();
    if (flushed) {
      toast('Conexão restaurada. Dados sincronizados!', 'success');
      refreshAfterSync();
    }
  });
  checkForUpdate();
}

function onOffline() {
  updateSyncStatus();
  toast('Sem conexão. O app continua funcionando offline.', 'warning');
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  checkForUpdate();
  if (OfflineDB.isOnline()) OfflineDB.requestSync();
  updateSyncStatus();
}

function refreshAfterSync() {
  if (!currentUser) return;
  if (currentUser.role === 'admin' || currentUser.role === 'supervisor') {
    initAdminView();
  } else if (currentUser.role === 'user') {
    initMonitorView(false);
  } else {
    refreshTeamView();
    loadTeamCatalog();
  }
}

// ===== ATUALIZAÇÃO OBRIGATÓRIA =====
function checkForUpdate() {
  if (!window.OfflineDB || !navigator.onLine) return;
  fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(data) {
    var serverV = data && data.version;
    if (serverV && serverV !== APP_VERSION) {
      showUpdateModal(serverV);
    }
  }).catch(function() {});
}

function showUpdateModal(serverV) {
  var modal = $('updateModal');
  if (!modal) return;
  if ($('updateVersionText')) $('updateVersionText').textContent = serverV;
  modal.classList.add('active');
}

function applyUpdate() {
  var btn = $('updateNowBtn');
  var restoreBtn = function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar agora'; }
  };
  if (btn) { btn.disabled = true; btn.textContent = 'Atualizando...'; }

  var reloaded = false;
  var forceReload = function() {
    if (reloaded) return;
    reloaded = true;
    if ('caches' in window) {
      caches.keys().then(function(keys) {
        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
      }).catch(function() {}).then(function() {
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', forceReload);
    navigator.serviceWorker.getRegistration().then(function(reg) {
      if (!reg) { forceReload(); return; }
      reg.update().catch(function() {});
      setTimeout(forceReload, 3000);
    }).catch(function() {
      setTimeout(forceReload, 3000);
    });
  } else {
    window.location.reload();
  }

  setTimeout(restoreBtn, 10000);
}

// ===== INSTALAÇÃO (PWA) =====
var deferredInstallPrompt = null;
var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function isInAppBrowser() {
  return /FBAN|FBAV|Instagram|Line|WhatsApp|Messenger|MicroMessenger|KAKAOTALK/i.test(navigator.userAgent);
}

function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    var banner = $('installBanner');
    if (banner) banner.style.display = (isStandalone || isInAppBrowser()) ? 'none' : 'flex';
  });
  window.addEventListener('appinstalled', function() {
    var banner = $('installBanner');
    if (banner) banner.style.display = 'none';
    deferredInstallPrompt = null;
    toast('Aplicativo instalado!', 'success');
  });
}

function installApp() {
  if (isStandalone) { toast('O aplicativo já está instalado.', 'info'); return; }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function(choice) {
      deferredInstallPrompt = null;
      var banner = $('installBanner');
      if (banner) banner.style.display = 'none';
    });
    return;
  }
  showInstallHelp();
}

function showInstallHelp() {
  var introEl = $('installHelpIntro');
  var stepsEl = $('installHelpSteps');
  var html = '';
  var intro = '';
  if (isInAppBrowser()) {
    intro = 'Este navegador não permite instalar o aplicativo. Abra o endereço no Chrome (Android) ou no Safari (iPhone).';
    html = '<div class="install-help-step"><b>1.</b><span>Copie o endereço da página e abra no <strong>Chrome</strong> ou <strong>Safari</strong>.</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Depois é só tocar no botão <strong>Instalar</strong> que aparece na tela.</span></div>';
  } else if (isIOS) {
    intro = 'No iPhone, a instalação é feita pelo menu do Safari:';
    html = '<div class="install-help-step"><b>1.</b><span>Toque no botão <strong>Compartilhar</strong> (ícone ↑ dentro de um quadrado).</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Role para baixo e toque em <strong>Adicionar à Tela de Início</strong>.</span></div>' +
      '<div class="install-help-step"><b>3.</b><span>Toque em <strong>Adicionar</strong> no canto superior direito.</span></div>' +
      '<div class="install-help-step"><b>4.</b><span>O ícone do UPS aparecerá na tela inicial como um aplicativo.</span></div>';
  } else {
    intro = 'No Android, use o navegador Chrome:';
    html = '<div class="install-help-step"><b>1.</b><span>Toque no botão <strong>Instalar</strong> deste aviso (se ele aparecer).</span></div>' +
      '<div class="install-help-step"><b>2.</b><span>Ou toque no menu <strong>⋮</strong> → <strong>Instalar aplicativo</strong> (ou <strong>Adicionar à tela inicial</strong>).</span></div>' +
      '<div class="install-help-step"><b>3.</b><span>Confirme em <strong>Instalar</strong>. O app será instalado como um programa.</span></div>';
  }
  introEl.textContent = intro;
  stepsEl.innerHTML = html;
  $('installHelpModal').style.display = 'flex';
}

function closeInstallHelp() {
  $('installHelpModal').style.display = 'none';
}

captureInstallPrompt();

// ===== GLOBAL ERROR CATCHER =====
window.onerror = function(msg, url, line) {
  console.error('Erro global:', msg, url, line);
  loading(false);
  return true;
};
window.addEventListener('unhandledrejection', function(e) {
  console.error('Promise rejeitada sem tratamento:', e.reason);
  loading(false);
});

// ===== INIT =====
document.addEventListener('DOMContentLoaded', function() {
  applyTheme(currentTheme());

  // Esc fecha o modal aberto
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var closers = { teamModal: closeTeamModal, editServiceModal: closeEditServiceModal, editUserModal: closeEditUserModal, editTeamModal: closeEditTeamModal, installHelpModal: closeInstallHelp };
    Object.keys(closers).forEach(function(id) {
      var el = $(id);
      if (el && el.style.display !== 'none') closers[id]();
    });
  });

  var savedUser = localStorage.getItem('ups_user');
  var savedPass = localStorage.getItem('ups_pass');
  if (savedUser && savedPass) {
    $('loginUser').value = savedUser;
    $('loginPass').value = savedPass;
    $('rememberMe').checked = true;
  }

  // Configura a camada offline e eventos de rede
  OfflineDB.setBaseUrl(DB_BASE_URL);
  OfflineDB.setStatusCallback(updateSyncStatus);
  OfflineDB.init().then(function() {
    OfflineDB.prune();
    OfflineDB.sync();
    updateSyncStatus();
  });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', function() { onVisibilityChange(); });

  syncStatusTimer = setInterval(updateSyncStatus, 5000);
  checkForUpdate();
  updateCheckTimer = setInterval(checkForUpdate, 60000);

  seedData().then(function() { return fbOnce('rules'); }).then(function(rules) {
    rulesCache = toArray(rules).map(function(r) {
      return { id: r.id, class: r.class, minUps: r.min_ups, maxUps: r.max_ups, color: r.color };
    });
  }).catch(function(err) {
    console.error('Erro na inicialização:', err);
    showMsg('loginMsg', 'error', 'Erro ao conectar ao Firebase: ' + err.message);
  }).then(function() {
    loading(false);
  });
  $('loginUser').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); $('loginPass').focus(); }
  });
  $('loginPass').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
});
