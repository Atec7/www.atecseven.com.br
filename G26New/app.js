/* =========================================================
   FIREBASE (Realtime Database) — dados na nuvem
========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyDFQCMsX04fwh7MVyEpvXnXD0U4TD5Or5w",
  authDomain: "ja-barbearia.firebaseapp.com",
  databaseURL: "https://ja-barbearia-default-rtdb.firebaseio.com",
  projectId: "ja-barbearia",
  storageBucket: "ja-barbearia.firebasestorage.app",
  messagingSenderId: "213237027963",
  appId: "1:213237027963:web:7d585b158ee06d3ab7fede",
  measurementId: "G-YNNKX5YDDX"
};

const app = firebase.initializeApp(firebaseConfig);
const analytics = firebase.analytics(app);
const rtdb = firebase.database(app);
const DB_REF = rtdb.ref('g26_planner/data');
const PRES_REF = rtdb.ref('g26_planner/presenca');
const ACCIDENT_REF = rtdb.ref('g26_planner/acidentes');
const AUD_REF = rtdb.ref('g26_planner/auditoria');
if('serviceWorker' in navigator){ navigator.serviceWorker.register('./sw.js').catch(()=>{}); }

const DEFAULT_DATA = {
  equipes: [], atividades: [], projetos: [], programacoes: [], ocnds: [], podaProgramacoes: [], oseProgramacoes: [], usuarios: [],
  customFields: { equipes: [], atividades: [], projetos: [], programacoes: [], podaProgramacoes: [], oseProgramacoes: [] },
  cidades: [], cidadeDistancias: [], cidadeMaxDist: 50,
  seq: 1, rev: 0
};
let legacyAuditoria = null;
function mergeData(raw){
  if(!raw || typeof raw!=='object') return structuredClone(DEFAULT_DATA);
  const merged = Object.assign(structuredClone(DEFAULT_DATA), raw);
  merged.customFields = Object.assign(structuredClone(DEFAULT_DATA.customFields), raw.customFields||{});
  merged.seq = Number(merged.seq)||1;
  // Auditoria migrou para nó próprio (g26_planner/auditoria): guarda o legado p/ migração e tira do blob
  if(Array.isArray(raw.auditoria) && raw.auditoria.length && (!legacyAuditoria || raw.auditoria.length>legacyAuditoria.length)) legacyAuditoria = raw.auditoria;
  delete merged.auditoria;
  migrarGids(merged);
  return merged;
}
function migrarGids(db){
  (db||DB).programacoes = (db||DB).programacoes||[];
  (db||DB).programacoes.forEach(pg=>{ if(!pg.gid) pg.gid = novoGid(); });
}
let saveQueue = Promise.resolve();
let saveTimer = null;
let lastWrittenJson = null;
let warnSaveFail = false;
let servidorSincronizado = false;
let lastServerJson = null;
let salvando = false;
const ADMIN_CACHE_KEY = 'g26_admin_cache';
function loadAdminCache(){ try{ const c = JSON.parse(localStorage.getItem(ADMIN_CACHE_KEY)||'null'); return (c && c.synced && c.data)? c.data : null; }catch(e){ return null; } }
function saveAdminCache(db, synced){ try{ localStorage.setItem(ADMIN_CACHE_KEY, JSON.stringify({ synced: !!synced, data: db })); }catch(e){} }
function temPendente(){ try{ const p = JSON.parse(localStorage.getItem('g26_admin_pending')||'null'); return !!(p && p.snapshot); }catch(e){ return false; } }
function atualizarStatusSync(){
  const el = document.getElementById('nav-user');
  if(!el) return;
  const base = CURRENT_USER? 'Conectado: '+CURRENT_USER.nome+' · '+roleLabel(CURRENT_USER.role) : 'Dados sincronizados na nuvem (Firebase)';
  if(!navigator.onLine){ el.textContent = base+' — OFFLINE'; return; }
  if(salvando || temPendente()){ el.textContent = base+' — sincronizando…'; return; }
  el.textContent = servidorSincronizado? base : 'Conectando ao Firebase…';
}
function aplicarPendente(){
  if(!navigator.onLine) return;
  atualizarStatusSync();
  let pending = null;
  try{ pending = JSON.parse(localStorage.getItem('g26_admin_pending')||'null'); }catch(e){}
  if(!pending || !pending.snapshot || !CURRENT_USER) return;
  DB_REF.once('value').then(snap=>{
    const serverNow = snap.exists()? snap.val() : null;
    if(serverNow === pending.server){
      DB_REF.set(pending.snapshot)
        .then(()=>{ try{ localStorage.removeItem('g26_admin_pending'); }catch(e){} toast('Alterações offline aplicadas ao servidor.'); })
        .catch(err=>{ console.error('Falha ao aplicar alterações offline', err); toast('Falha ao aplicar alterações offline.', 'error'); })
        .finally(()=> atualizarStatusSync());
    }else{
      try{ localStorage.removeItem('g26_admin_pending'); }catch(e){}
      toast('Alterações offline NÃO aplicadas: o banco foi atualizado por outro aparelho. Nada foi sobrescrito.', 'error');
      atualizarStatusSync();
    }
  }).catch(err=>{
    console.error('Falha ao verificar dados antes de aplicar alterações offline', err);
    atualizarStatusSync();
  });
}
function saveData(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ saveTimer=null; flushSave(); }, 1000);
}
function guardarPendente(snapshot){
  try{ localStorage.setItem('g26_admin_pending', JSON.stringify({ snapshot, server: lastServerJson })); }catch(e){}
}
function flushSave(){
  if(lastServerJson){
    try{
      const srv = JSON.parse(lastServerJson);
      const srvRev = Number(srv && srv.rev)||0;
      const localRev = Number(DB.rev)||0;
      if(srvRev > localRev){
        DB = mergeData(srv);
        saveAdminCache(DB, true);
        try{ localStorage.removeItem('g26_admin_pending'); }catch(e){}
        if(booted && CURRENT_USER){
          toast('Alteração local NÃO salva: o banco foi atualizado por outro aparelho com dados mais novos. Dados recarregados.', 'error');
          renderBanner(); renderContent(); checkPendingConfirmations();
        }
        atualizarStatusSync();
        return;
      }
    }catch(err){ console.error('Falha ao conferir versão antes de salvar', err); }
  }
  const snapshot = JSON.stringify(DB);
  if(servidorSincronizado && lastWrittenJson===snapshot) return; // nada mudou de fato: evita regravar o banco inteiro
  DB.rev = (DB.rev||0)+1;
  lastWrittenJson = snapshot;
  saveAdminCache(DB, true);
  if(!servidorSincronizado){
    guardarPendente(snapshot);
    atualizarStatusSync();
    return;
  }
  salvando = true;
  atualizarStatusSync();
  saveQueue = saveQueue
    .then(()=> DB_REF.set(snapshot))
    .then(()=>{ try{ localStorage.removeItem('g26_admin_pending'); }catch(e){} })
    .catch(err=>{
      console.error('Falha ao salvar no Firebase', err);
      guardarPendente(snapshot);
      if(navigator.onLine !== false && !warnSaveFail){
        warnSaveFail = true;
        toast('Falha ao salvar no banco: '+err.message, 'error');
      }
    })
    .finally(()=>{ salvando = false; atualizarStatusSync(); });
}
function nextId(){ DB.seq = (DB.seq||1)+1; return DB.seq; }

let DB = structuredClone(DEFAULT_DATA);
let currentView = 'dashboard';
let progFilters = (()=>{ const r=monthRangeISO(); return { projeto:'', equipe:'', status:'Programado', ciclo:'', dataDe:r.de, dataAte:r.ate, modo:'lista', calView:'mes', calDay:todayISO() }; })();
let ativFilters = { q:'', fav:'' };
let equipeFilters = { q:'', status:'' };
let projFilters = { q:'', status:'', ciclo:'', recebido:'', cidade:'', periodoDe:'', periodoAte:'' };
let projetoSel = new Set();
let avancoFilters = { q:'', status:'' };
let histFilters = { tipo:'', projeto:'', dataDe:'', dataAte:'', ultimasHs:12 };
let calRef = new Date();
let CURRENT_USER = null;
function currentAutor(){ return { usuarioNome: CURRENT_USER?.nome || 'Sistema', usuarioLogin: CURRENT_USER?.login || '' }; }
function autor(h){
  if(h && h.usuarioNome && h.usuarioNome!=='Sistema') return esc(h.usuarioNome)+(h.usuarioLogin? ` (${esc(h.usuarioLogin)})`:'');
  return 'Sistema';
}

/* =========================================================
   CONSTANTES DE DOMÍNIO
========================================================= */
const STATUS_PROG = ['Programado','Em Execução','Concluído','Reprogramado','Cancelado'];
const STATUS_COLOR = { 'Programado':'var(--blue)','Em Execução':'var(--accent)','Concluído':'var(--green)','Reprogramado':'var(--purple)','Cancelado':'var(--red)','Despachada':'var(--blue)','Baixada':'var(--accent)','Concluída':'var(--green)' };
const STATUS_OC_NDS = ['Despachada','Baixada','Concluída'];
const STATUS_OC_NDS_COLOR = { 'Despachada':'var(--blue)','Baixada':'var(--accent)','Concluída':'var(--green)' };
const STATUS_PROJETO = ['Aguardando Viabilidade','Em Andamento','Concluído','Encerrado','Cancelado'];
const MOTIVOS_REPROG = [
  'Condições climáticas','Falta de material','Falta de equipamento','Indisponibilidade de equipe',
  'Prioridade emergencial (urgência)','Solicitação da concessionária / cliente','Pendência de liberação / desligamento',
  'Falha de acesso ao local','Outro'
];
const CUSTOM_FIELD_TYPES = [{v:'texto',l:'Texto'},{v:'numero',l:'Número'},{v:'data',l:'Data'},{v:'select',l:'Lista (opções)'}];
const RDO_QUESTIONS = [
  { id:'rdo_condicoes', label:'Condições climáticas' },
  { id:'rdo_impedimento', label:'Impedimento de execução' },
  { id:'rdo_falta_material', label:'Falta de material' },
  { id:'rdo_projeto_incoerente', label:'Projeto incoerente' },
  { id:'rdo_equipe_incompleta', label:'Equipe incompleta' },
  { id:'rdo_falta_veiculo', label:'Falta de veículo' },
  { id:'rdo_impedimento_acesso', label:'Impedimento de acesso' },
  { id:'rdo_licenca_ambiental', label:'Licença ambiental' },
  { id:'rdo_autorizacao_embargo', label:'Autorização/embargo' },
  { id:'rdo_desligamento', label:'Desligamento conforme programado' }
];
const RDO_HORARIOS = [
  { k:'rdoHorarioChegada', label:'Horário Chegada' },
  { k:'rdoHorarioInicio', label:'Horário Início das atividades' },
  { k:'rdoHorarioFinalizacao', label:'Horário Finalização das atividades' },
  { k:'rdoHorarioSaidaObra', label:'Horário Saída da obra' },
  { k:'rdoHorarioChegadaBase', label:'Horário Chegada na base' }
];
const RDO_KM = [
  { k:'rdoKmInicial', label:'KM Inicial' },
  { k:'rdoKmFinal', label:'KM Final' }
];
const IMGGB_KEY = '95bb16ee776d7e20f26857cec98bd372';
const MODULOS_ADMIN = [{k:'equipes',l:'Equipes'},{k:'atividades',l:'Atividades'},{k:'projetos',l:'Projetos'},{k:'programacoes',l:'Programações'}];
const ROLES = [
  { v:'administrador', l:'Administrador', d:'Acesso total ao sistema' },
  { v:'supervisor', l:'Programador', d:'Programa, edita e acompanha execução' },
  { v:'operador', l:'Operador', d:'Somente leitura (visualização)' }
];
const NIVEIS_ACESSO = [
  { v:'total', l:'Total', d:'Todas as telas e ações' },
  { v:'programacao', l:'Programação', d:'Equipes, Atividades, Projetos, Programações, Avanço e Histórico' },
  { v:'leitura', l:'Somente leitura', d:'Visualização geral sem edição' }
];
function roleLabel(v){ return ROLES.find(r=>r.v===v)?.l || v; }
function nivelLabel(v){ return NIVEIS_ACESSO.find(n=>n.v===v)?.l || v; }

const TELAS = [
  { id:'dashboard',       label:'Painel' },
  { id:'alertas',         label:'Alertas' },
  { id:'medição',         label:'Medição' },
  { id:'medição-projetos',label:'Medição - Projetos' },
  { id:'medição-ocnds',   label:'Medição - OC/NDS' },
  { id:'medição-poda',    label:'Medição - PODA' },
  { id:'equipes',         label:'Equipes' },
  { id:'atividades',      label:'Atividades' },
  { id:'projetos',        label:'Projetos' },
  { id:'projetos-cadastro', label:'Cadastro de Projetos' },
  { id:'osepoda',         label:'OSE/PODA' },
  { id:'ose',             label:'OSE' },
  { id:'ose-programacoes', label:'OSE - Programações' },
  { id:'ose-rdo',         label:'OSE - RDO' },
  { id:'poda',            label:'PODA' },
  { id:'poda-programacoes', label:'PODA - Programações' },
  { id:'poda-rdo',        label:'PODA - RDO' },
  { id:'ocnds',           label:'OC/NDS' },
  { id:'avanco',          label:'Avanço' },
  { id:'programacoes',    label:'Programações' },
  { id:'rdo-projetos',   label:'RDO' },
  { id:'rdo-ocnds',      label:'RDO Ocorrências' },
  { id:'historico',       label:'Histórico' },
  { id:'admin',           label:'Administração' },
];
function telaPodeVer(telaId){
  if(!CURRENT_USER) return true;
  if(ehMestre()) return true;
  const p = (CURRENT_USER.permissoes||{})[telaId];
  return p === 'leitura' || p === 'edicao';
}
function telaPodeEditar(telaId){
  if(!CURRENT_USER) return true;
  if(ehMestre()) return true;
  const p = (CURRENT_USER.permissoes||{})[telaId];
  return p === 'edicao';
}
function podeEditar(){
  if(!CURRENT_USER) return true;
  if(ehMestre()) return true;
  if(CURRENT_USER.permissoes && Object.keys(CURRENT_USER.permissoes).length){
    return telaPodeEditar(currentView);
  }
  return CURRENT_USER.nivel !== 'leitura';
}
function requerEscrita(){ if(podeEditar()) return true; toast('Seu usuário não tem permissão de edição nesta tela.', 'error'); return false; }

/* =========================================================
   NAVEGAÇÃO
========================================================= */
const NAV_ITEMS = [
  { id:'dashboard',   label:'Painel',        sub:'Visão geral do sistema', icon:'grid' },
  { id:'alertas',     label:'Alertas',       sub:'Projetos vencendo, reprogramações e viabilidade', icon:'alert' },
  { id:'medição',     label:'Medição',       sub:'Medição de quantidades e aferições', icon:'ruler', children:[
    { id:'medição-projetos', label:'Projetos', sub:'Medição por projetos', icon:'folder' },
    { id:'medição-oc',       label:'OC',         sub:'Medição OC', icon:'siren' },
    { id:'medição-ndsose',   label:'NDS/OSE',    sub:'Medição NDS e OSE', icon:'siren' },
    { id:'medição-poda',     label:'PODA', sub:'Medição de poda', icon:'tree' },
  ]},
  { id:'equipes',     label:'Equipes',       sub:'Cadastro de equipes de campo', icon:'users' },
  { id:'atividades',  label:'Atividades',    sub:'Cadastro de códigos e valores unitários', icon:'list' },
  { id:'projetos',    label:'Projetos',      sub:'Cadastro de projetos', icon:'folder', children:[
    { id:'projetos-cadastro', label:'Cadastro',   sub:'Cadastro de projetos', icon:'folder' },
    { id:'avanco',      label:'Avanço',        sub:'Progresso físico e financeiro', icon:'trend' },
    { id:'programacoes',label:'Programações',  sub:'Agenda, fluxo e reprogramação', icon:'calendar' },
    { id:'rdo-projetos',label:'RDO',           sub:'Relatório de execução das equipes', icon:'clipboard' },
  ]},
  { id:'osepoda',     label:'OSE/PODA',      sub:'Atividade não programada e programação comercial', icon:'tree', children:[
    { id:'ose',          label:'OSE',             sub:'Atividade não programada', icon:'tree', children:[
      { id:'ose-programacoes', label:'Programações', sub:'Agenda e fluxo de OSE', icon:'calendar' },
      { id:'ose-rdo',          label:'RDO',          sub:'Relatório de execução de OSE', icon:'clipboard' },
    ]},
    { id:'poda',         label:'PODA',            sub:'Programação e controle de poda', icon:'tree', children:[
      { id:'poda-programacoes', label:'Programações', sub:'Agenda e fluxo de poda', icon:'calendar' },
      { id:'poda-rdo',          label:'RDO',          sub:'Relatório de execução de poda', icon:'clipboard' },
    ]},
  ]},
  { id:'ocnds',       label:'OC/NDS',        sub:'Atividade não programada e programação comercial', icon:'siren', children:[
    { id:'rdo-ocnds',   label:'RDO Ocorrências', sub:'Ocorrências OC/NDS concluídas', icon:'clipboard' },
  ]},
  { id:'historico',   label:'Histórico',     sub:'Linha do tempo de todas as alterações', icon:'clock' },
  { id:'admin',       label:'Administração', sub:'Campos personalizados de cada módulo', icon:'gear' },
];
const ICONS = {
  grid:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:'<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  history:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  reprog:'<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  empty:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M9 10h6M9 14h4"/>',
  chevL:'<path d="M15 18l-6-6 6-6"/>', chevR:'<path d="M9 18l6-6-6-6"/>', alert:'<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  trend:'<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  star:'<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  print:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  printer:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  whatsapp:'<path d="M21.11 4.88A11.47 11.47 0 0 0 12 2a11.5 11.5 0 0 0-8.14 19.5L2 22l2.6-1.82A11.47 11.47 0 0 0 12 23.5a11.5 11.5 0 0 0 8.14-19.62Z"/><path d="M8.6 8.9c.3-.1.6-.1.8.2l.9 1.4c.1.3.1.6-.1.8l-.5.6c.2.6.7 1.4 1.5 2.1.9.8 1.7 1.1 2.3 1.3l.6-.5c.2-.2.5-.3.8-.1l1.4.9c.3.2.4.5.2.8-.3.6-1 1.1-1.6 1.1-1.4 0-3.6-.8-5.8-3-2.3-2.3-3-4.5-3-5.9.1-.7.6-1.4 1.4-1.7Z"/>',
  hash:'<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  clipboard:'<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M9 12h6M9 16h6"/>',
  pulse:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  pin:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/>',
  layers:'<path d="m12 2 10 6-10 6L2 8Z"/><path d="m2 16 10 6 10-6"/><path d="m2 12 10 6 10-6"/>',
  tree:'<path d="M12 21V12"/><path d="M12 3c-2 0-3 2-3 4 0-2-2-3-4-3 0 3 2 4 3 6-2 0-4 1-4 3 0 1.5 1 3 3 3h10c2 0 3-1.5 3-3 0-2-2-3-4-3 1-2 3-3 3-6-2 0-4 1-4 3 0-2-1-4-3-4Z"/><path d="M12 21v-4"/>',
  siren:'<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M7 21h10"/><path d="M6.5 9.5 4 10M17.5 9.5 20 10M12 3v2M5 6l2 2M19 6l-2 2M8 12h.01M16 12h.01"/><path d="M12 18v3"/>',
  ruler:'<path d="M21.7 7.3l-5-5a1 1 0 0 0-1.4 0l-13 13a1 1 0 0 0 0 1.4l5 5a1 1 0 0 0 1.4 0l13-13a1 1 0 0 0 0-1.4zM8 11l2 2M11 8l2 2M14 11l2 2"/>',
};
function icon(name,size=16){ return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||''}</svg>`; }

    const navExpanded = {};
    function isViewActive(item){
      if(currentView===item.id) return true;
      if(item.children) return item.children.some(c=> isViewActive(c));
      return false;
    }
    function renderNavItem(it){
      if(!telaPodeVer(it.id)){
        if(!it.children) return '';
        const visChildren = it.children.filter(c=> telaPodeVer(c.id));
        if(!visChildren.length) return '';
      }
      const isActive = isViewActive(it);
      if(isActive && it.children && it.children.some(c=> c.id===currentView)) navExpanded[it.id] = true;
      const expanded = !!navExpanded[it.id];
      const chevron = it.children ? `<span class="nav-chevron ${expanded?'open':''}">${icon('chevR',14)}</span>` : '';
      const mainBtn = `<button class="nav-item ${isActive?'active':''}" data-view="${it.id}" ${it.children?'data-has-children="1"':''}>${icon(it.icon)}<span>${it.label}</span>${chevron}</button>`;
      if(!it.children) return mainBtn;
      const subBtns = it.children.map(c=> renderNavItem(c)).join('');
      return mainBtn + `<div class="nav-sub-wrap ${expanded?'open':''}">${subBtns}</div>`;
    }
    function renderNav(){
      const nav = document.getElementById('nav');
      function hasVisibleChild(it){
        if(!it.children) return telaPodeVer(it.id);
        return it.children.some(c=> hasVisibleChild(c));
      }
      const items = NAV_ITEMS.filter(it=>{
        if(it.id==='admin') return CURRENT_USER && CURRENT_USER.role==='administrador';
        return hasVisibleChild(it);
      });
      const alertTotal = alertaCount();
      nav.innerHTML = items.map((it,i) => {
        const badge = it.id==='alertas' && alertTotal>0 ? `<span class="nav-badge">${alertTotal}</span>` : '';
        const sep = i===items.length-1 ? '<div class="nav-sep"></div>' : '';
        return sep + renderNavItem(it);
      }).join('');
      nav.querySelectorAll('[data-has-children]').forEach(btn=>{
        btn.addEventListener('click', (e)=>{
          e.preventDefault();
          e.stopPropagation();
          const wrap = btn.nextElementSibling;
          if(wrap && wrap.classList.contains('nav-sub-wrap')){
            const view = btn.dataset.view;
            navExpanded[view] = !navExpanded[view];
            wrap.classList.toggle('open', navExpanded[view]);
            btn.querySelector('.nav-chevron').classList.toggle('open', navExpanded[view]);
          }
          setView(btn.dataset.view);
        });
      });
      nav.querySelectorAll('.nav-item[data-view]:not([data-has-children])').forEach(btn=>{
        btn.addEventListener('click', ()=> setView(btn.dataset.view));
      });
    }
function setView(view){
  currentView = view;
  document.getElementById('sidebar').classList.remove('open');
  let meta = NAV_ITEMS.find(i=>i.id===view);
  if(!meta){
    function findInChildren(items){
      for(const it of items){
        if(it.id===view) return it;
        if(it.children){ const found = findInChildren(it.children); if(found) return found; }
      }
      return null;
    }
    meta = findInChildren(NAV_ITEMS);
  }
  if(!meta) meta = { label:view, sub:'' };
  document.getElementById('page-title').textContent = meta.label;
  document.getElementById('page-sub').textContent = meta.sub;
  renderNav(); renderTopbarActions(); renderContent(); renderBanner();
  atualizarPresencaView();
}
document.getElementById('mobile-toggle').addEventListener('click', ()=> document.getElementById('sidebar').classList.toggle('open'));

function renderTopbarActions(){
  const el = document.getElementById('topbar-actions');
  el.innerHTML = '';
  // Nome do usuário logado
  const userHtml = `<span style="font-size:12px;font-weight:600;color:var(--accent);padding:0 6px;">👤 ${CURRENT_USER? esc(CURRENT_USER.nome) : ''}</span>`;
  el.insertAdjacentHTML('beforeend', userHtml);
  const primary = (podeEditar()? {
    equipes: ()=>actionBtn('Nova equipe', ()=>openEquipeModal()),
    atividades: ()=>actionBtn('Nova atividade', ()=>openAtividadeModal()),
    projetos: ()=>actionBtn('Novo projeto', ()=>openProjetoModal()),
    'projetos-cadastro': ()=>actionBtn('Novo projeto', ()=>openProjetoModal()),
    programacoes: ()=>actionBtn('Nova programação', ()=>openProgramacaoModal()),
    'poda-programacoes': ()=>actionBtn('Nova programação', ()=>openPodaProgramacaoModal()),
    'ose-programacoes': ()=>actionBtn('Nova programação', ()=>openOseProgramacaoModal()),
  } : {});
  const dangerMap = (podeEditar()? {
    atividades: ()=>btnDanger('Limpar todas', limparTodasAtividades),
  } : {});
  const exportMap = {
    equipes: ()=>btnSecondary('Excel', exportEquipesCSV),
    atividades: ()=>btnSecondary('Excel', exportAtividadesCSV),
    projetos: ()=>btnSecondary('Excel', exportProjetosCSV),
    programacoes: ()=>btnSecondary('Excel', exportProgramacoesCSV),
    'poda-programacoes': ()=>btnSecondary('Excel', exportPodaProgramacoesCSV),
    avanco: ()=>btnSecondary('Excel', exportAvancoCSV),
    historico: ()=>btnSecondary('Excel', exportHistoricoCSV),
    alertas: ()=>btnSecondary('Excel', exportAlertasCSV),
  };
  const docMap = {
    programacoes: ()=>btnSecondary('Documento de campo', openDocumentoDataModal),
    'poda-programacoes': ()=>btnSecondary('Documento de campo', openPodaDocDataModal),
    'ose-programacoes': ()=>btnSecondary('Documento de campo', openOseDocDataModal),
  };
  const importMap = (podeEditar()? {
    atividades: ()=>btnSecondary('Importar em massa', openImportAtividadesModal),
    projetos: ()=>btnSecondary('Importar em massa', openImportProjetosModal),
  } : {});
  if(exportMap[currentView]) el.appendChild(exportMap[currentView]());
  if(importMap[currentView]) el.appendChild(importMap[currentView]());
  if(docMap[currentView]) el.appendChild(docMap[currentView]());
  if(dangerMap[currentView]) el.appendChild(dangerMap[currentView]());
  if(primary[currentView]) el.appendChild(primary[currentView]());
}
function actionBtn(label, onClick){
  const b = document.createElement('button');
  b.className='btn btn-primary';
  b.innerHTML = icon('plus',15)+`<span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}
function btnSecondary(label, onClick){
  const b = document.createElement('button');
  b.className='btn';
  b.innerHTML = icon('download',14)+`<span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}
function btnDanger(label, onClick){
  const b = document.createElement('button');
  b.className='btn btn-danger-solid';
  b.innerHTML = icon('trash',14)+`<span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

/* =========================================================
   HELPERS
========================================================= */
function fmtDate(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function fmtDateTime(iso){ const dt=new Date(iso); return dt.toLocaleDateString('pt-BR')+' '+dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function fmtMoney(v){ return (Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function fmtNum(v){ return (Number(v)||0).toLocaleString('pt-BR',{maximumFractionDigits:2}); }
function todayISO(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function gerarDatasIntervalo(inicio, fim){
  const datas = [];
  const cur = new Date(inicio+'T00:00:00');
  const end = new Date(fim+'T00:00:00');
  while(cur <= end){
    datas.push(cur.getFullYear()+'-'+String(cur.getMonth()+1).padStart(2,'0')+'-'+String(cur.getDate()).padStart(2,'0'));
    cur.setDate(cur.getDate()+1);
  }
  return datas;
}
function monthRangeISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const lastDay = new Date(y, d.getMonth()+1, 0).getDate();
  return { de: y+'-'+m+'-01', ate: y+'-'+m+'-'+String(lastDay).padStart(2,'0') };
}
function diasEntre(de, ate){
  if(!de || !ate) return null;
  return Math.round((new Date(ate+'T12:00:00') - new Date(de+'T12:00:00'))/86400000);
}
function isLate(atrib){ return atrib.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(atrib.status); }
const ALERT_VENCER_DIAS = 30;
const ALERT_VIABILIDADE_DIAS = 20;
const ALERT_VIAB_BREVE_DIAS = 5;
function prazoViabilidadeProjeto(p){
  if(!p?.dataRecebimentoCarteira) return '';
  return shiftISO(p.dataRecebimentoCarteira, ALERT_VIABILIDADE_DIAS);
}
function equipeLabel(eq){
  if(!eq) return '—';
  const parts=[];
  if(eq.eqtl) parts.push(eq.eqtl);
  if(eq.prtn) parts.push(eq.prtn);
  return parts.length? parts.join(' / ') : ('Equipe #'+eq.id);
}
function eqtlLabel(eq){ return (eq && eq.eqtl)? eq.eqtl : '—'; }
function prtnLabel(eq){ return (eq && eq.prtn)? eq.prtn : '—'; }
function cicloMask(v){
  const d = String(v??'').replace(/\D/g,'').slice(0,6);
  if(!d) return '';
  return 'CICLO-' + d.slice(0,2) + (d.length>2? '/'+d.slice(2,6) : '');
}
function isCicloValido(v){ return /^CICLO-\d{2}\/\d{4}$/.test(String(v??'')); }
function bindCicloMasks(root){
  root.querySelectorAll('.ciclo-input').forEach(inp=>{
    inp.addEventListener('input', ()=>{ inp.value = cicloMask(inp.value); });
  });
}
function metaDiaria(eq){ return Number(eq?.metaDiaria)||0; }
function valorProgramadoAtrib(atrib){
  return (atrib?.atividades||[]).reduce((s,a)=> s + ((a.quantidadePrevista||0)*(findAtividade(a.atividadeId)?.valorUnitario||0)), 0);
}
function metaWarningHtml(atrib){
  const eq = findEquipe(atrib?.equipeId); const meta = metaDiaria(eq); if(!meta) return '';
  const val = valorProgramadoAtrib(atrib);
  if(val >= meta) return '';
  return `<span class="badge meta-warn" title="Meta diária da equipe: ${fmtMoney(meta)}">${icon('alert',11)} ${fmtMoney(val)} de ${fmtMoney(meta)}</span>`;
}
function findEquipe(id){ return DB.equipes.find(e=>e.id===Number(id)); }
function findAtividade(id){ return DB.atividades.find(a=>a.id===Number(id)); }
function findProjeto(id){ return DB.projetos.find(p=>p.id===Number(id)); }
function cidadeCor(nome){
  const cid = (DB.cidades||[]).find(c=>c.nome && c.nome.toLowerCase()===String(nome||'').toLowerCase());
  return cid?.cor || '#6b7280';
}
function openCidadeModal(id){
  if(!requerEscrita()) return;
  const cid = id ? (DB.cidades||[]).find(c=>c.id===Number(id)) : null;
  const coresPre = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316','#14b8a6','#6366f1','#84cc16','#e11d48'];
  const corAtual = cid?.cor || '#3b82f6';
  const paletaHtml = coresPre.map(c=>`<button type="button" class="cid-pick" data-cor="${c}" style="width:28px;height:28px;border-radius:6px;background:${c};border:2px solid ${c===corAtual?'#fff':'transparent'};cursor:pointer;flex-shrink:0;" title="${c}"></button>`).join('');
  const body = `
    <div class="field"><label>Nome da cidade <span class="req">*</span></label><input type="text" name="nome" required value="${esc(cid?.nome||'')}" placeholder="Ex: Rio Verde"></div>
    <div class="field"><label>Cor de identificação <span class="req">*</span></label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px;">${paletaHtml}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="text" name="cor" id="cid-cor-input" value="${corAtual}" maxlength="7" style="width:90px;font-family:monospace;font-size:13px;text-transform:lowercase;" placeholder="#3b82f6">
        <input type="color" id="cid-color-native" value="${corAtual}" style="width:38px;height:34px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--panel-2);cursor:pointer;">
      </div>
    </div>`;
  openModal({
    title: cid? 'Editar cidade' : 'Nova cidade', bodyHtml: body, submitLabel: cid? 'Salvar':'Criar cidade',
    onMount:(modal)=>{
      modal.querySelectorAll('.cid-pick').forEach(b=>{
        b.addEventListener('click', ()=>{
          const c = b.dataset.cor;
          modal.querySelector('#cid-cor-input').value = c;
          modal.querySelector('#cid-color-native').value = c;
          modal.querySelectorAll('.cid-pick').forEach(x=>x.style.borderColor='transparent');
          b.style.borderColor='#fff';
        });
      });
      modal.querySelector('#cid-color-native')?.addEventListener('input', (e)=>{
        modal.querySelector('#cid-cor-input').value = e.target.value;
        modal.querySelectorAll('.cid-pick').forEach(x=>x.style.borderColor='transparent');
      });
      modal.querySelector('#cid-cor-input')?.addEventListener('input', (e)=>{
        const v = e.target.value;
        if(/^#[0-9a-f]{6}$/i.test(v)){ modal.querySelector('#cid-color-native').value = v; }
      });
    },
    onSubmit:(fd)=>{
      const nome = fd.get('nome').trim();
      const cor = fd.get('cor').trim();
      if(!nome){ toast('Informe o nome da cidade.', 'error'); return false; }
      if(!/^#[0-9a-f]{6}$/i.test(cor)){ toast('Informe uma cor válida (ex: #3b82f6).', 'error'); return false; }
      if((DB.cidades||[]).some(c=>c.nome.toLowerCase()===nome.toLowerCase() && String(c.id)!==String(cid?.id))){ toast('Já existe uma cidade com este nome.', 'error'); return false; }
      if(cid){ cid.nome=nome; cid.cor=cor; toast('Cidade atualizada.'); registrarEvento('edicao','cidade',cid.id,cid.nome,'Cidade atualizada'); }
      else { const novo={id:nextId(), nome, cor}; DB.cidades.push(novo); toast('Cidade criada.'); registrarEvento('criacao','cidade',novo.id,novo.nome,'Cidade criada'); }
      saveData(); renderContent();
    }
  });
}
function deleteCidade(id){
  const cid = (DB.cidades||[]).find(c=>c.id===Number(id));
  if(!cid) return;
  if(!confirm('Excluir a cidade "'+cid.nome+'"?')) return;
  registrarEvento('exclusao','cidade',cid.id,cid.nome,'Cidade excluída');
  DB.cidades = DB.cidades.filter(c=>c.id!==Number(id)); saveData(); renderContent(); toast('Cidade excluída.');
}
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function hl(text, q){
  text = String(text??'');
  const query = String(q||'').trim();
  if(!query) return esc(text);
  const lower = text.toLowerCase(), ql = query.toLowerCase();
  const out = []; let i = 0, idx;
  while((idx = lower.indexOf(ql, i)) !== -1){
    if(idx > i) out.push(esc(text.slice(i, idx)));
    out.push('<mark>'+esc(text.slice(idx, idx+ql.length))+'</mark>');
    i = idx + ql.length;
  }
  out.push(esc(text.slice(i)));
  return out.join('');
}
function anexoSrc(a){ return (a&&(a.url||a.dataUrl))||''; }
function uploadToImgbb(file, tentativas=3){
  const fd = new FormData();
  fd.append('image', file);
  return fetch('https://api.imgbb.com/1/upload?key='+IMGGB_KEY, { method:'POST', body: fd })
    .then(res=>res.json())
    .then(j=>{
      if(j.success) return (j.data && (j.data.url || j.data.display_url)) || '';
      const msg = (j.error&&j.error.message)||'Falha no upload';
      if(tentativas>1) return new Promise(resolve=>setTimeout(()=>resolve(uploadToImgbb(file, tentativas-1)), 800));
      throw new Error(msg);
    });
}
function comprimirImagem(file, maxLado=1800, qualidade=0.88){
  return new Promise((resolve, reject)=>{
    if(!file || !/^image\//.test(file.type)){ reject(new Error('Arquivo não é imagem')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{
      try{
        const escala = Math.min(1, maxLado/Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth*escala));
        const h = Math.max(1, Math.round(img.naturalHeight*escala));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob=>{
          URL.revokeObjectURL(url);
          blob? resolve(blob) : reject(new Error('Falha na compressão'));
        }, 'image/jpeg', qualidade);
      }catch(e){ URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
    img.src = url;
  });
}
function anexosGridHtml(anexos, editable){
  const list = anexos||[];
  if(!list.length) return editable? '<div class="field-hint">💡 Nenhum anexo ainda. Envie imagens para a equipe visualizar (croqui, localização, detalhe do serviço) — elas também saem no RDO.</div>' : '';
  return `<div class="anexos-grid">${list.map((a,i)=>`
    <div class="anexo-thumb">
      <img src="${esc(anexoSrc(a))}" alt="${esc(a.nome||'anexo')}">
      <div class="anexo-meta">${esc(a.nome||'')}</div>
      ${editable? `<button type="button" class="icon-btn anexo-remove" data-i="${i}" title="Remover anexo">${icon('close',12)}</button>`:''}
    </div>`).join('')}</div>`;
}
function anexosDisplayHtml(anexos, print=false){
  const list = anexos||[];
  if(!list.length) return '';
  if(print) return `<div class="fotos">${list.map(a=>`<figure><img src="${esc(anexoSrc(a))}" alt="${esc(a.nome||'anexo')}"><figcaption>${esc(a.nome||'Anexo do programador')}</figcaption></figure>`).join('')}</div>`;
  return `<div class="anexos-grid">${list.map(a=>`
    <div class="anexo-thumb" role="button" tabindex="0" title="${esc(a.nome||'')}">
      <img src="${esc(anexoSrc(a))}" alt="${esc(a.nome||'anexo')}">
      <div class="anexo-meta">${esc(a.nome||'')}</div>
    </div>`).join('')}</div>`;
}
function openLightbox(srcs, index){
  if(!srcs || !srcs.length) return;
  let i = Math.max(0, Math.min(index||0, srcs.length-1));
  const wrap = document.createElement('div');
  wrap.className = 'lb-overlay';
  wrap.innerHTML = `
    <button type="button" class="lb-close" title="Fechar (Esc)">&times;</button>
    ${srcs.length>1? `<button type="button" class="lb-nav lb-prev" title="Anterior">&#8249;</button><button type="button" class="lb-nav lb-next" title="Próxima">&#8250;</button>`:''}
    <div class="lb-counter">${i+1} / ${srcs.length}</div>
    <img class="lb-img" src="${esc(srcs[i])}" alt="">`;
  document.body.appendChild(wrap);
  const img = wrap.querySelector('.lb-img');
  const counter = wrap.querySelector('.lb-counter');
  function close(){ wrap.remove(); document.removeEventListener('keydown', onKey); }
  function show(){ img.src = srcs[i]; counter.textContent = (i+1)+' / '+srcs.length; }
  function onKey(e){
    if(e.key==='Escape') close();
    else if(e.key==='ArrowRight'){ i=(i+1)%srcs.length; show(); }
    else if(e.key==='ArrowLeft'){ i=(i-1+srcs.length)%srcs.length; show(); }
  }
  wrap.querySelector('.lb-close').addEventListener('click', close);
  const prev=wrap.querySelector('.lb-prev'), next=wrap.querySelector('.lb-next');
  if(prev) prev.addEventListener('click', e=>{ e.stopPropagation(); i=(i-1+srcs.length)%srcs.length; show(); });
  if(next) next.addEventListener('click', e=>{ e.stopPropagation(); i=(i+1)%srcs.length; show(); });
  wrap.addEventListener('click', e=>{ if(e.target===wrap) close(); });
  document.addEventListener('keydown', onKey);
}
document.addEventListener('click', (e)=>{
  if(e.target.closest('.anexo-remove')) return;
  const thumb = e.target.closest('.anexos-grid .anexo-thumb');
  if(thumb){
    const grid = thumb.closest('.anexos-grid');
    const thumbs = Array.from(grid.querySelectorAll('.anexo-thumb'));
    openLightbox(thumbs.map(t=>t.querySelector('img').src), thumbs.indexOf(thumb));
    return;
  }
  const foto = e.target.closest('.rdo-foto');
  if(foto){
    const container = foto.closest('.rdo-fotos');
    const imgs = Array.from(container.querySelectorAll('.rdo-foto'));
    openLightbox(imgs.map(x=>x.src), imgs.indexOf(foto));
    return;
  }
  const execFoto = e.target.closest('.dtl-exec-foto');
  if(execFoto){
    try {
      const todasFotos = JSON.parse(execFoto.dataset.fotos);
      const idx = Number(execFoto.dataset.idx)||0;
      openLightbox(todasFotos, idx);
    } catch(ex){}
  }
});
function toast(msg, kind='ok'){
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div'); t.className='toast';
  if(kind==='error') t.style.borderLeftColor='var(--red)';
  t.textContent = msg; wrap.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='.25s'; setTimeout(()=>t.remove(),250); }, 2600);
}
function bgFromVar(cssVar){
  const map = {'var(--blue)':'rgba(91,141,239,.14)','var(--accent)':'rgba(224,164,88,.14)','var(--green)':'rgba(76,175,109,.14)','var(--purple)':'rgba(180,140,224,.14)','var(--red)':'rgba(224,97,91,.14)'};
  return map[cssVar] || 'rgba(255,255,255,.06)';
}
function statusBadge(status, pending){
  const c = STATUS_COLOR[status] || 'var(--muted)';
  return `<span class="badge ${pending?'blink-red':''}" style="color:${pending?'var(--red)':c};background:${bgFromVar(pending?'var(--red)':c)}"><span class="badge-dot"></span>${status}</span>`;
}
function atividadesResumo(atividadesArr){
  return atividadesArr.map(a=>{ const at=findAtividade(a.atividadeId); return `${esc(at?.codigo||'?')} · ${esc(at?.descricao||'')}`; }).join(', ');
}

/* --- Exportação Excel (CSV) --- */
function exportCSV(filename, headers, rows){
  const sep=';';
  const escCell = v => { v = String(v??''); return /[;"\n]/.test(v)? '"'+v.replace(/"/g,'""')+'"' : v; };
  const lines = [headers.map(escCell).join(sep), ...rows.map(r=>r.map(escCell).join(sep))];
  const blob = new Blob(["\uFEFF"+lines.join('\r\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  toast('Exportado: '+filename);
}
const ATIVIDADE_HEADERS = ['Código','Descrição','Unidade','Valor unitário'];
const ATIVIDADE_EXEMPLO = ['MAN-100','Substituição de poste','un',850];
const PROJETO_HEADERS = ['Código','Nome','Data início','Data fim','Receb. carteira','Vencimento','Setor','Coordenação','Ciclo (CICLO-MM/AAAA)','Valor orçado','Cidade','Descrição'];
const PROJETO_EXEMPLO = ['PRJ-0001','Reforço de rede - Setor Norte','01/01/2026','30/06/2026','10/01/2026','31/12/2026','MANUTENÇÃO','RIO VERDE','CICLO-08/2026',10000,'Rio Verde','Reforço de rede em BT'];
function baixarTemplateExcel(filename, headers, exampleRow){
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  ws['!cols'] = headers.map(h=>({wch: Math.max(12, String(h).length+2)}));
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, filename);
  toast('Template baixado: '+filename);
}
function normalizarLinhasExcel(rows, headers, exampleRow){
  const normCell = c => { if(c instanceof Date) return c.getFullYear()+'-'+String(c.getMonth()+1).padStart(2,'0')+'-'+String(c.getDate()).padStart(2,'0'); return String(c==null?'':c).replace(/^\uFEFF/,'').trim(); };
  const example = exampleRow.map(normCell);
  const headerRow = headers.map(h=>String(h??'').trim());
  const header0 = headerRow[0];
  return rows.map(r=> r.map(normCell)).filter(r=>{
    if(!r.some(c=>c!=='')) return false;
    if(r[0].startsWith('#')) return false;
    if(r[0]===header0) return false;
    if(JSON.stringify(r.slice(0,headerRow.length))===JSON.stringify(headerRow)) return false;
    if(JSON.stringify(r)===JSON.stringify(example)) return false;
    return true;
  });
}
function exportEquipesCSV(){
  exportCSV('equipes.csv',
    ['Nome da equipe','Nome complementar','Setor','Coordenação','Supervisor','Encarregado','Motorista','Meta diária','Eletricistas','Situação'],
    equipesVisiveis().map(e=>[e.eqtl, e.prtn, e.setor||'', e.coordenacao||'', e.supervisor, e.encarregado, e.motorista, e.metaDiaria||'', (e.eletricistas||[]).join(', '), e.ativo? 'Ativa':'Inativa']));
}
function exportAtividadesCSV(){
  exportCSV('atividades.csv',
    ['Código','Descrição','Unidade','Valor unitário','Favorita'],
    DB.atividades.map(a=>[a.codigo, a.descricao, a.unidade||'', fmtMoney(a.valorUnitario), isFavorita(a.id)? 'Sim':'Não']));
}
function exportProjetosCSV(){
  exportCSV('projetos.csv',
    ['Código','Nome','Início','Fim','Receb. carteira','Vencimento','Viabilização','Setor','Coordenação','Ciclo','Status','Orçado (R$)','Executado (R$)','Restante (R$)','% Físico','% Financeiro','Atividades concluídas','Atividades totais'],
    projetosVisiveis().map(p=>{
      const av = projetoAvanco(p);
      return [p.codigo, p.nome, fmtDate(p.dataInicio), fmtDate(p.dataFim), fmtDate(p.dataRecebimentoCarteira), fmtDate(p.dataVencimento), fmtDate(p.dataViabilizacao), p.setor||'', p.coordenacao||'', p.ciclo||'', p.status, fmtMoney(av.valorOrcado), fmtMoney(av.valorExecutado), fmtMoney(av.restante), av.fisicoPct.toFixed(1)+'%', av.financeiroPct.toFixed(1)+'%', av.concluidoLinhas, av.totalLinhas];
    }));
}
function exportAlertasCSV(){
  const hoje = todayISO();
  const rows = [];
  projetosVisiveis().forEach(p=>{
    if(['Concluído','Cancelado'].includes(p.status)) return;
    if(p.dataVencimento){
      const dias = diasEntre(hoje, p.dataVencimento);
      const sit = dias<0? `Vencido há ${-dias} dia(s)` : (dias===0? 'Vence hoje' : `Vence em ${dias} dia(s)`);
      rows.push(['Vencimento', p.codigo, p.nome, fmtDate(p.dataVencimento), sit, p.status]);
    }
    if(p.dataRecebimentoCarteira){
      const prazo = prazoViabilidadeProjeto(p);
      const dias = diasEntre(hoje, prazo);
      const sit = p.dataViabilizacao? `Viabilizado em ${fmtDate(p.dataViabilizacao)}` : (dias<0? `Viabilização atrasada há ${-dias} dia(s)` : `${dias} dia(s) para o prazo de viabilização`);
      rows.push(['Viabilidade', p.codigo, p.nome, fmtDate(prazo), sit, p.status]);
    }
  });
  flatAtribuicoes().filter(x=>x.atribuicao.status==='Reprogramado').forEach(x=>{
    const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId);
    rows.push(['Reprogramação', pr?.codigo||'', pr?.nome||'', fmtDate(p.dataProgramada), 'Reprogramação pendente', p.status]);
  });
  exportCSV('alertas.csv', ['Tipo','Código','Projeto','Data referência','Situação','Status'], rows);
}
function exportProgramacoesCSV(){
  exportCSV('programacoes.csv',
    ['Data','Código','Projeto','Setor','Coordenação','Ciclo','Equipe','Equipe comp.','Atividades','Valor previsto','Status'],
    programacoesFiltradas().map(x=>{
      const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId);
      return [fmtDate(p.dataProgramada), pr?.codigo||'', pr?.nome||'-', pr?.setor||'', pr?.coordenacao||'', x.programacao.ciclo||'', eqtlLabel(eq), prtnLabel(eq), atividadesResumo(p.atividades), fmtMoney(valorProgramadoAtrib(p)), p.status];
    }));
}
function exportPodaProgramacoesCSV(){
  exportCSV('poda_programacoes.csv',
    ['ID','Data','OSI','Subestação','Qtd. Anomalia','Tipo Rede','Chave','ASI','Status Doc.','ID-SIPROG','OSE','Equipe','Atividades','Status','Observações'],
    podaProgramacoesVisiveis().map(p=>{
      const eq = findEquipe(p.equipeId);
      const ativs = (p.atividades||[]).map(a=>{ const at=findAtividade(a.atividadeId); return `${at?.codigo||'?'} ×${a.quantidadePrevista??'—'}`; }).join(', ');
      return [podaProgLabel(p), fmtDate(p.dataProgramacao), p.osi||'', p.subestacao||'', p.qtdAnomalia||'', p.tipoRede||'', p.chave||'', p.asi||'', p.statusDocumentacao||'', p.idSiprog||'', p.ose||'', equipeLabel(eq), ativs, p.status||'', p.observacoes||''];
    }));
}
function exportAvancoCSV(){
  exportCSV('avanco.csv',
    ['Código','Projeto','Status','Orçado (R$)','Executado (R$)','Restante (R$)','% Físico','% Financeiro','Concluídas','Total'],
    projetosVisiveis().map(p=>{
      const av = projetoAvanco(p);
      return [p.codigo, p.nome, p.status, fmtMoney(av.valorOrcado), fmtMoney(av.valorExecutado), fmtMoney(av.restante), av.fisicoPct.toFixed(1)+'%', av.financeiroPct.toFixed(1)+'%', av.concluidoLinhas, av.totalLinhas];
    }));
}
function exportHistoricoCSV(){
  const rows = [];
  flatAtribuicoes().forEach(x=>{
    const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId);
    p.atividades.forEach(a=>{
      const at = findAtividade(a.atividadeId);
      const qtdPrev = a.quantidadePrevista??0;
      const qtdExec = (a.quantidadeExecutada!=null)? a.quantidadeExecutada : (p.status==='Concluído'? qtdPrev : 0);
      const vu = at?.valorUnitario||0;
      rows.push([
        fmtDate(p.dataProgramada), x.programacao.ciclo||'', pr?.codigo||'', pr?.nome||'', pr?.setor||'', pr?.coordenacao||'',
        eqtlLabel(eq), prtnLabel(eq), p.status, at?.codigo||'?', at?.descricao||'', at?.unidade||'',
        qtdPrev, qtdExec, vu, qtdPrev*vu, qtdExec*vu
      ]);
    });
  });
  exportCSV('historico_atividades.csv',
    ['Data','Ciclo','Projeto código','Projeto','Setor','Coordenação','Equipe','Equipe comp.','Status','Atividade código','Descrição','Unidade','Qtd. prevista','Qtd. executada','Valor unitário','Valor bruto previsto','Valor bruto executado'],
    rows);
}

/* --- Atividades favoritas (por usuário) --- */
function getUserFavoritos(){
  const login = CURRENT_USER?.login || 'anon';
  DB.favoritosAtividades = DB.favoritosAtividades || {};
  DB.favoritosAtividades[login] = DB.favoritosAtividades[login] || [];
  return new Set(DB.favoritosAtividades[login]);
}
function isFavorita(atividadeId){
  return getUserFavoritos().has(Number(atividadeId));
}
function toggleFavAtividade(id){
  if(!requerEscrita()) return;
  const favs = getUserFavoritos();
  const aid = Number(id);
  if(favs.has(aid)) favs.delete(aid);
  else favs.add(aid);
  DB.favoritosAtividades[CURRENT_USER?.login || 'anon'] = [...favs];
  saveData(); renderContent(); toast(favs.has(aid)? 'Marcada como favorita.' : 'Removida das favoritas.');
}
function atividadesOrdenadas(){
  const favs = getUserFavoritos();
  return [...DB.atividades].sort((a,b)=> (favs.has(b.id)?1:0)-(favs.has(a.id)?1:0) || String(a.codigo||'').localeCompare(String(b.codigo||''), 'pt', {numeric:true}));
}
function importarAtividadesLinhas(linhas){
  const parseValor = s => { const t=String(s??'').trim(); if(!t) return 0; const v = t.includes(',')? parseFloat(t.replace(/\./g,'').replace(',', '.')) : parseFloat(t); return isNaN(v)? 0 : v; };
  const codigoExiste = c => DB.atividades.some(a=>String(a.codigo).toLowerCase()===String(c).toLowerCase());
  const ocorrencias = {};
  linhas.forEach(p=>{ const c = String(p[0]||'').trim(); if(c) ocorrencias[c] = (ocorrencias[c]||0)+1; });
  const usados = {};
  let criadas=0, ignoradas=0, erros=0, renumerados=0;
  const msgErro=[];
  linhas.forEach((partes,i)=>{
    const codigoBase = String(partes[0]||'').trim();
    const descricao = String(partes[1]||'').trim();
    if(!codigoBase || !descricao){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': faltando código ou descrição'); return; }
    const repetido = (ocorrencias[codigoBase]||0) > 1;
    let codigo = codigoBase;
    if(repetido){
      const n = (usados[codigoBase]||0)+1;
      usados[codigoBase] = n;
      if(n>1){ codigo = codigoBase+'-'+String(n).padStart(3,'0'); renumerados++; }
    }
    if(codigoExiste(codigo)){ ignorados++; return; }
    DB.atividades.push({ id:nextId(), codigo, descricao, unidade: String(partes[2]||'').trim(), valorUnitario: parseValor(partes[3]), custom:{} });
    criadas++;
  });
  return { criadas, ignoradas, erros, msgErro, renumerados };
}
function openImportAtividadesModal(){
  openImportArquivoModal({
    title:'Importar atividades em massa',
    templateName:'template_atividades.xlsx',
    headers: ATIVIDADE_HEADERS,
    exampleRow: ATIVIDADE_EXEMPLO,
    textoAviso: 'Se o arquivo tiver o mesmo código em várias linhas (ex.: número de OS repetido), o sistema renumerada automaticamente (5000000658-002, -003…) para cada serviço virar uma atividade. Códigos que já existem no banco são ignorados.',
    processar: importarAtividadesLinhas,
    toastResumo: (r,n)=>`Importadas ${r.criadas} atividade(s).`+(r.renumerados? ` ${r.renumerados} código(s) repetido(s) renumerado(s) automaticamente (ex.: -002, -003).`:'')+(r.ignoradas? ` ${r.ignoradas} já existente(s) ignorada(s).`:'')+(r.erros? ` ${r.erros} linha(s) com erro.`:'')+(r.msgErro.length? ' '+r.msgErro.join(' — '):'')+(n===0? ' Nenhuma linha de dados encontrada no arquivo — confira o template e a aba correta do Excel.' : '')
  });
}
/* --- Importação em massa de projetos --- */
function parseDataISO(v){
  if(!v) return '';
  const s = String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if(!m) return '';
  const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0');
  const a = m[3].length===2? '20'+m[3] : m[3];
  return a+'-'+mo+'-'+d;
}
function parseValorNum(v){
  const t = String(v??'').trim();
  if(!t) return 0;
  const n = t.includes(',')? parseFloat(t.replace(/\./g,'').replace(',','.')) : parseFloat(t);
  return isNaN(n)? 0 : n;
}
function importarProjetosLinhas(linhas){
  const normKey = s => String(s||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const codigoExiste = c => DB.projetos.some(p=> normKey(p.codigo)===normKey(c));
  const nomeExiste = n => DB.projetos.some(p=> p.nome && normKey(p.nome)===normKey(n));
  let criados=0, ignorados=0, erros=0;
  const msgErro=[];
  linhas.forEach((partes,i)=>{
    const codigo = String(partes[0]||'').trim();
    const nome = String(partes[1]||'').trim();
    if(!codigo || !nome){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': faltando código ou nome'); return; }
    if(codigoExiste(codigo) || nomeExiste(nome)){ ignorados++; return; }
    let setor = partes[6]? normKey(partes[6]) : '';
    let coordenacao = partes[7]? normKey(partes[7]) : '';
    if(usuarioRestrito()){
      if(setor && setor!==normKey(CURRENT_USER.setor)){ ignorados++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': projeto fora do seu setor'); return; }
      if(coordenacao && coordenacao!==normKey(CURRENT_USER.coordenacao)){ ignorados++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': projeto fora da sua coordenação'); return; }
      setor = normKey(CURRENT_USER.setor); coordenacao = normKey(CURRENT_USER.coordenacao);
    }
    if(!setor || !['MANUTENCAO','OBRAS'].includes(setor)){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': setor inválido (use MANUTENÇÃO ou OBRAS)'); return; }
    if(!coordenacao || !['RIO VERDE','QUIRINOPOLIS'].includes(coordenacao)){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': coordenação inválida (use RIO VERDE ou QUIRINOPOLIS)'); return; }
    setor = setor==='MANUTENCAO'? 'MANUTENÇÃO' : 'OBRAS';
    coordenacao = coordenacao==='RIO VERDE'? 'RIO VERDE' : 'QUIRINOPOLIS';
    const dataInicio = parseDataISO(partes[2]);
    const dataFim = parseDataISO(partes[3]);
    const dataRecebimentoCarteira = parseDataISO(partes[4]);
    const dataVencimento = parseDataISO(partes[5]);
    const ciclo = cicloMask(partes[8]);
    if(!isCicloValido(ciclo)){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': ciclo inválido (use MM/AAAA ou CICLO-MM/AAAA)'); return; }
    if(!dataInicio || !dataRecebimentoCarteira || !dataVencimento){ erros++; if(msgErro.length<3) msgErro.push('Linha '+(i+1)+': preencha data início, receb. carteira e vencimento'); return; }
    DB.projetos.push({
      id: nextId(),
      codigo: codigo,
      nome: nome,
      descricao: String(partes[11]||'').trim(),
      dataInicio: dataInicio,
      dataFim: dataFim,
      dataRecebimentoCarteira: dataRecebimentoCarteira,
      dataVencimento: dataVencimento,
      dataViabilizacao: '',
      setor: setor,
      coordenacao: coordenacao,
      cidade: String(partes[10]||'').trim(),
      status: 'Aguardando Viabilidade',
      valorOrcado: parseValorNum(partes[9]),
      ciclo: ciclo,
      planoFisico: [],
      custom: {}
    });
    criados++;
  });
  return { criados, ignorados, erros, msgErro };
}
function openImportProjetosModal(){
  openImportArquivoModal({
    title:'Importar projetos em massa',
    templateName:'template_projetos.xlsx',
    headers: PROJETO_HEADERS,
    exampleRow: PROJETO_EXEMPLO,
    textoAviso: 'Todos os projetos importados entram no status "Aguardando Viabilidade". Projetos com código ou nome já cadastrado são ignorados (evita duplicidade). Datas no padrão DD/MM/AAAA e ciclo por extenso, ex.: CICLO-08/2026.',
    processar: importarProjetosLinhas,
    toastResumo: (r,n)=>`Importados ${r.criados} projeto(s) como "Aguardando Viabilidade".`+(r.ignorados? ` ${r.ignorados} duplicado(s)/ignorado(s).`:'')+(r.erros? ` ${r.erros} linha(s) com erro.`:'')+(r.msgErro.length? ' '+r.msgErro.join(' — '):'')+(n===0? ' Nenhuma linha de dados encontrada no arquivo — confira o template e a aba correta do Excel.' : '')
  });
}
function openImportArquivoModal({title, templateName, headers, exampleRow, textoAviso, processar, toastResumo}){
  if(!requerEscrita()) return;
  if(typeof XLSX==='undefined'){ toast('Biblioteca de planilhas indisponível. Verifique a conexão e recarregue.', 'error'); return; }
  const jaUsouHoje = !ehMestre() && ((((DB.importControl||{})[String(CURRENT_USER.login)]))||'')===todayISO();
  const root = document.getElementById('modal-root');
  let arquivo = null;
  function importar(){
    if(!arquivo){ toast('Escolha o arquivo preenchido antes de importar.', 'error'); return; }
    const rd = new FileReader();
    rd.onload = ()=>{
      try{
        const wb = XLSX.read(new Uint8Array(rd.result), {type:'array', cellDates:true});
        let ws = null;
        for(const name of wb.SheetNames){
          const s = wb.Sheets[name];
          if(s && s['!ref'] && XLSX.utils.decode_range(s['!ref']).e.r > 0){ ws = s; break; }
        }
        if(!ws) ws = wb.Sheets[wb.SheetNames[0]];
        const linhas = normalizarLinhasExcel(XLSX.utils.sheet_to_json(ws, {header:1, defval:''}), headers, exampleRow);
        let consumoRegistrado = false;
        if(!ehMestre()){
          if(linhas.length > 30){ toast('Limite de 30 linhas por importação. Seu arquivo tem '+linhas.length+' linha(s) — divida em partes menores.', 'error'); return; }
          const ultimoDia = ((DB.importControl||{})[String(CURRENT_USER.login)]) || '';
          if(ultimoDia && ultimoDia===todayISO()){ toast('Importação em massa já realizada hoje. O limite é de 1x por dia.', 'error'); return; }
          if(linhas.length){
            DB.importControl = DB.importControl||{};
            DB.importControl[String(CURRENT_USER.login)] = todayISO();
            consumoRegistrado = true;
            registrarEvento('config','sistema',null,CURRENT_USER.login,'Importação em massa ('+linhas.length+' linha(s))');
          }
        }
        const r = processar(linhas);
        root.innerHTML='';
        if(r.criados>0 || consumoRegistrado){ saveData(); renderContent(); }
        if(linhas.length===0){
          const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''}).slice(0,12);
          root.innerHTML = `
            <div class="modal-overlay" id="modal-overlay">
              <div class="modal" style="max-width:660px;">
                <div class="modal-head"><h3>Nenhuma linha válida reconhecida</h3><button class="icon-btn" id="modal-close">${icon('close')}</button></div>
                <div class="modal-body">
                  <div class="field-hint">💡 O arquivo foi lido, mas nenhuma linha passou na validação. Abaixo está o <strong>que o sistema leu do arquivo</strong> (até 12 linhas). Se estas linhas não parecem com seus dados, o arquivo pode estar em outra aba ou coluna.</div>
                  <div class="table-scroll"><table><thead><tr><th>#</th><th>Col. 1</th><th>Col. 2</th><th>Col. 3</th><th>Col. 4</th></tr></thead>
                  <tbody>${raw.map((rr,i)=>`<tr><td>${i+1}</td><td>${esc(rr[0])}</td><td>${esc(rr[1])}</td><td>${esc(rr[2])}</td><td>${esc(rr[3])}</td></tr>`).join('') || '<tr class="empty-row"><td colspan="5">Arquivo vazio.</td></tr>'}</tbody></table></div>
                  <div class="field-hint">💡 Dica: baixe o template, preencha <strong>abaixo</strong> da linha de exemplo (código e descrição obrigatórios) e salve como .xlsx.</div>
                </div>
                <div class="modal-foot"><button type="button" class="btn btn-primary" id="modal-close2">Entendi</button></div>
              </div>
            </div>`;
          const fechar = ()=>{ root.innerHTML=''; };
          document.getElementById('modal-close').addEventListener('click', fechar);
          document.getElementById('modal-close2').addEventListener('click', fechar);
        } else {
          toast(toastResumo? toastResumo(r, linhas.length) : 'Importação concluída.');
        }
      }catch(err){
        console.error('Falha ao ler o arquivo', err);
        toast('Falha ao ler o arquivo. Use o template baixado.', 'error');
      }
    };
    rd.readAsArrayBuffer(arquivo);
  }
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <div class="modal-head"><h3>${title}</h3><button class="icon-btn" id="modal-close">${icon('close')}</button></div>
        <div class="modal-body">
          <div class="field"><button type="button" class="btn" id="dl-template">${icon('download',14)} Baixar template Excel</button>
            <div class="field-hint">💡 O template vem com o cabeçalho (colunas na ordem) e uma <strong>linha de exemplo</strong>. Preencha suas linhas abaixo do cabeçalho, salve e envie o arquivo.</div>
          </div>
          <div class="field"><label>Arquivo preenchido (.xlsx)</label><input type="file" id="imp-arquivo" accept=".xlsx,.xls,.csv"></div>
          ${!ehMestre()? `<div class="field-hint">${jaUsouHoje? '⚠️ Você já realizou sua importação em massa hoje. O limite é de <strong>1 importação por dia</strong>.' : '📏 Limite para este usuário: <strong>30 linhas por arquivo</strong> e <strong>1 importação por dia</strong> (o usuário Mestre não possui limites).'}</div>` : ''}
          ${textoAviso? `<div class="field-hint">💡 ${textoAviso}</div>` : ''}
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="imp-confirm" ${jaUsouHoje? 'disabled style="opacity:.5;cursor:not-allowed;"':''}>Importar arquivo</button></div>
      </div>
    </div>`;
  document.getElementById('modal-close').addEventListener('click', ()=>{ root.innerHTML=''; });
  document.getElementById('modal-cancel').addEventListener('click', ()=>{ root.innerHTML=''; });
  document.getElementById('dl-template').addEventListener('click', ()=>baixarTemplateExcel(templateName, headers, exampleRow));
  document.getElementById('imp-arquivo').addEventListener('change', e=>{ arquivo = e.target.files[0]||null; });
  document.getElementById('imp-confirm').addEventListener('click', importar);
}
/* =========================================================
   ATRIBUIÇÕES (flatten programação -> equipe)
========================================================= */
function flatAtribuicoes(){
  const out=[];
  const vis = projetosVisiveis().map(p=>p.id);
  DB.programacoes.forEach(pg=>{ if(vis.includes(pg.projetoId)) (pg.atribuicoes||[]).forEach(at=> out.push({ programacao: pg, atribuicao: at })); });
  return out;
}
function pendingList(){
  const proj = flatAtribuicoes().filter(x=> isLate(x.atribuicao)).map(x=>({...x, _tipo:'projeto'}));
  const poda = flatPodaAtribuicoes().filter(x=> isLate(x.atribuicao)).map(x=>({...x, _tipo:'poda'}));
  const ose = flatOseAtribuicoes().filter(x=> isLate(x.atribuicao)).map(x=>({...x, _tipo:'ose'}));
  return proj.concat(poda, ose);
}
function alertaCount(){
  const hoje = todayISO();
  const ps = projetosVisiveis();
  const vencidos = ps.filter(p=> p.dataVencimento && !['Concluído','Cancelado'].includes(p.status) && p.dataVencimento < hoje).length;
  const viabAtraso = ps.filter(p=> p.dataRecebimentoCarteira && !p.dataViabilizacao && prazoViabilidadeProjeto(p) < hoje).length;
  const reprog = flatAtribuicoes().filter(x=>x.atribuicao.status==='Reprogramado').length;
  const cem = ps.filter(p=> !['Encerrado','Cancelado'].includes(p.status) && (projetoAvanco(p).fisicoPct>=100 || projetoAvanco(p).financeiroPct>=100)).length;
  return vencidos + viabAtraso + reprog + cem;
}
function teamEdits(atrib){ return (atrib?.historico||[]).filter(h=>h.tipo==='equipe'); }
function lastTeamEdit(atrib){ const l=teamEdits(atrib); return l[l.length-1]||null; }
function teamBadgeHtml(atrib){
  const e = lastTeamEdit(atrib);
  if(!e) return '';
  return `<span class="badge team-badge" title="Alterada pela equipe em ${fmtDateTime(e.ts)} — ${esc(e.motivo||'')}">${icon('alert',11)} Alterada pela equipe</span>`;
}

/* =========================================================
   CAMPOS PERSONALIZADOS
========================================================= */
function renderCustomFieldsInputs(moduleKey, record){
  const fields = DB.customFields[moduleKey]||[];
  if(!fields.length) return '';
  return fields.map(f=>{
    const val = record?.custom?.[f.id] ?? '';
    if(f.tipo==='select'){
      return `<div class="field"><label>${esc(f.label)}</label><select name="custom_${f.id}"><option value="">Selecione…</option>${(f.opcoes||[]).map(o=>`<option ${val===o?'selected':''}>${esc(o)}</option>`).join('')}</select></div>`;
    }
    const type = f.tipo==='numero'?'number': f.tipo==='data'?'date':'text';
    return `<div class="field"><label>${esc(f.label)}</label><input type="${type}" name="custom_${f.id}" value="${esc(val)}"></div>`;
  }).join('');
}
function parseCustomFieldsFromForm(moduleKey, fd){
  const fields = DB.customFields[moduleKey]||[];
  const out={};
  fields.forEach(f=>{ out[f.id] = fd.get('custom_'+f.id) || ''; });
  return out;
}

/* =========================================================
   MODAL GENÉRICO
========================================================= */
function openModal({title, bodyHtml, onMount, onSubmit, submitLabel='Salvar', wide=false, extraWide=false, footerBtns=[]}){
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal" style="${extraWide?'max-width:900px':wide?'max-width:660px':''}">
        <div class="modal-head"><h3>${title}</h3><button class="icon-btn" id="modal-close">${icon('close')}</button></div>
        <form id="modal-form">
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-foot">${footerBtns.map((b,i)=>`<button type="button" class="${b.cls||'btn btn-ghost'}" id="modal-btn-${i}">${b.label}</button>`).join('')}<button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="submit" class="btn btn-primary">${submitLabel}</button></div>
        </form>
      </div>
    </div>`;
  const close = ()=>{ root.innerHTML=''; };
  document.getElementById('modal-close').addEventListener('click', close);
  document.getElementById('modal-cancel').addEventListener('click', close);
  document.getElementById('modal-form').addEventListener('submit', (e)=>{ e.preventDefault(); const ok = onSubmit(new FormData(e.target), e.target); if(ok!==false) close(); });
  footerBtns.forEach((b,i)=>{ const el=document.getElementById('modal-btn-'+i); if(el) el.addEventListener('click', ()=> b.onClick(el)); });
  if(onMount) onMount(root);
}

/* =========================================================
   BANNER GLOBAL DE PENDÊNCIAS
========================================================= */
function recebeAlertaExecucao(){
  if(!CURRENT_USER || CURRENT_USER.ativo===false) return false;
  const aprovadores = (DB.usuarios||[]).filter(x=> x.ativo!==false && x.aprovador);
  if(!aprovadores.length) return true;
  return aprovadores.some(x=> String(x.id)===String(CURRENT_USER.id));
}

function renderBanner(){
  const area = document.getElementById('banner-area');
  if(!recebeAlertaExecucao()){ area.innerHTML=''; return; }
  const list = pendingList();
  if(!list.length){ area.innerHTML=''; return; }
  area.innerHTML = `
    <div class="pending-banner">
      <div class="pb-text">${icon('alert',15)} <strong>${list.length} programação(ões) vencida(s)</strong> aguardando confirmação de execução.</div>
      <button class="btn btn-danger-solid btn-sm" id="banner-responder">Responder agora</button>
    </div>`;
  document.getElementById('banner-responder').addEventListener('click', ()=> checkPendingConfirmations(true));
}

function checkPendingConfirmations(force){
  if(!recebeAlertaExecucao()) return;
  const list = pendingList();
  if(!list.length) return;
  const item = list[0];
  if(item._tipo==='poda'){
    openPodaConfirmacaoModal(item.programacao, item.atribuicao, ()=>{ renderBanner(); checkPendingConfirmations(); });
  } else if(item._tipo==='ose'){
    openOseConfirmacaoModal(item.programacao, item.atribuicao, ()=>{ renderBanner(); checkPendingConfirmations(); });
  } else {
    openConfirmacaoModal(item.programacao, item.atribuicao, ()=>{ renderBanner(); checkPendingConfirmations(); });
  }
}

/* =========================================================
   MODAL DE CONFIRMAÇÃO (SIM / NÃO) — bloqueante
========================================================= */
function createActivityEditorInline(containerEl, initial){
  let items = JSON.parse(JSON.stringify((initial&&initial.length)? initial.map(x=>({atividadeId:x.atividadeId, quantidadePrevista:x.quantidadePrevista})) : [{atividadeId:'',quantidadePrevista:''}]));
  function paint(){
    containerEl.innerHTML = items.map((it,j)=>`
      <div class="activity-row" data-j="${j}">
        <select class="ae-select" data-j="${j}"><option value="">Atividade…</option>${atividadesOrdenadas().map(x=>`<option value="${x.id}" ${String(it.atividadeId)===String(x.id)?'selected':''}>${isFavorita(x.id)?'★ ':''}${esc(x.codigo)} · ${esc(x.descricao)}</option>`).join('')}</select>
        <input type="number" step="0.01" min="0" class="ae-qty" data-j="${j}" placeholder="Qtd." value="${it.quantidadePrevista??''}">
        ${items.length>1?`<button type="button" class="icon-btn ae-remove" data-j="${j}">${icon('close',13)}</button>`:''}
      </div>`).join('');
    containerEl.querySelectorAll('.ae-select').forEach(s=>s.addEventListener('change', e=>{ items[e.target.dataset.j].atividadeId = e.target.value; }));
    containerEl.querySelectorAll('.ae-qty').forEach(s=>s.addEventListener('input', e=>{ items[e.target.dataset.j].quantidadePrevista = e.target.value; }));
    containerEl.querySelectorAll('.ae-remove').forEach(b=>b.addEventListener('click', e=>{ items.splice(Number(e.currentTarget.dataset.j),1); paint(); }));
  }
  paint();
  return { addRow(){ items.push({atividadeId:'',quantidadePrevista:''}); paint(); }, getData(){ return items.filter(it=>it.atividadeId).map(it=>({atividadeId:Number(it.atividadeId), quantidadePrevista: it.quantidadePrevista?parseFloat(it.quantidadePrevista):null})); } };
}

function openConfirmacaoModal(prog, atrib, onResolved){
  const root = document.getElementById('modal-root');
  const eq = findEquipe(atrib.equipeId);
  let editor = null;

  function activitiesSummaryHtml(){
    return atrib.atividades.map(a=>{ const at=findAtividade(a.atividadeId); return `${esc(at?.codigo||'')} · ${esc(at?.descricao||'')} <span style="color:var(--muted-2);">(${a.quantidadePrevista??'-'} previsto)</span>`; }).join('<br>');
  }

  function renderStep(step){
    let inner='';
    if(step==='question'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Programação vencida — equipe <strong>${equipeLabel(eq)}</strong> — data prevista ${fmtDate(atrib.dataProgramada)}</div>
          <div style="margin:10px 0;font-size:13px;line-height:1.7;">${activitiesSummaryHtml()}</div>
          <div class="confirm-question">A PROGRAMAÇÃO FOI EXECUTADA?</div>
        </div>
        <div class="modal-foot" style="justify-content:center;gap:14px;">
          <button type="button" class="btn btn-ghost" id="c-visualizar">${icon('search',14)} VISUALIZAR</button>
          <button type="button" class="btn btn-danger-solid" id="c-nao">NÃO</button>
          <button type="button" class="btn btn-primary" id="c-sim">SIM</button>
        </div>`;
    } else if(step==='visualizar'){
      const detalheHtml = atribDetalheHtml(prog, atrib, false);
      inner = `
        <div class="modal-body">
          <div class="confirm-banner">${icon('alert',15)} Confira os dados e o retorno da equipe antes de responder.</div>
          ${detalheHtml}
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="c-back-visualizar">← Voltar à pergunta</button></div>`;
    } else if(step==='sim'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Confirme as quantidades executadas por <strong>${equipeLabel(eq)}</strong>. Você pode manter os valores previstos ou editar antes de concluir.</div>
          ${atrib.atividades.map((a,idx)=>{ const at=findAtividade(a.atividadeId);
            return `<div class="field"><label>${esc(at?.codigo||'')} · ${esc(at?.descricao||'')}</label><input type="number" step="0.01" class="exec-qty" data-idx="${idx}" value="${a.quantidadeExecutada ?? a.quantidadePrevista ?? ''}"></div>`;
          }).join('')}
          <div class="field"><label>Motivo da conclusão <span class="req">*</span></label><input type="text" id="sim-motivo" maxlength="200" placeholder="Ex.: serviço executado conforme programado"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="c-back">← Voltar</button><button type="button" class="btn btn-primary" id="c-concluir">Manter/editar e concluir</button></div>`;
    } else if(step==='nao'){
      inner = `
        <div class="modal-body">
          <div class="field"><label>Motivo <span class="req">*</span></label><select id="nao-motivo"><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Observações</label><textarea id="nao-obs" placeholder="Detalhes sobre o não cumprimento"></textarea></div>
          <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" id="nao-data" value="${atrib.dataProgramada}"></div>
          <div class="field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="nao-editar" style="width:auto;"><label style="margin:0;" for="nao-editar">Também quero editar as atividades / quantidades desta equipe</label></div>
          <div id="nao-editor" style="display:none;"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="c-back2">← Voltar</button><button type="button" class="btn btn-primary" id="c-reprogramar">Reprogramar</button></div>`;
    }
    root.innerHTML = `<div class="modal-overlay" id="modal-overlay-conf"><div class="modal" style="${step==='visualizar'?'max-width:820px;':''}"><div class="modal-head"><h3>Confirmação de execução</h3></div>${inner}</div></div>`;
    bind(step);
  }
  function bind(step){
    if(step==='question'){
      document.getElementById('c-visualizar').addEventListener('click', ()=>renderStep('visualizar'));
      document.getElementById('c-sim').addEventListener('click', ()=>renderStep('sim'));
      document.getElementById('c-nao').addEventListener('click', ()=>renderStep('nao'));
    } else if(step==='visualizar'){
      document.getElementById('c-back-visualizar').addEventListener('click', ()=>renderStep('question'));
    } else if(step==='sim'){
      document.getElementById('c-back').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('c-concluir').addEventListener('click', ()=>{
        const motivo = document.getElementById('sim-motivo').value.trim();
        if(!motivo){ toast('Informe o motivo da conclusão.', 'error'); return; }
        document.querySelectorAll('.exec-qty').forEach(inp=>{ atrib.atividades[Number(inp.dataset.idx)].quantidadeExecutada = parseFloat(inp.value)||0; });
        const de = atrib.status;
        atrib.status='Concluído';
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'confirmacao', de, para:'Concluído', motivo});
        saveData(); root.innerHTML=''; toast('Programação concluída.'); renderContent(); onResolved && onResolved();
      });
    } else if(step==='nao'){
      document.getElementById('c-back2').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('nao-editar').addEventListener('change', (e)=>{
        const box = document.getElementById('nao-editor');
        if(e.target.checked){ box.style.display='block'; box.innerHTML = `<div class="ae-list"></div><button type="button" class="btn btn-sm btn-ghost" id="ae-add" style="margin-top:6px;">${icon('plus',13)} Adicionar atividade</button>`;
          editor = createActivityEditorInline(box.querySelector('.ae-list'), atrib.atividades);
          document.getElementById('ae-add').addEventListener('click', ()=>editor.addRow());
        } else { box.style.display='none'; box.innerHTML=''; editor=null; }
      });
      document.getElementById('c-reprogramar').addEventListener('click', ()=>{
        const motivo = document.getElementById('nao-motivo').value;
        const obs = document.getElementById('nao-obs').value.trim();
        const novaData = document.getElementById('nao-data').value;
        if(!motivo || !novaData){ toast('Preencha motivo e nova data.', 'error'); return; }
        const dataAntiga = atrib.dataProgramada;
        atrib.dataProgramada = novaData;
        atrib.status = 'Reprogramado';
        if(editor){ const data = editor.getData(); if(data.length) atrib.atividades = data.map(d=>({...d, quantidadeExecutada:null})); }
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
        saveData(); root.innerHTML=''; toast('Programação reprogramada.'); renderContent(); onResolved && onResolved();
      });
    }
  }
  renderStep('question');
}

/* =========================================================
   MODAL DE CONFIRMAÇÃO — PODA (bloqueante)
========================================================= */
function openPodaConfirmacaoModal(prog, atrib, onResolved){
  const root = document.getElementById('modal-root');
  const eq = findEquipe(atrib.equipeId);

  function activitiesSummaryHtml(){
    return (atrib.atividades||[]).map(a=>{ const at=findAtividade(a.atividadeId); return `${esc(at?.codigo||'')} · ${esc(at?.descricao||'')} <span style="color:var(--muted-2);">(${a.quantidadePrevista??'-'} previsto)</span>`; }).join('<br>');
  }

  function renderStep(step){
    let inner='';
    if(step==='question'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Programação de poda vencida — equipe <strong>${equipeLabel(eq)}</strong> — data prevista ${fmtDate(atrib.dataProgramada)}</div>
          <div style="margin:10px 0;font-size:13px;line-height:1.7;">${activitiesSummaryHtml()}</div>
          <div class="confirm-question">A PROGRAMAÇÃO FOI EXECUTADA?</div>
        </div>
        <div class="modal-foot" style="justify-content:center;gap:14px;">
          <button type="button" class="btn btn-ghost" id="pc-visualizar">${icon('search',14)} VISUALIZAR</button>
          <button type="button" class="btn btn-danger-solid" id="pc-nao">NÃO</button>
          <button type="button" class="btn btn-primary" id="pc-sim">SIM</button>
        </div>`;
    } else if(step==='visualizar'){
      const detalheHtml = podaDetalheHtml(prog, atrib, false);
      inner = `
        <div class="modal-body">
          <div class="confirm-banner">${icon('alert',15)} Confira os dados e o retorno da equipe antes de responder.</div>
          ${detalheHtml}
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-visualizar">← Voltar à pergunta</button></div>`;
    } else if(step==='sim'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Confirme as quantidades executadas por <strong>${equipeLabel(eq)}</strong>. Você pode manter os valores previstos ou editar antes de concluir.</div>
          ${(atrib.atividades||[]).map((a,idx)=>{ const at=findAtividade(a.atividadeId);
            return `<div class="field"><label>${esc(at?.codigo||'')} · ${esc(at?.descricao||'')}</label><input type="number" step="0.01" class="exec-qty" data-idx="${idx}" value="${a.quantidadeExecutada ?? a.quantidadePrevista ?? ''}"></div>`;
          }).join('')}
          <div class="field"><label>Motivo da conclusão <span class="req">*</span></label><input type="text" id="psim-motivo" maxlength="200" placeholder="Ex.: poda executada conforme programado"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-sim">← Voltar</button><button type="button" class="btn btn-primary" id="pc-concluir">Manter/editar e concluir</button></div>`;
    } else if(step==='nao'){
      inner = `
        <div class="modal-body">
          <div class="field"><label>Motivo <span class="req">*</span></label><select id="pnao-motivo"><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Observações</label><textarea id="pnao-obs" placeholder="Detalhes sobre o não cumprimento"></textarea></div>
          <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" id="pnao-data" value="${atrib.dataProgramada}"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-nao">← Voltar</button><button type="button" class="btn btn-primary" id="pc-reprogramar">Reprogramar</button></div>`;
    }
    root.innerHTML = `<div class="modal-overlay" id="modal-overlay-conf"><div class="modal" style="${step==='visualizar'?'max-width:820px;':''}"><div class="modal-head"><h3>Confirmação de execução — Poda</h3></div>${inner}</div></div>`;
    bind(step);
  }
  function bind(step){
    if(step==='question'){
      document.getElementById('pc-visualizar').addEventListener('click', ()=>renderStep('visualizar'));
      document.getElementById('pc-sim').addEventListener('click', ()=>renderStep('sim'));
      document.getElementById('pc-nao').addEventListener('click', ()=>renderStep('nao'));
    } else if(step==='visualizar'){
      document.getElementById('pc-back-visualizar').addEventListener('click', ()=>renderStep('question'));
    } else if(step==='sim'){
      document.getElementById('pc-back-sim').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('pc-concluir').addEventListener('click', ()=>{
        const motivo = document.getElementById('psim-motivo').value.trim();
        if(!motivo){ toast('Informe o motivo da conclusão.', 'error'); return; }
        document.querySelectorAll('.exec-qty').forEach(inp=>{ atrib.atividades[Number(inp.dataset.idx)].quantidadeExecutada = parseFloat(inp.value)||0; });
        const de = atrib.status;
        atrib.status='Concluído';
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'confirmacao', de, para:'Concluído', motivo});
        registrarEvento('confirmacao','programacao',prog.id,podaProgLabel(prog),'Execução confirmada — '+motivo);
        saveData(); root.innerHTML=''; toast('Programação de poda concluída.'); renderContent(); onResolved && onResolved();
      });
    } else if(step==='nao'){
      document.getElementById('pc-back-nao').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('pc-reprogramar').addEventListener('click', ()=>{
        const motivo = document.getElementById('pnao-motivo').value;
        const obs = document.getElementById('pnao-obs').value.trim();
        const novaData = document.getElementById('pnao-data').value;
        if(!motivo || !novaData){ toast('Preencha motivo e nova data.', 'error'); return; }
        const dataAntiga = atrib.dataProgramada;
        atrib.dataProgramada = novaData;
        atrib.status = 'Reprogramado';
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
        registrarEvento('reprogramacao','programacao',prog.id,podaProgLabel(prog),'Reprogramada de '+dataAntiga+' para '+novaData+' — '+motivo);
        saveData(); root.innerHTML=''; toast('Programação de poda reprogramada.'); renderContent(); onResolved && onResolved();
      });
    }
  }
  renderStep('question');
}

/* =========================================================
   VIEW: DASHBOARD
========================================================= */
function renderDashboard(){
  const el = document.getElementById('content');
  const hoje = todayISO();
  const cicloAtivo = progFilters.ciclo || cicloPadrao();
  const flat = flatPorCicloPadrao();
  const flatTudo = flatAtribuicoes();
  const eqs = equipesVisiveis();
  const equipesAtivas = eqs.filter(e=>e.ativo).length;
  const ps = projetosVisiveis();
  const projetosAndamento = ps.filter(p=>p.status==='Em Andamento').length;
  // "Programado p/ hoje" conta todas as atribuições do dia, em qualquer ciclo (visibilidade por setor/coordenação mantida)
  const progHoje = flatTudo.filter(x=> x.atribuicao.dataProgramada===hoje && x.atribuicao.status!=='Cancelado').length;
  const atrasadas = flat.filter(x=> isLate(x.atribuicao)).length;
  const concluidas = flat.filter(x=> x.atribuicao.status==='Concluído').length;
  const valorOrcadoTotal = ps.reduce((s,p)=> s + (p.valorOrcado||0), 0);
  const valorExecutadoTotal = ps.reduce((s,p)=> s + projetoAvanco(p).valorExecutado, 0);

  const proximas = flat.filter(x=>!['Concluído','Cancelado'].includes(x.atribuicao.status))
    .sort((a,b)=> a.atribuicao.dataProgramada.localeCompare(b.atribuicao.dataProgramada)).slice(0,7);

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      <span style="font-size:12px;color:var(--muted);">Filtro padrão:</span>
      <span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);font-size:11px;">${cicloAtivo? 'Ciclo '+cicloAtivo : 'Todos os ciclos'}</span>
      ${cicloAtivo? `<span style="font-size:11.5px;color:var(--muted-2);">maior ciclo cadastrado com programações concluídas — vale para todas as telas com filtro</span>`:''}
    </div>
    <div class="grid-stats">
      <div class="stat-card clickable" data-go="equipes" style="--accent-c:var(--blue)"><div class="lbl">Equipes ativas</div><div class="val">${equipesAtivas}<small> / ${eqs.length}</small></div></div>
      <div class="stat-card clickable" data-go="projetos" style="--accent-c:var(--teal)"><div class="lbl">Projetos em andamento</div><div class="val">${projetosAndamento}<small> / ${ps.length}</small></div></div>
      <div class="stat-card clickable" data-go="hoje" style="--accent-c:var(--accent)"><div class="lbl">Programado p/ hoje</div><div class="val">${progHoje}</div></div>
      <div class="stat-card clickable" data-go="vencidas" style="--accent-c:var(--red)"><div class="lbl">Vencidas (aguardando confirmação)</div><div class="val">${atrasadas}</div></div>
      <div class="stat-card clickable" data-go="concluidas" style="--accent-c:var(--green)"><div class="lbl">Programações concluídas</div><div class="val">${concluidas}</div></div>
      <div class="stat-card clickable" data-go="avanco" style="--accent-c:var(--purple)"><div class="lbl">Orçado × executado</div><div class="val" style="font-size:19px;">${fmtMoney(valorExecutadoTotal)}<small style="font-size:10.5px;"> de ${fmtMoney(valorOrcadoTotal)}</small></div></div>
    </div>
    <div class="panel section-gap">
      <div class="panel-head"><h3>Próximas programações</h3><button class="btn btn-sm btn-ghost" id="go-prog">Ver todas →</button></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Data</th><th>Projeto</th><th>Equipe</th><th>Equipe comp.</th><th>Atividades</th><th>Valor prev.</th><th>Status</th></tr></thead>
        <tbody>
          ${proximas.length? proximas.map(x=>{
            const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId), late=isLate(p);
            const valPrev = p.atividades.reduce((s,a)=> s + (a.quantidadePrevista||0)*(findAtividade(a.atividadeId)?.valorUnitario||0), 0);
            return `<tr class="clickable-row" data-open-prog="${p.id}" title="Abrir detalhes">
              <td class="mono">${fmtDate(p.dataProgramada)} ${late?`<div class="blink-red" style="font-size:10.5px;color:var(--red);">VENCIDA</div>`:''}</td>
              <td><strong>${esc(pr?.codigo||'—')}</strong><div style="color:var(--muted-2);font-size:11px;">${esc(pr?.nome||'')}</div></td>
              <td><span class="badge-prefix">${eqtlLabel(eq)}</span></td>
              <td><span class="badge-prefix">${prtnLabel(eq)}</span></td>
              <td style="font-size:12px;color:var(--muted);">${atividadesResumo(p.atividades)}</td>
              <td class="mono">${fmtMoney(valPrev)}</td>
              <td>${statusBadge(p.status, late)}${teamBadgeHtml(p)? `<div style="margin-top:4px;">${teamBadgeHtml(p)}</div>`:''}</td>
            </tr>`;
          }).join('') : `<tr class="empty-row"><td colspan="7">Nenhuma programação futura cadastrada no ciclo ${cicloAtivo||'atual'}.</td></tr>`}
        </tbody>
      </table></div>
    </div>
    ${renderProjetosProgressPanel()}
    <div class="panel"><div class="panel-head"><h3>Atividade recente</h3></div>${renderHistoricoTimeline(globalHistorico().slice(0,6), true)}</div>
  `;
  el.querySelectorAll('.stat-card.clickable').forEach(c=>c.addEventListener('click', ()=>{
    const go = c.dataset.go;
    if(go==='hoje'){ progFilters.projeto=''; progFilters.equipe=''; progFilters.status=''; progFilters.ciclo=''; progFilters.dataDe=todayISO(); progFilters.dataAte=todayISO(); progFilters.modo='calendario'; progFilters.calView='dia'; progFilters.calDay=todayISO(); setView('programacoes'); }
    else if(go==='vencidas'){ progFilters.modo='fluxo'; setView('programacoes'); }
    else if(go==='concluidas'){ progFilters.status='Concluído'; progFilters.modo='lista'; setView('programacoes'); }
    else if(go==='avanco'){ setView('avanco'); }
    else setView(go);
  }));
  el.querySelectorAll('[data-open-prog]').forEach(r=>r.addEventListener('click', ()=>openAtribDetalhe(r.dataset.openProg)));
  el.querySelectorAll('[data-open-atrib]').forEach(r=>r.addEventListener('click', ()=>openAtribDetalhe(r.dataset.openAtrib)));
  document.getElementById('go-prog').addEventListener('click', ()=> setView('programacoes'));
  const goAvanc = el.querySelector('#go-avanco'); if(goAvanc) goAvanc.addEventListener('click', ()=> setView('avanco'));
}

/* =========================================================
   VIEW: ALERTAS (vencimento, reprogramações, viabilidade)
========================================================= */
function renderAlertas(){
  const el = document.getElementById('content');
  const hoje = todayISO();
  const ativos = p=> !['Concluído','Cancelado'].includes(p.status);
  const ps = projetosVisiveis();

  const projetosVencendo = ps.filter(p=> p.dataVencimento && ativos(p) && p.dataVencimento <= shiftISO(hoje, ALERT_VENCER_DIAS))
    .map(p=>({ p, dias: diasEntre(hoje, p.dataVencimento) }))
    .sort((a,b)=> a.p.dataVencimento.localeCompare(b.p.dataVencimento));
  const vencidos = projetosVencendo.filter(x=>x.dias<0);
  const venceHoje = projetosVencendo.filter(x=>x.dias===0);

  const reprog = flatAtribuicoes().filter(x=>x.atribuicao.status==='Reprogramado');

  const viabilidade = ps.filter(p=> p.dataRecebimentoCarteira && ativos(p)).map(p=>{
    const prazo = prazoViabilidadeProjeto(p);
    return { p, prazo, viabilizado: !!p.dataViabilizacao, dias: diasEntre(hoje, prazo) };
  }).sort((a,b)=> a.prazo.localeCompare(b.prazo));
  const viabVencidos = viabilidade.filter(x=>!x.viabilizado && x.dias<0);

  const proj100 = ps.filter(p=> !['Encerrado','Cancelado'].includes(p.status)).map(p=>({ p, av: projetoAvanco(p) }))
    .filter(x=> x.av.fisicoPct>=100 || x.av.financeiroPct>=100);

  el.innerHTML = `
    <div class="grid-stats">
      <div class="stat-card" style="--accent-c:var(--red)"><div class="lbl">Projetos em 100%</div><div class="val">${proj100.length}</div></div>
      <div class="stat-card" style="--accent-c:var(--red)"><div class="lbl">Projetos vencidos</div><div class="val">${vencidos.length}</div></div>
      <div class="stat-card" style="--accent-c:var(--accent)"><div class="lbl">Vencimento hoje</div><div class="val">${venceHoje.length}</div></div>
      <div class="stat-card" style="--accent-c:var(--purple)"><div class="lbl">Reprogramações pendentes</div><div class="val">${reprog.length}</div></div>
      <div class="stat-card" style="--accent-c:var(--red)"><div class="lbl">Viabilização em atraso</div><div class="val">${viabVencidos.length}</div></div>
    </div>
    ${renderAlertasCemPanel(proj100)}
    ${renderAlertasProjetosPanel(projetosVencendo)}
    ${renderAlertasReprogsPanel(reprog)}
    ${renderAlertasViabilidadePanel(viabilidade)}
  `;
  el.querySelectorAll('[data-avanco-alerta]').forEach(b=>b.addEventListener('click', ()=>openAvancoDetalhe(b.dataset.avancoAlerta)));
  el.querySelectorAll('[data-edit-alerta]').forEach(b=>b.addEventListener('click', ()=>openProjetoModal(b.dataset.editAlerta)));
  el.querySelectorAll('[data-encerrar-alerta]').forEach(b=>b.addEventListener('click', ()=>encerrarProjeto(b.dataset.encerrarAlerta)));
}
function renderAlertasCemPanel(list){
  return `<div class="panel section-gap" style="border-color:var(--red);">
    <div class="panel-head"><h3>Projetos com 100% de avanço — aguardando encerramento</h3><span style="font-size:12px;color:var(--muted);">${list.length} projeto(s)</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Código</th><th>Projeto</th><th>Avanço físico</th><th>Avanço financeiro</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.length? list.map(({p,av})=>`<tr>
        <td class="mono">${esc(p.codigo)}</td>
        <td><strong>${esc(p.nome)}</strong><div style="color:var(--muted-2);font-size:11px;">${esc(p.cidade||'')} · ${esc(p.setor||'')}</div></td>
        <td>${av.fisicoPct.toFixed(1)}%</td>
        <td>${av.financeiroPct.toFixed(1)}%</td>
        <td>${projStatusBadge(p.status)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" title="Ver avanço" data-avanco-alerta="${p.id}">${icon('trend',14)}</button>
          <button class="btn btn-sm btn-danger-solid" data-encerrar-alerta="${p.id}">${icon('check',13)} Encerrar projeto</button>
        </div></td>
      </tr>`).join('') : `<tr class="empty-row"><td colspan="6">Nenhum projeto em 100% de avanço.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}
function renderAlertasProjetosPanel(list){
  return `<div class="panel section-gap">
    <div class="panel-head"><h3>Projetos vencendo (próximos ${ALERT_VENCER_DIAS} dias)</h3><span style="font-size:12px;color:var(--muted);">${list.length} projeto(s)</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Código</th><th>Projeto</th><th>Receb. carteira</th><th>Vencimento</th><th>Prazo</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.length? list.map(({p,dias})=>{
        const c = dias<0? 'var(--red)' : dias<=ALERT_VIAB_BREVE_DIAS? 'var(--accent)' : 'var(--muted)';
        const prazoTxt = dias<0? `VENCIDO há ${-dias} dia(s)` : dias===0? 'Vence hoje' : `Vence em ${dias} dia(s)`;
        return `<tr>
          <td class="mono">${esc(p.codigo)}</td>
          <td><strong>${esc(p.nome)}</strong></td>
          <td class="mono">${fmtDate(p.dataRecebimentoCarteira)}</td>
          <td class="mono">${fmtDate(p.dataVencimento)}</td>
          <td><span class="badge ${dias<0?'blink-red':''}" style="color:${c};background:${bgFromVar(c)};">${prazoTxt}</span></td>
          <td>${projStatusBadge(p.status)}</td>
          <td><div class="row-actions">
            <button class="icon-btn" title="Ver avanço" data-avanco-alerta="${p.id}">${icon('trend',14)}</button>
            <button class="icon-btn" title="Editar projeto" data-edit-alerta="${p.id}">${icon('edit',14)}</button>
          </div></td>
        </tr>`;
      }).join('') : `<tr class="empty-row"><td colspan="7">Nenhum projeto vencendo nos próximos ${ALERT_VENCER_DIAS} dias.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}
function renderAlertasReprogsPanel(list){
  return `<div class="panel section-gap">
    <div class="panel-head"><h3>Reprogramações pendentes</h3><span style="font-size:12px;color:var(--muted);">${list.length} programação(ões)</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Data atual</th><th>Projeto</th><th>Equipe</th><th>Último motivo</th><th>Vezes</th><th>Status</th></tr></thead>
      <tbody>${list.length? list.map(x=>{
        const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId);
        const reprogs = (p.historico||[]).filter(h=>h.tipo==='reprogramacao');
        const last = reprogs[reprogs.length-1];
        const late = isLate(p);
        return `<tr>
          <td class="mono">${fmtDate(p.dataProgramada)} ${late?`<div class="blink-red" style="font-size:10.5px;color:var(--red);">NOVAMENTE VENCIDA</div>`:''}</td>
          <td><strong>${esc(pr?.codigo||'—')}</strong><div style="color:var(--muted-2);font-size:11px;">${esc(pr?.nome||'')}</div></td>
          <td>${equipeLabel(eq)}</td>
          <td style="font-size:12px;color:var(--muted);">${esc(last?.motivo||'—')}${last?.obs? ' — '+esc(last.obs):''}</td>
          <td class="mono">${reprogs.length}</td>
          <td>${statusBadge(p.status)}</td>
        </tr>`;
      }).join('') : `<tr class="empty-row"><td colspan="6">Nenhuma reprogramação pendente.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}
function renderAlertasViabilidadePanel(list){
  return `<div class="panel">
    <div class="panel-head"><h3>Viabilidade (prazo de ${ALERT_VIABILIDADE_DIAS} dias corridos após recebimento da carteira)</h3><span style="font-size:12px;color:var(--muted);">${list.length} projeto(s)</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Código</th><th>Projeto</th><th>Receb. carteira</th><th>Prazo limite</th><th>Situação</th><th>Data viabilização</th><th></th></tr></thead>
      <tbody>${list.length? list.map(({p,prazo,viabilizado,dias})=>{
        let situacao, c;
        if(viabilizado){
          const dentro = p.dataViabilizacao && p.dataViabilizacao<=prazo;
          situacao = dentro? 'Viabilizado dentro do prazo' : 'Viabilizado fora do prazo';
          c = dentro? 'var(--green)' : 'var(--accent)';
        } else if(dias<0){
          situacao = `Prazo vencido há ${-dias} dia(s)`; c='var(--red)';
        } else if(dias<=ALERT_VIAB_BREVE_DIAS){
          situacao = `Vence em ${dias} dia(s)`; c='var(--accent)';
        } else {
          situacao = `${dias} dia(s) restantes`; c='var(--muted)';
        }
        return `<tr>
          <td class="mono">${esc(p.codigo)}</td>
          <td><strong>${esc(p.nome)}</strong></td>
          <td class="mono">${fmtDate(p.dataRecebimentoCarteira)}</td>
          <td class="mono">${fmtDate(prazo)}</td>
          <td><span class="badge ${(!viabilizado && dias<0)?'blink-red':''}" style="color:${c};background:${bgFromVar(c)};">${situacao}</span></td>
          <td class="mono">${fmtDate(p.dataViabilizacao)}</td>
          <td><div class="row-actions"><button class="icon-btn" title="Editar projeto" data-edit-alerta="${p.id}">${icon('edit',14)}</button></div></td>
        </tr>`;
      }).join('') : `<tr class="empty-row"><td colspan="7">Nenhum projeto com data de recebimento de carteira.</td></tr>`}</tbody>
    </table></div>
  </div>`;
}

/* =========================================================
   VIEW: EQUIPES
========================================================= */
function renderEquipes(){
  const el = document.getElementById('content');
  const visiveis = equipesVisiveis();
  if(!visiveis.length){ el.innerHTML = emptyState('Nenhuma equipe cadastrada', 'Cadastre equipes de campo informando o nome da equipe, supervisor, encarregado, motorista, meta diária e eletricistas.'); bindEmptyCta(el, ()=>openEquipeModal()); return; }
  const list = visiveis.filter(e=>{
    if(equipeFilters.status==='ativa' && !e.ativo) return false;
    if(equipeFilters.status==='inativa' && e.ativo) return false;
    if(equipeFilters.q){ const t=(e.eqtl+' '+(e.prtn||'')+' '+(e.setor||'')+' '+(e.coordenacao||'')+' '+(e.supervisor||'')+' '+(e.encarregado||'')+' '+(e.motorista||'')+' '+(e.eletricistas||[]).join(' ')).toLowerCase(); if(!t.includes(equipeFilters.q.toLowerCase())) return false; }
    return true;
  });
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <input id="f-eq-q" placeholder="Buscar equipe (nome, supervisor, encarregado…)…" value="${esc(equipeFilters.q)}">
        <select id="f-eq-status"><option value="">Todas as situações</option><option value="ativa" ${equipeFilters.status==='ativa'?'selected':''}>Ativas</option><option value="inativa" ${equipeFilters.status==='inativa'?'selected':''}>Inativas</option></select>
      </div>
      <span style="font-size:12px;color:var(--muted);">${list.length} de ${visiveis.length} equipes</span>
    </div>
    ${list.length? `<div class="grid-crews">${list.map(crewCard).join('')}</div>` : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhuma equipe encontrada com os filtros.</p></div></div>`}`;
  document.getElementById('f-eq-q').addEventListener('input', e=>{ equipeFilters.q=e.target.value; renderContent(); });
  document.getElementById('f-eq-status').addEventListener('change', e=>{ equipeFilters.status=e.target.value; renderContent(); });
  el.querySelectorAll('[data-edit-equipe]').forEach(b=>b.addEventListener('click', ()=>openEquipeModal(b.dataset.editEquipe)));
  el.querySelectorAll('[data-del-equipe]').forEach(b=>b.addEventListener('click', ()=>deleteEquipe(b.dataset.delEquipe)));
}
function crewCard(eq){
  const eletricistas = (eq.eletricistas||[]).filter(Boolean);
  const customFields = DB.customFields.equipes||[];
  return `
  <div class="crew-card">
    <div class="crew-card-head">
      <div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${eq.eqtl? `<span class="badge-prefix">${esc(eq.eqtl)}</span>`:''}
          ${eq.prtn? `<span class="badge-prefix alt">${esc(eq.prtn)}</span>`:''}
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--muted);"><span class="crew-status-dot ${eq.ativo?'':'off'}"></span>${eq.ativo? 'Ativa':'Inativa'}${eq.setor||eq.coordenacao? ' · '+esc([eq.setor,eq.coordenacao].filter(Boolean).join(' / ')):''}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-edit-equipe="${eq.id}">${icon('edit',14)}</button>
        <button class="icon-btn" data-del-equipe="${eq.id}">${icon('trash',14)}</button>
      </div>
    </div>
    <div class="crew-roles">
      <div class="crew-role"><span class="r-lbl">Supervisor</span><span class="r-val">${esc(eq.supervisor||'—')}</span></div>
      <div class="crew-role"><span class="r-lbl">Encarregado</span><span class="r-val">${esc(eq.encarregado||'—')}</span></div>
      <div class="crew-role"><span class="r-lbl">Motorista</span><span class="r-val">${esc(eq.motorista||'—')}</span></div>
      <div class="crew-role"><span class="r-lbl">WhatsApp</span><span class="r-val">${eq.whatsapp? `<a href="${esc(waLink(eq.whatsapp, 'Olá!'))}" target="_blank" rel="noopener" style="color:var(--green);font-weight:600;">${esc(eq.whatsapp)}</a>` : '—'}</span></div>
      <div class="crew-role"><span class="r-lbl">Meta diária</span><span class="r-val mono">${metaDiaria(eq)? fmtMoney(metaDiaria(eq)) : '—'}</span></div>
      <div class="crew-role"><span class="r-lbl">Eletricistas</span><span class="r-val">${eletricistas.length? esc(eletricistas.join(', ')) : '—'}</span></div>
      ${customFields.map(f=>`<div class="crew-role"><span class="r-lbl">${esc(f.label)}</span><span class="r-val">${esc(eq.custom?.[f.id]||'—')}</span></div>`).join('')}
    </div>
  </div>`;
}
    function openEquipeModal(id){
      if(!requerEscrita()) return;
      const eq = id ? findEquipe(id) : null;
  const body = `
    <div class="field-row">
      <div class="field"><label>Nome da equipe <span class="req">*</span></label><input type="text" name="eqtl" value="${esc(eq?.eqtl||'')}" placeholder="Ex: Equipe Alfa"></div>
      <div class="field"><label>Nome complementar</label><input type="text" name="prtn" value="${esc(eq?.prtn||'')}" placeholder="Ex: Equipe Bravo"></div>
    </div>
    <div class="field-hint" style="margin-top:-6px;">Preencha ao menos um dos nomes da equipe.</div>
    <div class="field"><label>Supervisor</label><input type="text" name="supervisor" value="${esc(eq?.supervisor||'')}" placeholder="Nome do supervisor"></div>
    <div class="field"><label>Encarregado</label><input type="text" name="encarregado" value="${esc(eq?.encarregado||'')}" placeholder="Nome do encarregado"></div>
    <div class="field"><label>Motorista</label><input type="text" name="motorista" value="${esc(eq?.motorista||'')}" placeholder="Nome do motorista"></div>
    <div class="field"><label>WhatsApp</label><input type="text" name="whatsapp" value="${esc(eq?.whatsapp||'')}" placeholder="Ex: (11) 98765-4321" inputmode="tel"><div class="field-hint">💡 Usado no botão "Encaminhar para equipe" das programações. Informe com DDD.</div></div>
    <div class="field"><label>Meta diária (R$)</label><input type="number" step="0.01" min="0" name="metaDiaria" value="${eq?.metaDiaria??''}" placeholder="0,00"><div class="field-hint">💡 Se a programação do dia ficar abaixo deste valor, o sistema alerta na programação.</div></div>
    <div class="field"><label>Eletricistas</label><input type="text" name="eletricistas" value="${esc((eq?.eletricistas||[]).join(', '))}" placeholder="Separe por vírgula: Fulano, Ciclano"><div class="field-hint">💡 Separe os nomes por vírgula.</div></div>
    <div class="field-row">
      <div class="field"><label>Setor <span class="req">*</span></label><select name="setor" required><option value="">Selecione…</option><option ${eq?.setor==='MANUTENÇÃO'||(usuarioRestrito()&&CURRENT_USER.setor==='MANUTENÇÃO')?'selected':''}>MANUTENÇÃO</option><option ${eq?.setor==='OBRAS'||(usuarioRestrito()&&CURRENT_USER.setor==='OBRAS')?'selected':''}>OBRAS</option></select><div class="field-hint">💡 Vincular a equipe ao setor onde ela atua.</div></div>
      <div class="field"><label>Coordenação <span class="req">*</span></label><select name="coordenacao" required><option value="">Selecione…</option><option ${eq?.coordenacao==='RIO VERDE'||(usuarioRestrito()&&CURRENT_USER.coordenacao==='RIO VERDE')?'selected':''}>RIO VERDE</option><option ${eq?.coordenacao==='QUIRINOPOLIS'||(usuarioRestrito()&&CURRENT_USER.coordenacao==='QUIRINOPOLIS')?'selected':''}>QUIRINOPOLIS</option></select><div class="field-hint">💡 Vincular a equipe à coordenação onde ela atua.</div></div>
    </div>
    ${renderCustomFieldsInputs('equipes', eq)}
    <div class="field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="ativo" id="eq-ativo" style="width:auto;" ${eq? (eq.ativo?'checked':'') : 'checked'}><label for="eq-ativo" style="margin:0;">Equipe ativa</label></div>
  `;
  openModal({
    title: eq? `Editar equipe` : 'Nova equipe', bodyHtml: body, submitLabel: eq? 'Salvar alterações' : 'Cadastrar equipe',
    onSubmit:(fd)=>{
      const eqtl = fd.get('eqtl').trim(), prtn = fd.get('prtn').trim();
      if(!eqtl && !prtn){ toast('Preencha ao menos o nome da equipe.', 'error'); return false; }
      if(!fd.get('setor') || !fd.get('coordenacao')){ toast('Selecione o setor e a coordenação da equipe.', 'error'); return false; }
      const setor = usuarioRestrito()? CURRENT_USER.setor : fd.get('setor');
      const coordenacao = usuarioRestrito()? CURRENT_USER.coordenacao : fd.get('coordenacao');
      const data = { eqtl, prtn, setor, coordenacao, supervisor: fd.get('supervisor').trim(), encarregado: fd.get('encarregado').trim(), motorista: fd.get('motorista').trim(), whatsapp: fd.get('whatsapp').trim(), metaDiaria: parseFloat(fd.get('metaDiaria'))||0,
        eletricistas: fd.get('eletricistas').split(',').map(s=>s.trim()).filter(Boolean), ativo: fd.get('ativo')==='on', custom: parseCustomFieldsFromForm('equipes', fd) };
      if(eq){ Object.assign(eq, data); toast('Equipe atualizada.'); registrarEvento('edicao','equipe',eq.id,eq.eqtl||eq.prtn,'Equipe atualizada'); }
      else { data.id = nextId(); DB.equipes.push(data); toast('Equipe cadastrada.'); registrarEvento('criacao','equipe',data.id,data.eqtl||data.prtn,'Equipe criada · '+data.setor); }
      saveData(); renderContent();
    }
  });
}
    function deleteEquipe(id){
      if(!requerEscrita()) return;
      id = Number(id);
  const inUse = flatAtribuicoes().some(x=>x.atribuicao.equipeId===id);
  if(inUse && !ehMestre()){ toast('Equipe possui programações vinculadas. Remova ou reatribua antes de excluir.', 'error'); return; }
  if(inUse){
    if(!confirm('Excluir esta equipe e REMOVER esta equipe de todas as programações vinculadas?\n\nEsta ação não pode ser desfeita.')) return;
  } else {
    if(!confirm('Excluir esta equipe?')) return;
  }
  DB.equipes = DB.equipes.filter(e=>e.id!==id);
  DB.programacoes.forEach(pg=>{ pg.atribuicoes = (pg.atribuicoes||[]).filter(a=>a.equipeId!==id); });
  DB.programacoes = DB.programacoes.filter(pg=>(pg.atribuicoes||[]).length);
  registrarEvento('exclusao','equipe',id,equipeLabel(findEquipe(id)),'Equipe excluída'+(inUse? ' e removida das programações':''));
  saveData(); renderContent(); toast('Equipe excluída.');
}

/* =========================================================
   VIEW: ATIVIDADES
========================================================= */
function renderAtividades(){
  const el = document.getElementById('content');
  if(!DB.atividades.length){ el.innerHTML = emptyState('Nenhuma atividade cadastrada', 'Cadastre as atividades executadas em campo com código, descrição e valor unitário.'); bindEmptyCta(el, ()=>openAtividadeModal()); return; }
  const customFields = DB.customFields.atividades||[];
  const list = atividadesOrdenadas().filter(a=>{
    if(ativFilters.fav==='fav' && !isFavorita(a.id)) return false;
    if(ativFilters.fav==='normal' && isFavorita(a.id)) return false;
    if(ativFilters.q){ const t=(a.codigo+' '+(a.descricao||'')).toLowerCase(); if(!t.includes(ativFilters.q.toLowerCase())) return false; }
    return true;
  });
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <div class="search-wrap"><span class="search-ic">${icon('search',14)}</span><input id="f-at-q" type="search" placeholder="Buscar por código ou descrição…" value="${esc(ativFilters.q)}"><button type="button" class="search-clear" id="f-at-q-clear" title="Limpar busca">${icon('close',12)}</button></div>
        <select id="f-at-fav"><option value="">Todas</option><option value="fav" ${ativFilters.fav==='fav'?'selected':''}>★ Favoritas</option><option value="normal" ${ativFilters.fav==='normal'?'selected':''}>Sem estrela</option></select>
      </div>
      <span style="font-size:12px;color:var(--muted);">${ativFilters.q? 'Encontradas ':'Total '}<strong style="color:var(--accent);">${list.length}</strong> de ${DB.atividades.length} atividades</span>
    </div>
    <div class="panel"><div class="table-scroll"><table>
      <thead><tr><th>Fav.</th><th>Código</th><th>Descrição</th><th>Unidade</th><th>Valor unitário</th>${customFields.map(f=>`<th>${esc(f.label)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${list.map(a=>`<tr>
        <td><button class="icon-btn ${isFavorita(a.id)?'fav':'star-off'}" title="${isFavorita(a.id)?'Favorita':'Marcar favorita'}" data-fav-at="${a.id}">${icon('star',15)}</button></td>
        <td><span class="mono" style="color:var(--accent);font-weight:700;">${hl(a.codigo, ativFilters.q)}</span></td>
        <td>${hl(a.descricao, ativFilters.q)}</td><td>${esc(a.unidade||'—')}</td><td class="mono">${fmtMoney(a.valorUnitario)}</td>
        ${customFields.map(f=>`<td>${esc(a.custom?.[f.id]||'—')}</td>`).join('')}
        <td><div class="row-actions"><button class="icon-btn" data-edit-at="${a.id}">${icon('edit',14)}</button><button class="icon-btn" data-del-at="${a.id}">${icon('trash',14)}</button></div></td>
      </tr>`).join('') || `<tr class="empty-row"><td colspan="${6+customFields.length}">Nenhuma atividade encontrada para "${esc(ativFilters.q)}".</td></tr>`}
      </tbody></table></div></div>`;
  document.getElementById('f-at-q').addEventListener('input', e=>{ ativFilters.q=e.target.value; renderContent(); });
  document.getElementById('f-at-q').addEventListener('keydown', e=>{ if(e.key==='Escape'){ ativFilters.q=''; renderContent(); } });
  document.getElementById('f-at-q-clear').addEventListener('click', ()=>{ ativFilters.q=''; renderContent(); });
  document.getElementById('f-at-fav').addEventListener('change', e=>{ ativFilters.fav=e.target.value; renderContent(); });
  el.querySelectorAll('[data-fav-at]').forEach(b=>b.addEventListener('click', ()=>toggleFavAtividade(b.dataset.favAt)));
  el.querySelectorAll('[data-edit-at]').forEach(b=>b.addEventListener('click', ()=>openAtividadeModal(b.dataset.editAt)));
  el.querySelectorAll('[data-del-at]').forEach(b=>b.addEventListener('click', ()=>deleteAtividade(b.dataset.delAt)));
}
    function openAtividadeModal(id){
      if(!requerEscrita()) return;
      const at = id ? findAtividade(id) : null;
  const body = `
    <div class="field-row">
      <div class="field"><label>Código <span class="req">*</span></label><input type="text" name="codigo" required value="${esc(at?.codigo||'')}" placeholder="Ex: MAN-014"></div>
      <div class="field"><label>Unidade</label><input type="text" name="unidade" value="${esc(at?.unidade||'')}" placeholder="un, m, poste..."></div>
    </div>
    <div class="field"><label>Descrição <span class="req">*</span></label><textarea name="descricao" required placeholder="Descrição da atividade">${esc(at?.descricao||'')}</textarea></div>
    <div class="field"><label>Valor unitário (R$) <span class="req">*</span></label><input type="number" step="0.01" min="0" name="valorUnitario" required value="${at?.valorUnitario??''}" placeholder="0,00"></div>
    ${renderCustomFieldsInputs('atividades', at)}
  `;
  openModal({
    title: at? 'Editar atividade' : 'Nova atividade', bodyHtml: body, submitLabel: at? 'Salvar alterações' : 'Cadastrar atividade',
    onSubmit:(fd)=>{
      const codigo = fd.get('codigo').trim();
      const dup = DB.atividades.find(a=>a.codigo.toLowerCase()===codigo.toLowerCase() && a.id!==at?.id);
      if(dup){ toast('Já existe uma atividade com esse código.', 'error'); return false; }
      const data = { codigo, descricao: fd.get('descricao').trim(), unidade: fd.get('unidade').trim(), valorUnitario: parseFloat(fd.get('valorUnitario'))||0, custom: parseCustomFieldsFromForm('atividades', fd) };
      if(at){ Object.assign(at, data); toast('Atividade atualizada.'); registrarEvento('edicao','atividade',at.id,at.codigo+' · '+at.descricao,'Atividade atualizada'); }
      else { data.id = nextId(); DB.atividades.push(data); toast('Atividade cadastrada.'); registrarEvento('criacao','atividade',data.id,data.codigo+' · '+data.descricao,'Atividade criada'); }
      saveData(); renderContent();
    }
  });
}
    function deleteAtividade(id){
      if(!requerEscrita()) return;
      id = Number(id);
  const inUse = flatAtribuicoes().some(x=>x.atribuicao.atividades.some(a=>a.atividadeId===id));
  if(inUse && !ehMestre()){ toast('Atividade possui programações vinculadas. Não é possível excluir.', 'error'); return; }
  if(inUse){
    if(!confirm('Excluir esta atividade de TODAS as programações e planos físicos?\n\nEsta ação não pode ser desfeita.')) return;
  } else {
    if(!confirm('Excluir esta atividade?')) return;
  }
  DB.atividades = DB.atividades.filter(a=>a.id!==id);
  DB.programacoes.forEach(pg=>{ pg.atribuicoes = (pg.atribuicoes||[]).filter(at=>{ at.atividades = (at.atividades||[]).filter(x=>x.atividadeId!==id); return (at.atividades||[]).length; }); });
  DB.programacoes = DB.programacoes.filter(pg=>(pg.atribuicoes||[]).length);
  DB.projetos.forEach(p=>{ p.planoFisico = (p.planoFisico||[]).filter(x=>x.atividadeId!==id); });
  registrarEvento('exclusao','atividade',id,findAtividade(id)? findAtividade(id).codigo+' · '+findAtividade(id).descricao : String(id),'Atividade excluída'+(inUse? ' e removida das programações':''));
  saveData(); renderContent(); toast('Atividade excluída.');
}
function limparTodasAtividades(){
  if(!requerEscrita()) return;
  const total = DB.atividades.length;
  if(!total){ toast('Não há atividades cadastradas para limpar.', 'error'); return; }
  if(!confirm(`EXCLUIR TODAS AS ${total} ATIVIDADES?\n\nAs atividades serão removidas do banco. As programações, equipes e projetos serão MANTIDOS (apenas as atividades das programações e planos físicos serão removidas).\n\nEsta ação não pode ser desfeita!`)) return;
  if(!confirm('Confirmação final: deseja realmente APAGAR todas as atividades do banco de dados?')) return;
  DB.atividades = [];
  DB.programacoes.forEach(pg=>{ (pg.atribuicoes||[]).forEach(at=>{ at.atividades = []; }); });
  DB.projetos.forEach(p=>{ p.planoFisico = []; });
  if(DB.favoritosAtividades) Object.keys(DB.favoritosAtividades).forEach(k=>{ DB.favoritosAtividades[k] = []; });
  registrarEvento('exclusao','atividade',null,null,'Limpeza em massa: todas as atividades excluídas');
  saveData(); renderContent(); toast(`${total} atividade(s) excluída(s).`);
}

/* =========================================================
   VIEW: PROJETOS
========================================================= */
function renderProjetos(){
  const el = document.getElementById('content');
  const visiveis = projetosVisiveis();
  if(!visiveis.length){
    el.innerHTML = `<div class="panel"><div class="empty-state">${icon('empty',36)}<h3 style="margin-bottom:6px;">Nenhum projeto cadastrado</h3><p>Cadastre projetos de construção ou manutenção para agrupar as programações, ou importe em massa a partir de uma planilha.</p><div style="display:flex;gap:10px;margin-top:16px;justify-content:center;flex-wrap:wrap;"><button class="btn btn-primary" id="empty-cta">${icon('plus',15)} Novo projeto</button><button class="btn" id="empty-import">${icon('download',14)} Importar em massa</button></div></div></div>`;
    document.getElementById('empty-cta').addEventListener('click', ()=>openProjetoModal());
    document.getElementById('empty-import').addEventListener('click', ()=>openImportProjetosModal());
    return;
  }
  const customFields = DB.customFields.projetos||[];
  const ciclosPj = [...new Set(visiveis.map(p=>p.ciclo).filter(Boolean))].sort();
  const cidadesPj = [...new Set(visiveis.map(p=>(p.cidade||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const list = visiveis.filter(p=>{
    if(projFilters.status && p.status!==projFilters.status) return false;
    if(projFilters.ciclo && (p.ciclo||'')!==projFilters.ciclo) return false;
    if(projFilters.recebido==='sim' && !p.dataRecebimentoCarteira) return false;
    if(projFilters.recebido==='nao' && p.dataRecebimentoCarteira) return false;
    if(projFilters.cidade && (p.cidade||'').trim().toLowerCase()!==projFilters.cidade.toLowerCase()) return false;
    const ini=p.dataInicio||'', fim=p.dataFim||ini;
    if(projFilters.periodoDe && fim && fim<projFilters.periodoDe) return false;
    if(projFilters.periodoAte && ini && ini>projFilters.periodoAte) return false;
    if(projFilters.q){ const t=(p.codigo+' '+(p.nome||'')+' '+(p.descricao||'')+' '+(p.ciclo||'')+' '+(p.setor||'')+' '+(p.coordenacao||'')+' '+(p.cidade||'')).toLowerCase(); if(!t.includes(projFilters.q.toLowerCase())) return false; }
    return true;
  });
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <input id="f-pj-q" placeholder="Buscar projeto…" value="${esc(projFilters.q)}">
        <select id="f-pj-status"><option value="">Todos os status</option>${STATUS_PROJETO.map(s=>`<option ${projFilters.status===s?'selected':''}>${s}</option>`).join('')}</select>
        <select id="f-pj-ciclo"><option value="">Todos os ciclos</option>${ciclosPj.map(c=>`<option ${projFilters.ciclo===c?'selected':''}>${esc(c)}</option>`).join('')}</select>
        <select id="f-pj-recebido"><option value="">Recebimento: todos</option><option value="sim" ${projFilters.recebido==='sim'?'selected':''}>Carteira recebida</option><option value="nao" ${projFilters.recebido==='nao'?'selected':''}>Não recebida</option></select>
        <select id="f-pj-cidade"><option value="">Todas as cidades</option>${cidadesPj.map(c=>`<option ${projFilters.cidade.toLowerCase()===c.toLowerCase()?'selected':''}>${esc(c)}</option>`).join('')}</select>
        <input type="date" id="f-pj-de" title="Período — de" value="${projFilters.periodoDe}">
        <input type="date" id="f-pj-ate" title="Período — até" value="${projFilters.periodoAte}">
      </div>
      <span style="font-size:12px;color:var(--muted);">${list.length} de ${visiveis.length} projetos</span>
      ${ehMestre()&&projetoSel.size? `<button class="btn btn-danger-solid btn-sm" id="pj-del-massa">${icon('trash',13)} Excluir selecionados (${projetoSel.size})</button>`:''}
    </div>
    <div class="panel"><div class="table-scroll"><table>
      <thead><tr>${ehMestre()? `<th style="width:28px;"><input type="checkbox" id="pj-sel-all" style="width:auto;" title="Selecionar todos"></th>`:''}<th>Código</th><th>Projeto</th><th>Período</th><th>Receb. carteira</th><th>Vencimento</th><th>Setor · Coordenação</th><th>Cidade</th><th>Ciclo</th><th>Orçado</th><th>Avanço</th><th>Status</th><th>Programações</th>${customFields.map(f=>`<th>${esc(f.label)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${list.map(p=>{
      const count = DB.programacoes.filter(x=>x.projetoId===p.id).reduce((s,pg)=>s+(pg.atribuicoes?.length||0),0);
      const av = projetoAvanco(p);
      const aberto = !['Encerrado','Cancelado'].includes(p.status);
      const atingiu100 = aberto && (av.fisicoPct>=100 || av.financeiroPct>=100);
      const alerta = atingiu100? `<tr class="proj-100-alert-row"><td colspan="${(ehMestre()?14:13)+customFields.length}"><div class="proj-100-alert">${icon('alert',14)}<span><strong>Projeto em 100% de avanço</strong> · ${av.fisicoPct.toFixed(1)}% físico · ${av.financeiroPct.toFixed(1)}% financeiro — <span class="blink-red">encerre o projeto</span> para ele deixar de aparecer nas opções de programação.</span><button class="btn btn-sm btn-danger-solid" data-encerrar-pj="${p.id}">${icon('check',13)} Encerrar projeto</button></div></td></tr>`:'';
      return `<tr>
        ${ehMestre()? `<td><input type="checkbox" class="pj-sel" data-id="${p.id}" style="width:auto;" ${projetoSel.has(String(p.id))?'checked':''}></td>`:''}
        <td class="mono">${esc(p.codigo)}</td>
        <td><strong>${esc(p.nome)}</strong><div style="color:var(--muted-2);font-size:11.5px;margin-top:2px;">${esc(p.descricao||'')}</div></td>
        <td class="mono" style="font-size:12px;">${fmtDate(p.dataInicio)} → ${fmtDate(p.dataFim)}</td>
        <td class="mono" style="font-size:12px;">${fmtDate(p.dataRecebimentoCarteira)}${viabilidadeAlertBadge(p)}</td>
        <td class="mono" style="font-size:12px;">${fmtDate(p.dataVencimento)}${vencimentoAlertBadge(p)}</td>
        <td style="font-size:12px;">${esc(p.setor||'—')}<div style="color:var(--muted-2);font-size:11px;">${esc(p.coordenacao||'—')}</div></td>
        <td style="font-size:12px;">${esc(p.cidade||'—')}</td>
        <td><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(p.ciclo||'—')}</span></td>
        <td class="mono">${fmtMoney(p.valorOrcado||0)}</td>
        <td style="min-width:130px;">${progBarHtml(av.fisicoPct,{thin:true})}<div style="font-size:10.5px;color:var(--muted);margin-top:3px;">${av.fisicoPct.toFixed(1)}% · ${av.concluidoLinhas}/${av.totalLinhas}</div></td>
        <td>${projStatusBadge(p.status)}</td><td>${count}</td>
        ${customFields.map(f=>`<td>${esc(p.custom?.[f.id]||'—')}</td>`).join('')}
        <td><div class="row-actions"><button class="icon-btn" title="Imprimir projeto" data-print-pj="${p.id}">${icon('printer',14)}</button><button class="icon-btn" title="Ver avanço" data-avanco-detalhe="${p.id}">${icon('trend',14)}</button><button class="icon-btn" data-edit-pj="${p.id}">${icon('edit',14)}</button><button class="icon-btn" data-del-pj="${p.id}">${icon('trash',14)}</button></div></td>
      </tr>${alerta}`;
    }).join('') || `<tr class="empty-row"><td colspan="${(ehMestre()?14:13)+customFields.length}">Nenhum projeto encontrado com os filtros.</td></tr>`}</tbody></table></div></div>`;
  document.getElementById('f-pj-q').addEventListener('input', e=>{ projFilters.q=e.target.value; renderContent(); });
  document.getElementById('f-pj-status').addEventListener('change', e=>{ projFilters.status=e.target.value; renderContent(); });
  document.getElementById('f-pj-ciclo').addEventListener('change', e=>{ projFilters.ciclo=e.target.value; renderContent(); });
  document.getElementById('f-pj-recebido').addEventListener('change', e=>{ projFilters.recebido=e.target.value; renderContent(); });
  document.getElementById('f-pj-cidade').addEventListener('change', e=>{ projFilters.cidade=e.target.value; renderContent(); });
  document.getElementById('f-pj-de').addEventListener('change', e=>{ projFilters.periodoDe=e.target.value; renderContent(); });
  document.getElementById('f-pj-ate').addEventListener('change', e=>{ projFilters.periodoAte=e.target.value; renderContent(); });
  const selAll = document.getElementById('pj-sel-all');
  if(selAll){
    selAll.checked = list.length>0 && list.every(p=>projetoSel.has(String(p.id)));
    selAll.addEventListener('change', ()=>{ list.forEach(p=>{ const k=String(p.id); if(selAll.checked) projetoSel.add(k); else projetoSel.delete(k); }); renderContent(); });
  }
  el.querySelectorAll('.pj-sel').forEach(cb=> cb.addEventListener('change', ()=>{ const k=cb.dataset.id; if(cb.checked) projetoSel.add(k); else projetoSel.delete(k); renderContent(); }));
  const delMassa = document.getElementById('pj-del-massa');
  if(delMassa) delMassa.addEventListener('click', excluirProjetosEmMassa);
  el.querySelectorAll('[data-avanco-detalhe]').forEach(b=>b.addEventListener('click', ()=>openAvancoDetalhe(b.dataset.avancoDetalhe)));
  el.querySelectorAll('[data-edit-pj]').forEach(b=>b.addEventListener('click', ()=>openProjetoModal(b.dataset.editPj)));
  el.querySelectorAll('[data-del-pj]').forEach(b=>b.addEventListener('click', ()=>deleteProjeto(b.dataset.delPj)));
  el.querySelectorAll('[data-encerrar-pj]').forEach(b=>b.addEventListener('click', ()=>encerrarProjeto(b.dataset.encerrarPj)));
  el.querySelectorAll('[data-print-pj]').forEach(b=>b.addEventListener('click', ()=>printProjeto(b.dataset.printPj)));
}
function projStatusBadge(status){
  const colors = {'Aguardando Viabilidade':'var(--blue)','Em Andamento':'var(--accent)','Concluído':'var(--green)','Encerrado':'var(--muted)','Cancelado':'var(--red)'};
  const c = colors[status]||'var(--muted)';
  return `<span class="badge" style="color:${c};background:${bgFromVar(c)}"><span class="badge-dot"></span>${status}</span>`;
}
function vencimentoAlertBadge(p){
  if(!p.dataVencimento || ['Concluído','Cancelado'].includes(p.status)) return '';
  const dias = diasEntre(todayISO(), p.dataVencimento);
  if(dias<0) return `<div class="blink-red" style="font-size:10.5px;color:var(--red);margin-top:2px;">VENCIDO há ${-dias} dia(s)</div>`;
  if(dias===0) return `<div style="font-size:10.5px;color:var(--accent);margin-top:2px;">Vence hoje</div>`;
  if(dias<=5) return `<div style="font-size:10.5px;color:var(--accent);margin-top:2px;">Vence em ${dias} dia(s)</div>`;
  return '';
}
function viabilidadeAlertBadge(p){
  if(!p.dataRecebimentoCarteira || p.dataViabilizacao || ['Concluído','Cancelado'].includes(p.status)) return '';
  const dias = diasEntre(todayISO(), prazoViabilidadeProjeto(p));
  if(dias<0) return `<div class="blink-red" style="font-size:10.5px;color:var(--red);margin-top:2px;">VIABILIDADE ATRASADA há ${-dias} dia(s)</div>`;
  if(dias<=ALERT_VIAB_BREVE_DIAS) return `<div style="font-size:10.5px;color:var(--accent);margin-top:2px;">Viabilizar em ${dias} dia(s)</div>`;
  return '';
}
    function openProjetoModal(id){
      if(!requerEscrita()) return;
      const pj = id ? findProjeto(id) : null;
  let planoEditor = null;
  const body = `
    <div class="field-row">
      <div class="field"><label>Código <span class="req">*</span></label><input type="text" name="codigo" required value="${esc(pj?.codigo||'')}" placeholder="Ex: PRJ-2026-01"></div>
      <div class="field"><label>Status</label><select name="status">${STATUS_PROJETO.map(s=>`<option ${pj?.status===s?'selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Nome do projeto <span class="req">*</span></label><input type="text" name="nome" required value="${esc(pj?.nome||'')}" placeholder="Ex: Reforço de rede - Setor Norte"></div>
    <div class="field"><label>Descrição</label><textarea name="descricao" placeholder="Detalhes do projeto">${esc(pj?.descricao||'')}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Data de início <span class="req">*</span></label><input type="date" name="dataInicio" required value="${pj?.dataInicio||''}"></div>
      <div class="field"><label>Data fim prevista</label><input type="date" name="dataFim" value="${pj?.dataFim||''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Data recebimento carteira <span class="req">*</span></label><input type="date" name="dataRecebimentoCarteira" required value="${pj?.dataRecebimentoCarteira||''}"><div class="field-hint">💡 Início da contagem do prazo de viabilização (20 dias corridos).</div></div>
      <div class="field"><label>Data vencimento do projeto <span class="req">*</span></label><input type="date" name="dataVencimento" required value="${pj?.dataVencimento||''}"><div class="field-hint">💡 Referência para os alertas de projetos vencendo.</div></div>
    </div>
    <div class="field"><label>Data de viabilização</label><input type="date" name="dataViabilizacao" value="${pj?.dataViabilizacao||''}"><div class="field-hint">💡 Informe a data quando o projeto for viabilizado. Enquanto vazio, o alerta de viabilidade permanece até o prazo de 20 dias corridos após o recebimento da carteira.</div></div>
    <div class="field-row">
      <div class="field"><label>Setor <span class="req">*</span></label><select name="setor" required><option value="">Selecione…</option><option ${pj?.setor==='MANUTENÇÃO'||(usuarioRestrito()&&CURRENT_USER.setor==='MANUTENÇÃO')?'selected':''}>MANUTENÇÃO</option><option ${pj?.setor==='OBRAS'||(usuarioRestrito()&&CURRENT_USER.setor==='OBRAS')?'selected':''}>OBRAS</option></select></div>
      <div class="field"><label>Coordenação <span class="req">*</span></label><select name="coordenacao" required><option value="">Selecione…</option><option ${pj?.coordenacao==='RIO VERDE'||(usuarioRestrito()&&CURRENT_USER.coordenacao==='RIO VERDE')?'selected':''}>RIO VERDE</option><option ${pj?.coordenacao==='QUIRINOPOLIS'||(usuarioRestrito()&&CURRENT_USER.coordenacao==='QUIRINOPOLIS')?'selected':''}>QUIRINOPOLIS</option></select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Cidade</label><input type="text" name="cidade" value="${esc(pj?.cidade||'')}" placeholder="Ex: Rio Verde"><div class="field-hint">💡 Município de referência do projeto (usado na localização dos relatórios).</div></div>
      <div class="field"><label>Valor orçado (R$)</label><input type="number" step="0.01" min="0" name="valorOrcado" value="${pj?.valorOrcado??''}" placeholder="0,00"><div class="field-hint">💡 O avanço financeiro é calculado conforme as atividades concluídas pelas equipes.</div></div>
    </div>
    <div class="field"><label>Ciclo recebido carteira <span class="req">*</span></label><input type="text" name="ciclo" class="ciclo-input" required maxlength="13" value="${esc(pj?.ciclo||'')}" placeholder="CICLO-XX/XXXX"><div class="field-hint">💡 Digite apenas o mês e o ano (ex.: 01/2026). O prefixo "CICLO-" é automático.</div></div>
    <div class="field">
      <label>Plano físico — atividades e quantidades</label>
      <div id="pj-plano-list"></div>
      <button type="button" class="btn btn-sm" id="pj-plano-add" style="margin-top:6px;align-self:flex-start;">${icon('plus',13)} Adicionar atividade</button>
      <div class="field-hint">💡 Cadastre as atividades e quantidades previstas do projeto. O avanço físico avança conforme as programações concluídas pelas equipes.</div>
    </div>
    ${renderCustomFieldsInputs('projetos', pj)}
  `;
  openModal({
    title: pj? 'Editar projeto' : 'Novo projeto', bodyHtml: body, submitLabel: pj? 'Salvar alterações' : 'Cadastrar projeto',
    onMount:(root)=>{
      bindCicloMasks(root);
      planoEditor = createActivityEditorInline(root.querySelector('#pj-plano-list'), (pj?.planoFisico||[]).map(x=>({atividadeId:x.atividadeId, quantidadePrevista:x.quantidade})));
      document.getElementById('pj-plano-add').addEventListener('click', ()=>planoEditor.addRow());
    },
    onSubmit:(fd)=>{
      const ciclo = cicloMask(fd.get('ciclo'));
      if(!isCicloValido(ciclo)){ toast('Informe o ciclo recebido no formato CICLO-XX/XXXX (ex.: CICLO-01/2026).', 'error'); return false; }
      if(!fd.get('setor') || !fd.get('coordenacao')){ toast('Selecione o setor e a coordenação do projeto.', 'error'); return false; }
      const setor = usuarioRestrito()? CURRENT_USER.setor : fd.get('setor');
      const coordenacao = usuarioRestrito()? CURRENT_USER.coordenacao : fd.get('coordenacao');
      const data = { codigo: fd.get('codigo').trim(), nome: fd.get('nome').trim(), descricao: fd.get('descricao').trim(), dataInicio: fd.get('dataInicio'), dataFim: fd.get('dataFim'), dataRecebimentoCarteira: fd.get('dataRecebimentoCarteira'), dataVencimento: fd.get('dataVencimento'), dataViabilizacao: fd.get('dataViabilizacao')||'', setor, coordenacao, cidade: fd.get('cidade').trim(), status: fd.get('status'), valorOrcado: parseFloat(fd.get('valorOrcado'))||0, ciclo, planoFisico: (planoEditor? planoEditor.getData() : []).map(x=>({atividadeId:x.atividadeId, quantidade:x.quantidadePrevista})), custom: parseCustomFieldsFromForm('projetos', fd) };
      if(pj){ Object.assign(pj, data); toast('Projeto atualizado.'); registrarEvento('edicao','projeto',pj.id,pj.codigo+' · '+pj.nome,'Projeto atualizado'); }
      else { data.id = nextId(); DB.projetos.push(data); toast('Projeto cadastrado.'); registrarEvento('criacao','projeto',data.id,data.codigo+' · '+data.nome,'Projeto criado · '+data.ciclo); }
      saveData(); renderContent();
    }
  });
}
function openPlanoFisicoModal(pjId){
  const pj = findProjeto(pjId); if(!pj) return;
  let editor = null;
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:2px;">Projeto: <strong>${esc(pj.nome)}</strong> (${esc(pj.codigo||'')})</div>
    <div class="field"><label>Plano físico — atividades e quantidades previstas</label>
      <div class="ae-list"></div>
      <button type="button" class="btn btn-sm" id="pf-add" style="margin-top:6px;align-self:flex-start;">${icon('plus',13)} Adicionar atividade</button>
      <div class="field-hint">💡 O avanço físico avança conforme as programações concluídas pelas equipes, comparando o executado com este plano.</div>
    </div>`;
  openModal({
    title:'Plano físico do projeto', bodyHtml:body, submitLabel:'Salvar plano físico',
    onMount:(root)=>{
      editor = createActivityEditorInline(root.querySelector('.ae-list'), (pj.planoFisico||[]).map(x=>({atividadeId:x.atividadeId, quantidadePrevista:x.quantidade})));
      document.getElementById('pf-add').addEventListener('click', ()=>editor.addRow());
    },
    onSubmit:()=>{
      pj.planoFisico = editor.getData().map(x=>({atividadeId:x.atividadeId, quantidade:x.quantidadePrevista}));
      saveData(); renderContent(); toast('Plano físico salvo.');
    }
  });
}
    function deleteProjeto(id){
      if(!requerEscrita()) return;
      id = Number(id);
  const vinculadas = DB.programacoes.filter(p=>p.projetoId===id);
  if(vinculadas.length){
    if(ehMestre()){
      if(!confirm(`Excluir este projeto e TODAS as ${vinculadas.length} programação(ões) vinculadas?\n\nEsta ação não pode ser desfeita.`)) return;
      DB.programacoes = DB.programacoes.filter(p=>p.projetoId!==id);
    } else {
      toast('Projeto possui programações vinculadas. Não é possível excluir.', 'error'); return;
    }
  } else {
    if(!confirm('Excluir este projeto?')) return;
  }
  DB.projetos = DB.projetos.filter(p=>p.id!==id);
  registrarEvento('exclusao','projeto',id,findProjeto(id)? findProjeto(id).codigo+' · '+findProjeto(id).nome : String(id),'Projeto excluído'+(vinculadas.length? ' com '+vinculadas.length+' programação(ões) vinculada(s)':''));
  saveData(); renderContent(); toast('Projeto excluído.');
}
function excluirProjetosEmMassa(){
  if(!ehMestre()) return;
  const projs = [...projetoSel].map(id=>findProjeto(id)).filter(Boolean);
  if(!projs.length){ toast('Selecione ao menos um projeto.', 'error'); return; }
  const comVinc = projs.filter(p=> DB.programacoes.some(pg=>pg.projetoId===p.id));
  const totalVinc = comVinc.reduce((s,p)=> s+DB.programacoes.filter(pg=>pg.projetoId===p.id).length, 0);
  if(comVinc.length && !ehMestre()){
    const nomes = comVinc.slice(0,3).map(p=>p.codigo).join(', ')+(comVinc.length>3? '…':'');
    toast(`${comVinc.length} projeto(s) possuem programações vinculadas (${nomes}) e só podem ser excluídos pelo Mestre.`, 'error');
    return;
  }
  let msg = `Excluir ${projs.length} projeto(s) selecionado(s)?`;
  if(totalVinc) msg += `\n\nAtenção: ${totalVinc} programação(ões) vinculada(s) também serão excluídas.`;
  msg += '\n\nEsta ação não pode ser desfeita.';
  if(!confirm(msg)) return;
  let exc = 0;
  projs.forEach(p=>{
    DB.programacoes = DB.programacoes.filter(pg=>pg.projetoId!==p.id);
    DB.projetos = DB.projetos.filter(x=>x.id!==p.id);
    registrarEvento('exclusao','projeto',p.id,p.codigo+' · '+p.nome,'Projeto excluído em massa'+(comVinc.includes(p)? ' com programações vinculadas':''));
    exc++;
  });
  projetoSel.clear();
  saveData(); renderContent(); toast(exc+' projeto(s) excluído(s).');
}
function encerrarProjeto(id){
  if(!requerEscrita()) return;
  id = Number(id);
  const pj = findProjeto(id); if(!pj) return;
  if(!confirm('Encerrar o projeto '+pj.codigo+' — '+pj.nome+'?\n\nApós encerrado, o projeto não aparecerá mais nas opções de novas programações.')) return;
  pj.status = 'Encerrado';
  pj.dataEncerrado = todayISO();
  registrarEvento('config','projeto',pj.id,pj.codigo+' · '+pj.nome,'Projeto encerrado');
  saveData(); renderContent(); toast('Projeto encerrado.');
}

/* =========================================================
   AVANÇO DOS PROJETOS (físico e financeiro)
========================================================= */
function projetoAvanco(pj){
  const pgs = DB.programacoes.filter(p=>p.projetoId===pj.id);
  const plano = (pj.planoFisico||[]).filter(a=>a.atividadeId && a.quantidade);
  const hasPlano = plano.length>0;
  let totalLinhas=0, concluidoLinhas=0, totalQty=0, execQty=0, valorExecutado=0, valorPlanejado=0;
  const porEquipe = {};
  const porStatus = {};
  const execByAtividade = {};
  STATUS_PROG.forEach(s=>porStatus[s]=0);
  const linhas=[];
  if(hasPlano){
    plano.forEach(a=>{
      const atDef = findAtividade(a.atividadeId);
      totalQty += a.quantidade||0;
      valorPlanejado += (a.quantidade||0)*(atDef?.valorUnitario||0);
    });
  }
  pgs.forEach(pg=> (pg.atribuicoes||[]).forEach(at=>{
    const eq = porEquipe[at.equipeId] || (porEquipe[at.equipeId]={ totalLinhas:0, concluidoLinhas:0, totalQty:0, execQty:0, valorExecutado:0, valorPlanejado:0 });
    at.atividades.forEach(a=>{
      const atDef = findAtividade(a.atividadeId);
      const vu = atDef?.valorUnitario||0;
      const prev = a.quantidadePrevista||0;
      const feito = at.status==='Concluído';
      const exec = feito ? (a.quantidadeExecutada!=null? a.quantidadeExecutada : prev) : 0;
      totalLinhas++;
      if(!hasPlano){ totalQty+=prev; valorPlanejado+= prev*vu; }
      eq.totalLinhas++; eq.totalQty+=prev; eq.valorPlanejado+=prev*vu;
      porStatus[at.status] = (porStatus[at.status]||0)+1;
      if(feito){
        concluidoLinhas++; execQty+=exec; valorExecutado+=exec*vu;
        eq.concluidoLinhas++; eq.execQty+=exec; eq.valorExecutado+=exec*vu;
        execByAtividade[a.atividadeId] = (execByAtividade[a.atividadeId]||0) + exec;
      }
      linhas.push({ data: at.dataProgramada||pg.dataProgramada, equipeId:at.equipeId, status:at.status, codigo:atDef?.codigo||'?', descricao:atDef?.descricao||'', unidade:atDef?.unidade||'', prev, exec, vu, execVal: exec*vu });
    });
  }));
  const fisicoPct = Math.min(100, totalQty>0 ? execQty/totalQty*100 : (totalLinhas>0 ? concluidoLinhas/totalLinhas*100 : 0));
  const valorOrcado = pj.valorOrcado||0;
  const financeiroPct = valorOrcado>0 ? Math.min(100, valorExecutado/valorOrcado*100) : 0;
  return { valorOrcado, valorExecutado, restante: Math.max(0, valorOrcado-valorExecutado), valorPlanejado, totalLinhas, concluidoLinhas, totalQty, execQty, fisicoPct, financeiroPct, porEquipe, porStatus, linhas, execByAtividade, plano, hasPlano };
}
function progBarHtml(pct, opts={}){
  const p = Math.max(0, Math.min(100, pct||0));
  const color = p>=100? 'var(--green)' : (p>0? 'var(--accent)' : 'var(--muted-2)');
  return `<div class="progbar ${opts.thin?'thin':''}"><div style="width:${p}%;background:${color};"></div></div>`;
}
function renderProjetosProgressPanel(){
  const visiveis = projetosVisiveis();
  if(!visiveis.length) return '';
  return `<div class="panel section-gap">
    <div class="panel-head"><h3>Avanço dos projetos</h3><button class="btn btn-sm btn-ghost" id="go-avanco">Ver módulo →</button></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Projeto</th><th>Orçado</th><th>Executado</th><th>Avanço físico</th><th>%</th></tr></thead>
      <tbody>${visiveis.map(p=>{
        const av = projetoAvanco(p);
        return `<tr>
          <td><strong>${esc(p.nome)}</strong><div style="color:var(--muted-2);font-size:11.5px;">${esc(p.codigo)}</div></td>
          <td class="mono">${fmtMoney(av.valorOrcado)}</td>
          <td class="mono">${fmtMoney(av.valorExecutado)}</td>
          <td style="min-width:150px;">${progBarHtml(av.fisicoPct,{thin:true})}</td>
          <td class="mono">${av.fisicoPct.toFixed(1)}%</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

function renderAvanco(){
  const el = document.getElementById('content');
  const visiveis = projetosVisiveis();
  if(!visiveis.length){ el.innerHTML = emptyState('Nenhum projeto cadastrado', 'Cadastre projetos para acompanhar o avanço físico e financeiro conforme as atividades concluídas pelas equipes.'); bindEmptyCta(el, ()=>setView('projetos')); return; }
  const list = visiveis.filter(p=>{
    if(avancoFilters.status && p.status!==avancoFilters.status) return false;
    if(avancoFilters.q){ const t=(p.codigo+' '+(p.nome||'')).toLowerCase(); if(!t.includes(avancoFilters.q.toLowerCase())) return false; }
    return true;
  });
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <input id="f-av-q" placeholder="Buscar projeto…" value="${esc(avancoFilters.q)}">
        <select id="f-av-status"><option value="">Todos os status</option>${STATUS_PROJETO.map(s=>`<option ${avancoFilters.status===s?'selected':''}>${s}</option>`).join('')}</select>
      </div>
      <span style="font-size:12px;color:var(--muted);">${list.length} de ${visiveis.length} projetos</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:18px;">${list.length? list.map(avancoCard).join('') : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhum projeto encontrado com os filtros.</p></div></div>`}</div>`;
  document.getElementById('f-av-q').addEventListener('input', e=>{ avancoFilters.q=e.target.value; renderContent(); });
  document.getElementById('f-av-status').addEventListener('change', e=>{ avancoFilters.status=e.target.value; renderContent(); });
  el.querySelectorAll('[data-avanco-detalhe]').forEach(b=>b.addEventListener('click', ()=>openAvancoDetalhe(b.dataset.avancoDetalhe)));
  el.querySelectorAll('[data-plano-pj]').forEach(b=>b.addEventListener('click', ()=>openPlanoFisicoModal(b.dataset.planoPj)));
}
function avancoCard(pj){
  const av = projetoAvanco(pj);
  const eqRows = Object.keys(av.porEquipe).map(id=>({ id:Number(id), ...av.porEquipe[id] }));
  const hintFisico = av.hasPlano
    ? `${av.execQty} de ${av.totalQty} unidades executadas do plano físico (${av.fisicoPct.toFixed(1)}%)`
    : `${av.fisicoPct.toFixed(1)}% das atividades concluídas pelas equipes`;
  return `
  <div class="panel">
    <div class="panel-head">
      <div><h3>${esc(pj.nome)}</h3><div class="admin-field-meta">${esc(pj.codigo)} · ${fmtDate(pj.dataInicio)}${pj.dataFim?' → '+fmtDate(pj.dataFim):''}</div></div>
      ${projStatusBadge(pj.status)}
    </div>
    <div style="padding:14px 18px;display:flex;flex-direction:column;gap:14px;">
      <div class="grid-stats" style="margin:0;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
        <div class="stat-card" style="--accent-c:var(--blue);padding:12px 14px;"><div class="lbl">Orçado</div><div class="val" style="font-size:18px;">${fmtMoney(av.valorOrcado)}</div></div>
        <div class="stat-card" style="--accent-c:var(--green);padding:12px 14px;"><div class="lbl">Executado</div><div class="val" style="font-size:18px;">${fmtMoney(av.valorExecutado)}</div></div>
        <div class="stat-card" style="--accent-c:var(--red);padding:12px 14px;"><div class="lbl">Restante</div><div class="val" style="font-size:18px;">${fmtMoney(av.restante)}</div></div>
        <div class="stat-card" style="--accent-c:var(--accent);padding:12px 14px;"><div class="lbl">Concluídas</div><div class="val" style="font-size:18px;">${av.concluidoLinhas}<small>/ ${av.totalLinhas}</small></div></div>
      </div>
      <div class="field"><label>Avanço físico</label>${progBarHtml(av.fisicoPct)}<div class="field-hint">💡 ${hintFisico}</div></div>
      <div class="field"><label>Avanço financeiro</label>${progBarHtml(av.financeiroPct)}<div class="field-hint">💡 ${fmtMoney(av.valorExecutado)} executados de ${fmtMoney(av.valorOrcado)} orçados (${av.financeiroPct.toFixed(1)}%)</div></div>
      ${eqRows.length? `<div class="table-scroll"><table class="min">
        <thead><tr><th>Equipe</th><th>Equipe comp.</th><th>Concluídas</th><th>Executado (R$)</th><th>Físico</th></tr></thead>
        <tbody>${eqRows.map(e=>{
          const eq=findEquipe(e.id);
          const pct = e.totalQty>0? e.execQty/e.totalQty*100 : (e.totalLinhas>0? e.concluidoLinhas/e.totalLinhas*100:0);
          return `<tr><td><span class="badge-prefix">${eqtlLabel(eq)}</span></td><td><span class="badge-prefix">${prtnLabel(eq)}</span></td><td>${e.concluidoLinhas}/${e.totalLinhas}</td><td class="mono">${fmtMoney(e.valorExecutado)}</td><td style="min-width:130px;">${progBarHtml(pct,{thin:true})}</td></tr>`;
        }).join('')}</tbody></table></div>`:''}
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button class="btn btn-sm" data-plano-pj="${pj.id}">${icon('edit',13)} Plano físico</button>
        <button class="btn btn-sm" data-avanco-detalhe="${pj.id}">${icon('history',13)} Ver detalhes completos</button>
      </div>
    </div>
  </div>`;
}
function openAvancoDetalhe(pjId){
  const pj = findProjeto(pjId); if(!pj) return;
  const av = projetoAvanco(pj);
  const rows = [...av.linhas].sort((a,b)=>a.data.localeCompare(b.data));
  const body = `
    <div class="grid-stats" style="margin:0 0 6px;">
      <div class="stat-card" style="--accent-c:var(--blue)"><div class="lbl">Valor orçado</div><div class="val" style="font-size:19px;">${fmtMoney(av.valorOrcado)}</div></div>
      <div class="stat-card" style="--accent-c:var(--green)"><div class="lbl">Valor executado</div><div class="val" style="font-size:19px;">${fmtMoney(av.valorExecutado)}</div></div>
      <div class="stat-card" style="--accent-c:var(--red)"><div class="lbl">Restante</div><div class="val" style="font-size:19px;">${fmtMoney(av.restante)}</div></div>
      <div class="stat-card" style="--accent-c:var(--accent)"><div class="lbl">Atividades</div><div class="val" style="font-size:19px;">${av.concluidoLinhas}<small> / ${av.totalLinhas}</small></div></div>
    </div>
    <div class="field"><label>Avanço físico (${av.fisicoPct.toFixed(1)}%)</label>${progBarHtml(av.fisicoPct)}<div class="field-hint">💡 ${av.hasPlano? `${av.execQty} de ${av.totalQty} unidades do plano físico executadas` : `${av.concluidoLinhas} de ${av.totalLinhas} atividades concluídas`}</div></div>
    <div class="field"><label>Avanço financeiro (${av.financeiroPct.toFixed(1)}%)</label>${progBarHtml(av.financeiroPct)}</div>
    ${av.hasPlano? `
    <div class="field">
      <label>Plano físico (atividade × quantidade)</label>
      <div class="panel" style="max-height:220px;overflow:auto;">
        <div class="table-scroll"><table>
          <thead><tr><th>Atividade</th><th>Planejado</th><th>Executado</th><th>% física</th></tr></thead>
          <tbody>${av.plano.map(a=>{
            const at=findAtividade(a.atividadeId);
            const exec = av.execByAtividade[a.atividadeId]||0;
            const pct = a.quantidade>0? Math.min(100, exec/a.quantidade*100):0;
            return `<tr>
              <td><span class="mono" style="color:var(--accent);">${esc(at?.codigo||'?')}</span> <span style="color:var(--muted-2);font-size:11.5px;">${esc(at?.descricao||'')}</span></td>
              <td class="mono">${a.quantidade}</td>
              <td class="mono">${exec}</td>
              <td style="min-width:130px;">${progBarHtml(pct,{thin:true})}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
    </div>` : ''}
    <div class="field">
      <label>Detalhes por atividade</label>
      <div class="panel" style="max-height:300px;overflow:auto;">
        <div class="table-scroll"><table>
          <thead><tr><th>Data</th><th>Equipe</th><th>Equipe comp.</th><th>Atividade</th><th>Prev.</th><th>Exec.</th><th>Valor exec.</th><th>Status</th></tr></thead>
          <tbody>${rows.length? rows.map(r=>`
            <tr>
              <td class="mono">${fmtDate(r.data)}</td>
              <td><span class="badge-prefix">${eqtlLabel(findEquipe(r.equipeId))}</span></td>
              <td><span class="badge-prefix">${prtnLabel(findEquipe(r.equipeId))}</span></td>
              <td><span class="mono" style="color:var(--accent);">${esc(r.codigo)}</span> <span style="color:var(--muted-2);font-size:11.5px;">${esc(r.descricao)}</span></td>
              <td class="mono">${r.prev||'—'}</td>
              <td class="mono">${r.exec!=null? r.exec:'—'}</td>
              <td class="mono">${fmtMoney(r.execVal)}</td>
              <td>${statusBadge(r.status)}</td>
            </tr>`).join('') : `<tr class="empty-row"><td colspan="8">Nenhuma atividade vinculada a este projeto.</td></tr>`}
          </tbody>
        </table></div>
      </div>
    </div>
  `;
  openModal({ title:`Avanço — ${esc(pj.nome)}`, bodyHtml:body, submitLabel:'Fechar', onSubmit:()=>true, wide:true });
}

/* =========================================================
   VIEW: PROGRAMAÇÕES (lista, fluxo, calendário)
========================================================= */
function programacoesFiltradas(){
  return flatAtribuicoes().filter(x=>{
    if(progFilters.projeto && String(x.programacao.projetoId)!==progFilters.projeto) return false;
    if(progFilters.equipe && String(x.atribuicao.equipeId)!==progFilters.equipe) return false;
    if(progFilters.status && x.atribuicao.status!==progFilters.status) return false;
    if(progFilters.ciclo && (x.programacao.ciclo||'')!==progFilters.ciclo) return false;
    if(progFilters.dataDe && x.atribuicao.dataProgramada < progFilters.dataDe) return false;
    if(progFilters.dataAte && x.atribuicao.dataProgramada > progFilters.dataAte) return false;
    return true;
  }).sort((a,b)=> a.atribuicao.dataProgramada.localeCompare(b.atribuicao.dataProgramada));
}
function ciclosUnicos(){ return [...new Set(DB.programacoes.map(p=>p.ciclo).filter(Boolean))].sort(); }
function cicloPadrao(){
  const ciclos = ciclosUnicos();
  for(let i=ciclos.length-1;i>=0;i--){
    const c = ciclos[i];
    if(DB.programacoes.some(p=>p.ciclo===c && (p.atribuicoes||[]).some(a=>a.status==='Concluído'))) return c;
  }
  return ciclos[ciclos.length-1] || '';
}
function flatPorCicloPadrao(){
  const c = progFilters.ciclo || cicloPadrao();
  if(!c) return flatAtribuicoes();
  return flatAtribuicoes().filter(x=>x.programacao.ciclo===c);
}
function renderProgramacoes(){
  const el = document.getElementById('content');
  if(!projetosVisiveis().length || !DB.atividades.length || !DB.equipes.length){
    el.innerHTML = emptyState('Cadastre projetos, atividades e equipes primeiro', 'Uma programação vincula um projeto, uma ou mais equipes (cada uma com suas atividades e quantidades) a uma data.');
    return;
  }
  const list = programacoesFiltradas();
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <select id="f-projeto"><option value="">Todos os projetos</option>${projetosVisiveis().map(p=>`<option value="${p.id}" ${progFilters.projeto==String(p.id)?'selected':''}>${esc(p.codigo)} · ${esc(p.nome)}</option>`).join('')}</select>
        <select id="f-equipe"><option value="">Todas as equipes</option>${equipesVisiveis().map(e=>`<option value="${e.id}" ${progFilters.equipe==String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' — '+esc(e.encarregado):''}</option>`).join('')}</select>
        <select id="f-status"><option value="">Todos os status</option>${STATUS_PROG.map(s=>`<option ${progFilters.status===s?'selected':''}>${s}</option>`).join('')}</select>
        <select id="f-ciclo"><option value="">Todos os ciclos</option>${ciclosUnicos().map(c=>`<option ${progFilters.ciclo===c?'selected':''}>${c}</option>`).join('')}</select>
        <input type="date" id="f-data-de" value="${progFilters.dataDe}" title="Data inicial">
        <span style="color:var(--muted);font-size:12px;">até</span>
        <input type="date" id="f-data-ate" value="${progFilters.dataAte}" title="Data final">
        <button class="btn btn-sm" id="f-mes-atual" title="Filtrar pelo mês vigente">${icon('calendar',12)} Mês atual</button>
        <button class="btn btn-sm btn-ghost" id="f-limpar-datas" title="Remover o filtro de datas">Limpar</button>
      </div>
      <div class="tabs">
        <button class="tab ${progFilters.modo==='lista'?'active':''}" data-modo="lista">Lista</button>
        <button class="tab ${progFilters.modo==='fluxo'?'active':''}" data-modo="fluxo">Fluxo</button>
        <button class="tab ${progFilters.modo==='calendario'?'active':''}" data-modo="calendario">Calendário</button>
      </div>
    </div>
    <div id="prog-area"></div>`;
  document.getElementById('f-projeto').addEventListener('change', e=>{progFilters.projeto=e.target.value; renderContent();});
  document.getElementById('f-equipe').addEventListener('change', e=>{progFilters.equipe=e.target.value; renderContent();});
  document.getElementById('f-status').addEventListener('change', e=>{progFilters.status=e.target.value; renderContent();});
  document.getElementById('f-ciclo').addEventListener('change', e=>{progFilters.ciclo=e.target.value; renderContent();});
  document.getElementById('f-data-de').addEventListener('change', e=>{progFilters.dataDe=e.target.value; renderContent();});
  document.getElementById('f-data-ate').addEventListener('change', e=>{progFilters.dataAte=e.target.value; renderContent();});
  document.getElementById('f-mes-atual').addEventListener('click', ()=>{ const r=monthRangeISO(); progFilters.dataDe=r.de; progFilters.dataAte=r.ate; renderContent(); });
  document.getElementById('f-limpar-datas').addEventListener('click', ()=>{ progFilters.dataDe=''; progFilters.dataAte=''; renderContent(); });
  el.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>{progFilters.modo=t.dataset.modo; renderContent();}));

  const area = document.getElementById('prog-area');
  if(progFilters.modo==='calendario'){ renderProgCalendarioInto(area, list); return; }
  if(!list.length){
    if(progFilters.ciclo){ progFilters.ciclo=''; renderProgramacoes(); return; }
    area.innerHTML = programacoesVisiveis().length
      ? emptyState('Nenhuma programação encontrada', 'Ajuste os filtros para ver as programações.')
      : emptyState('Nenhuma programação cadastrada', 'Clique em "Nova programação" para criar a primeira.');
    return;
  }
  if(progFilters.modo==='lista') renderProgListaInto(area, list); else renderProgFluxoInto(area, list);
}

function renderProgListaInto(area, list){
  area.innerHTML = `<div class="panel"><div class="table-scroll"><table>
    <thead><tr><th>ID</th><th>Data</th><th>Projeto</th><th>Ciclo</th><th>Equipe</th><th>Equipe comp.</th><th>Atividades</th><th>Valor prev.</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(x=>{
      const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId), late=isLate(p);
      const valPrev = p.atividades.reduce((s,a)=> s + (a.quantidadePrevista||0)*(findAtividade(a.atividadeId)?.valorUnitario||0), 0);
      const metaWarn = metaWarningHtml(p);
      const gid = progGid(x.programacao);
      return `<tr ${late?'style="background:#ffe4e1;"':''} data-programacao-id="${x.programacao.id}" style="cursor:pointer;">
        <td class="mono" style="white-space:nowrap;">${gid}</td>
        <td class="mono">${fmtDate(p.dataProgramada)} ${late?`<div class="late-flag">VENCIDA</div>`:''}</td>
        <td><strong>${esc(pr?.codigo||'—')}</strong><div style="color:var(--muted-2);font-size:11px;">${esc(pr?.nome||'')} · ${esc(pr?.setor||'')} · ${esc(pr?.coordenacao||'')}</div></td>
        <td><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);font-size:10.5px;">${esc(x.programacao.ciclo||'—')}</span></td>
        <td><span class="badge-prefix">${eqtlLabel(eq)}</span></td>
        <td><span class="badge-prefix">${prtnLabel(eq)}</span>${metaWarn? `<div style="margin-top:4px;">${metaWarn}</div>`:''}</td>
        <td style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;">${atividadesResumo(p.atividades)}</td>
        <td class="mono">${fmtMoney(valPrev)}</td>
        <td>${statusBadge(p.status, late)}${teamBadgeHtml(p)? `<div style="margin-top:4px;">${teamBadgeHtml(p)}</div>`:''}</td>
        <td><div class="row-actions">
          <button class="icon-btn" title="Encaminhar para as equipes no WhatsApp" data-whats="${x.programacao.id}">${icon('whatsapp',14)}</button>
          <button class="icon-btn" title="Imprimir documento de campo" data-doc-prog="${x.programacao.id}">${icon('print',14)}</button>
          <button class="icon-btn" title="Histórico" data-hist="${p.id}">${icon('history',14)}</button>
          <button class="icon-btn" title="Reprogramar" data-reprog="${x.programacao.id}|${p.id}">${icon('reprog',14)}</button>
          <button class="icon-btn" title="Editar programação" data-edit-prog="${x.programacao.id}">${icon('edit',14)}</button>
          <button class="icon-btn" title="Excluir equipe desta programação" data-del-atrib="${x.programacao.id}|${p.id}">${icon('trash',14)}</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
  bindProgRowActions(area);
}
function bindProgRowActions(area){
  area.querySelectorAll('[data-whats]').forEach(b=>b.addEventListener('click', ()=>encaminharWhats(b.dataset.whats)));
  area.querySelectorAll('[data-doc-prog]').forEach(b=>b.addEventListener('click', ()=>openDocProgramacao(b.dataset.docProg)));
  area.querySelectorAll('[data-hist]').forEach(b=>b.addEventListener('click', ()=>openHistoricoModal(b.dataset.hist)));
  area.querySelectorAll('[data-reprog]').forEach(b=>b.addEventListener('click', ()=>{ const [pgId,atId]=b.dataset.reprog.split('|'); openReprogramarManual(pgId, atId); }));
  area.querySelectorAll('[data-edit-prog]').forEach(b=>b.addEventListener('click', ()=>openProgramacaoModal(b.dataset.editProg)));
  area.querySelectorAll('[data-del-atrib]').forEach(b=>b.addEventListener('click', ()=>{ const [pgId,atId]=b.dataset.delAtrib.split('|'); deleteAtribuicao(pgId, atId); }));
  // Clicar na linha da programação abre o modal
  area.querySelectorAll('tr[data-programacao-id]').forEach(tr=>tr.addEventListener('click', ()=>{ const pgId = tr.dataset.programacaoId; openProgramacaoDetalheModal(pgId); }));
}
function deleteAtribuicao(pgId, atId){
  if(!confirm('Remover esta equipe desta programação?')) return;
  const pg = DB.programacoes.find(p=>p.id===Number(pgId));
  pg.atribuicoes = pg.atribuicoes.filter(a=>a.id!==Number(atId));
  if(!pg.atribuicoes.length) DB.programacoes = DB.programacoes.filter(p=>p.id!==pg.id);
  saveData(); renderContent(); toast('Removido.');
}

function renderProgFluxoInto(area, list){
  const cols = STATUS_PROG.map(status=>{
    const items = list.filter(x=>x.atribuicao.status===status);
    const c = STATUS_COLOR[status];
    return `<div class="kanban-col" style="--col-c:${c}" data-drop-status="${status}">
      <div class="kanban-col-head"><h4>${status}</h4><span class="count">${items.length}</span></div>
      <div class="kanban-cards">${items.map(x=>{
        const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId), late=isLate(p);
        const valPrev = valorProgramadoAtrib(p);
        const metaWarn = metaWarningHtml(p);
        return `<div class="kcard ${late?'pending':''}" draggable="true" data-atrib="${p.id}" data-open-prog="${p.id}">
          <div class="kc-code ${late?'late-blink late':''}">${late?'VENCIDA · ':''}${equipeLabel(eq)}</div>
          <div class="kc-title">${esc(atividadesResumo(p.atividades))}</div>
          <div class="kc-meta"><span><strong>${esc(pr?.codigo||'—')}</strong><span style="color:var(--muted-2);"> · ${esc(pr?.nome||'')} · ${esc(pr?.setor||'')} · ${esc(pr?.coordenacao||'')}</span></span><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);font-size:10px;">${esc(x.programacao.ciclo||'')}</span></div>
          <div class="kc-meta"><span>${fmtDate(p.dataProgramada)}</span><span class="mono" style="color:var(--accent);">${progGid(x.programacao)}</span><span class="mono" style="color:var(--muted);">${p.atividades.length} ativ. · ${fmtMoney(valPrev)}</span></div>
          ${metaWarn? `<div class="kc-meta" style="justify-content:flex-start;">${metaWarn}</div>`:''}
          ${teamBadgeHtml(p)? `<div class="kc-meta" style="justify-content:flex-start;">${teamBadgeHtml(p)}</div>`:''}
        </div>`;
      }).join('') || `<div style="padding:14px;color:var(--muted-2);font-size:11.5px;">Vazio</div>`}</div>
    </div>`;
  }).join('');
  area.innerHTML = renderKanbanStrip() + `<div class="kanban">${cols}</div>`;
  bindKanbanDrag(area);
}
function renderKanbanStrip(){
  const days = [];
  const start = todayISO();
  for(let i=0;i<28;i++) days.push(shiftISO(start, i));
  return `<div class="kanban-strip">
    <div class="ks-title">${icon('reprog',13)} <strong>Reprogramar arrastando:</strong> arraste um card sobre uma data para reprogramar, ou sobre outra coluna para mudar o status.</div>
    <div class="ks-days">${days.map(iso=>{
      const d = new Date(iso+'T12:00:00');
      const dow = d.toLocaleDateString('pt-BR',{weekday:'short'}).replace('.','');
      return `<div class="ks-day ${iso===todayISO()?'today':''}" data-date="${iso}" title="Reprogramar para ${fmtDate(iso)}"><span class="ks-dow">${dow}</span><span class="ks-num">${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}</span></div>`;
    }).join('')}</div>
  </div>`;
}
function findAtribuicaoGlobal(atribId){
  for(const p of DB.programacoes){ const f=(p.atribuicoes||[]).find(a=>a.id===Number(atribId)); if(f) return f; }
  return null;
}
function progDaAtribuicao(atribId){
  return DB.programacoes.find(p=> (p.atribuicoes||[]).some(a=>a.id===Number(atribId)));
}
function pedirMotivoStatus(atribId, novoStatus, onOk){
  if(!requerEscrita()) return;
  const atrib = findAtribuicaoGlobal(atribId);
  if(!atrib || atrib.status===novoStatus) return;
  const de = atrib.status;
  const eq = findEquipe(atrib.equipeId);
  const body = `
    <div class="modal-body">
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:12px;">Alterar o status de <strong>${de}</strong> para <strong>${novoStatus}</strong>${eq? ' — '+esc(equipeLabel(eq)):''}</div>
      <div class="field"><label>Motivo <span class="req">*</span></label><input type="text" name="motivo" required maxlength="200" placeholder="Descreva o motivo desta alteração de status"></div>
      <div class="field"><label>Observações</label><textarea name="obs" rows="2" placeholder="Detalhes opcionais"></textarea></div>
    </div>`;
  openModal({
    title:'Motivo da alteração de status', bodyHtml: body, submitLabel:'Alterar status',
    onSubmit:(fd)=>{
      const motivo = String(fd.get('motivo')||'').trim();
      const obs = String(fd.get('obs')||'').trim();
      if(!motivo){ toast('Informe o motivo da alteração.', 'error'); return false; }
      atrib.status = novoStatus;
      atrib.historico = atrib.historico||[];
      atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'status', de, para:novoStatus, motivo, obs: obs||null});
      const pgX = progDaAtribuicao(atrib.id);
      registrarEvento('status','atribuicao',atrib.id, (pgX? progGid(pgX)+' · ': '')+equipeLabel(findEquipe(atrib.equipeId)), de+' → '+novoStatus+' · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); renderBanner(); toast('Status alterado para '+novoStatus+'.');
      onOk && onOk();
    }
  });
}
    function setAtribStatusGlobal(atribId, status){
      if(!requerEscrita()) return;
      pedirMotivoStatus(atribId, status);
}
function bindKanbanDrag(area){
  let dragId = null;
  area.querySelectorAll('.kcard[draggable]').forEach(card=>{
    card.addEventListener('dragstart', e=>{
      dragId = card.dataset.atrib; card.classList.add('dragging');
      try{ e.dataTransfer.setData('text/plain', String(card.dataset.atrib)); e.dataTransfer.effectAllowed='move'; }catch(err){}
    });
    card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); });
  });
  area.querySelectorAll('.kanban-col').forEach(col=>{
    col.addEventListener('dragover', e=>{ e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', ()=>{ col.classList.remove('drag-over'); });
    col.addEventListener('drop', e=>{
      e.preventDefault(); col.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) setAtribStatusGlobal(id, col.dataset.dropStatus);
    });
  });
  area.querySelectorAll('.ks-day').forEach(day=>{
    day.addEventListener('dragover', e=>{ e.preventDefault(); day.classList.add('drag-over'); });
    day.addEventListener('dragleave', ()=>{ day.classList.remove('drag-over'); });
    day.addEventListener('drop', e=>{
      e.preventDefault(); day.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) openReprogramarConfirmacao(id, day.dataset.date);
    });
  });
  area.querySelectorAll('[data-open-prog]').forEach(c=>c.addEventListener('click', ()=>openAtribDetalhe(c.dataset.openProg)));
}

function shiftISO(iso, days){
  const d = new Date(iso+'T12:00:00'); d.setDate(d.getDate()+days);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function renderProgCalendarioInto(area, list){
  const subTabs = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
      <div class="tabs">
        <button class="tab ${progFilters.calView==='mes'?'active':''}" data-cal-view="mes">Mês (externa)</button>
        <button class="tab ${progFilters.calView==='dia'?'active':''}" data-cal-view="dia">Dia (interna)</button>
        <button class="tab ${progFilters.calView==='tabulacao'?'active':''}" data-cal-view="tabulacao">Tabulação</button>
      </div>
      ${progFilters.calView==='dia'? `<div style="display:flex;align-items:center;gap:8px;">
        <button class="icon-btn" id="day-prev">${icon('chevL',16)}</button>
        <span class="mono" style="color:var(--text);font-weight:700;">${fmtDate(progFilters.calDay)}</span>
        <button class="icon-btn" id="day-next">${icon('chevR',16)}</button>
      </div>`:''}
      <span style="font-size:12px;color:var(--muted);">${list.length} programação(ões)</span>
    </div>`;
  const bindTabs = ()=>{
    area.querySelectorAll('.tab[data-cal-view]').forEach(b=>b.addEventListener('click', ()=>{ progFilters.calView=b.dataset.calView; renderContent(); }));
  };
  if(progFilters.calView==='dia'){
    const dayList = list.filter(x=>x.atribuicao.dataProgramada===progFilters.calDay);
    area.innerHTML = subTabs + (dayList.length? renderDayList(dayList) : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhuma programação em ${fmtDate(progFilters.calDay)}.</p></div></div>`);
    bindTabs();
    const pv=area.querySelector('#day-prev'), nx=area.querySelector('#day-next');
    if(pv) pv.addEventListener('click', ()=>{ progFilters.calDay=shiftISO(progFilters.calDay,-1); renderContent(); });
    if(nx) nx.addEventListener('click', ()=>{ progFilters.calDay=shiftISO(progFilters.calDay,1); renderContent(); });
    area.querySelectorAll('[data-open-prog]').forEach(c=>c.addEventListener('click', ()=>openAtribDetalhe(c.dataset.openProg)));
    area.querySelectorAll('[data-doc-prog]').forEach(c=>c.addEventListener('click', ()=>openDocProgramacao(c.dataset.docProg)));
    return;
  }
  if(progFilters.calView==='tabulacao'){
    renderProgTabulacaoInto(area, list, subTabs, bindTabs);
    return;
  }
  const year = calRef.getFullYear(), month = calRef.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const monthName = calRef.toLocaleDateString('pt-BR', {month:'long', year:'numeric'});
  const byDate = {};
  list.forEach(x=>{ (byDate[x.atribuicao.dataProgramada] = byDate[x.atribuicao.dataProgramada]||[]).push(x); });

  let cells = '';
  for(let i=0;i<startDow;i++) cells += `<div class="cal-cell out"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const iso = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const items = byDate[iso]||[];
    const isToday = iso===todayISO();
    cells += `<div class="cal-cell ${isToday?'today':''}">
      <div class="cal-daynum" data-day-view="${iso}" style="cursor:pointer;" title="Ver dia">${d} ${items.length?`<span style="color:var(--accent);">· ${items.length}</span>`:''}</div>
      ${items.slice(0,3).map(x=>{
        const eq=findEquipe(x.atribuicao.equipeId); const late=isLate(x.atribuicao); const c=STATUS_COLOR[x.atribuicao.status];
        return `<div class="cal-chip ${late?'late-blink late':''}" style="color:${late?'var(--purple)':c};border-color:${late?'rgba(180,140,224,.5)':'var(--border)'}" data-open-prog="${x.atribuicao.id}">${equipeLabel(eq)}</div>`;
      }).join('')}
      ${items.length>3? `<div style="font-size:10px;color:var(--accent);cursor:pointer;" data-day-view="${iso}">+${items.length-3} mais</div>`:''}
    </div>`;
  }
  const dows = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  area.innerHTML = `
    ${subTabs}
    <div class="panel" style="padding:16px;">
      <div class="cal-nav">
        <button class="icon-btn" id="cal-prev">${icon('chevL',16)}</button>
        <h3 style="text-transform:capitalize;">${monthName}</h3>
        <button class="icon-btn" id="cal-next">${icon('chevR',16)}</button>
      </div>
      <div class="cal-grid">${dows.map(d=>`<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
    </div>`;
  bindTabs();
  document.getElementById('cal-prev').addEventListener('click', ()=>{ calRef = new Date(year, month-1, 1); renderContent(); });
  document.getElementById('cal-next').addEventListener('click', ()=>{ calRef = new Date(year, month+1, 1); renderContent(); });
  area.querySelectorAll('[data-day-view]').forEach(c=>c.addEventListener('click', ()=>{ progFilters.calDay=c.dataset.dayView; progFilters.calView='dia'; renderContent(); }));
  area.querySelectorAll('[data-open-prog]').forEach(c=>c.addEventListener('click', ()=>openAtribDetalhe(c.dataset.openProg)));
}
function renderDayList(dayList){
  const visiveis = dayList.filter(x=> x.atribuicao.status!=='Cancelado');
  return `<div style="display:flex;flex-direction:column;gap:14px;">${visiveis.map(x=>{
    const p=x.atribuicao, pr=findProjeto(x.programacao.projetoId), eq=findEquipe(p.equipeId), late=isLate(p);
    const valPrev = p.atividades.reduce((s,a)=> s + (a.quantidadePrevista||0)*(findAtividade(a.atividadeId)?.valorUnitario||0), 0);
    return `<div class="panel">
      <div class="panel-head">
        <div><h3>${esc(pr?.codigo||'—')} <span style="font-size:14px;font-weight:400;color:var(--muted-2);">${esc(pr?.nome||'')}</span></h3><div class="admin-field-meta">${progGid(x.programacao)} · ${esc(x.programacao.ciclo||'')} · ${equipeLabel(eq)} · ${fmtDate(p.dataProgramada)}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${metaWarningHtml(p)}${teamBadgeHtml(p)}${statusBadge(p.status, late)}</div>
      </div>
      <div style="padding:12px 16px;">
        <div class="table-scroll"><table class="min">
          <thead><tr><th>Código</th><th>Descrição</th><th>Un.</th><th>Prev.</th><th>Exec.</th><th>V. unit.</th><th>V. prev.</th></tr></thead>
          <tbody>${p.atividades.map(a=>{const at=findAtividade(a.atividadeId); return `<tr>
            <td class="mono" style="color:var(--accent);font-weight:700;">${esc(at?.codigo||'?')}</td>
            <td>${esc(at?.descricao||'')}</td><td>${esc(at?.unidade||'')}</td>
            <td class="mono">${a.quantidadePrevista??'—'}</td>
            <td class="mono">${a.quantidadeExecutada!=null?a.quantidadeExecutada:'—'}</td>
            <td class="mono">${fmtMoney(at?.valorUnitario||0)}</td>
            <td class="mono">${fmtMoney((a.quantidadePrevista||0)*(at?.valorUnitario||0))}</td>
          </tr>`;}).join('')}
          <tr style="font-weight:700;"><td colspan="6" style="text-align:right;">Total previsto</td><td class="mono">${fmtMoney(valPrev)}</td></tr>
          </tbody>
        </table></div>
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
          <button class="btn btn-sm" data-doc-prog="${x.programacao.id}">${icon('print',13)} Imprimir</button>
          <button class="btn btn-sm" data-open-prog="${p.id}">${icon('calendar',13)} Ver detalhe</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderProgTabulacaoInto(area, list, subTabs, bindTabs){
  const visiveis = list.filter(x=> x.atribuicao.status!=='Cancelado');
  const dows = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const byDate = {};
  visiveis.forEach(x=>{
    const d = x.atribuicao.dataProgramada;
    (byDate[d] = byDate[d]||[]).push(x);
  });
  const dates = Object.keys(byDate).sort();
  const eqSet = new Set();
  visiveis.forEach(x=>{ const eq=findEquipe(x.atribuicao.equipeId); if(eq) eqSet.add(eq.id); });
  const equipes = [...eqSet].map(id=>findEquipe(id)).filter(Boolean);
  if(!dates.length){
    area.innerHTML = subTabs + `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhuma programação para exibir na tabulação.</p></div></div>`;
    bindTabs();
    return;
  }
  let totalGeral = 0;
  let rowsHtml = dates.map(iso=>{
    const d = new Date(iso+'T12:00:00');
    const dow = dows[d.getDay()];
    const weekNum = getWeekNumber(d);
    const items = byDate[iso];
    const totalDia = items.length;
    totalGeral += totalDia;
    const eqCells = equipes.map(eq=>{
      const progs = items.filter(x=>x.atribuicao.equipeId===eq.id);
      if(!progs.length) return `<td class="tab-cell"></td>`;
      const blocks = progs.map(x=>{
        const pr = findProjeto(x.programacao.projetoId);
        const cidade = pr?.cidade || '';
        const cor = cidadeCor(cidade);
        const label = esc((pr?.codigo||'—') + (cidade? '/'+cidade:''));
        return `<div class="tab-block" style="background:${cor};color:#fff;" title="${esc(pr?.nome||'')}">${label}</div>`;
      }).join('');
      return `<td class="tab-cell">${blocks}</td>`;
    }).join('');
    const isToday = iso===todayISO();
    return `<tr class="${isToday?'tab-row-today':''}">
      <td class="tab-cell tab-cell-date tab-col-1">${fmtDate(iso)}</td>
      <td class="tab-cell tab-cell-dow tab-col-2">${esc(dow)}</td>
      <td class="tab-cell tab-cell-week tab-col-3">${weekNum}</td>
      <td class="tab-cell tab-cell-total tab-col-4">${totalDia}</td>
      ${eqCells}
    </tr>`;
  }).join('');
  const eqHeaders = equipes.map(eq=>{
    const label = equipeLabel(eq);
    return `<th class="tab-th-eq" title="${esc(label)}">${esc(label)}</th>`;
  }).join('');
  area.innerHTML = subTabs + `
    <div class="panel" style="padding:0;">
      <div class="table-scroll tab-scroll">
        <table class="tab-table">
          <thead><tr>
            <th class="tab-th tab-th-fixed tab-col-1">Data</th>
            <th class="tab-th tab-th-fixed tab-col-2">Dia</th>
            <th class="tab-th tab-th-fixed tab-col-3">Semana</th>
            <th class="tab-th tab-th-fixed tab-col-4">Total</th>
            ${eqHeaders}
          </tr></thead>
          <tbody>${rowsHtml}
            <tr class="tab-total-row">
              <td class="tab-cell tab-col-1 tab-cell-date" style="font-weight:700;text-align:right;">Total</td>
              <td class="tab-cell tab-col-2"></td>
              <td class="tab-cell tab-col-3"></td>
              <td class="tab-cell tab-col-4 tab-cell-total" style="font-weight:700;">${totalGeral}</td>
              ${equipes.map(eq=>{
                const count = visiveis.filter(x=>x.atribuicao.equipeId===eq.id).length;
                return `<td class="tab-cell" style="font-weight:700;text-align:center;">${count}</td>`;
              }).join('')}
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;
  bindTabs();
  area.querySelectorAll('.tab-block').forEach(b=>{
    b.style.cursor = 'pointer';
  });
}
function getWeekNumber(d){
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const diff = d - oneJan;
  const oneWeek = 604800000;
  return Math.ceil((diff / oneWeek + oneJan.getDay() + 1) / 1);
}

function atribDetalheHtml(programacao, atrib, comAcoes=true){
  const pr = findProjeto(programacao.projetoId), eq = findEquipe(atrib.equipeId), late = isLate(atrib);
  const rows = atrib.atividades.map(a=>{
    const at = findAtividade(a.atividadeId);
    const prev = a.quantidadePrevista||0;
    const exec = atrib.status==='Concluído'? (a.quantidadeExecutada!=null? a.quantidadeExecutada : prev) : (a.quantidadeExecutada!=null? a.quantidadeExecutada : null);
    const vu = at?.valorUnitario||0;
    return { at, prev, exec, vu, vp: prev*vu, ve: (exec||0)*vu };
  });
  const totPrev = rows.reduce((s,r)=>s+r.vp,0);
  const totExec = rows.reduce((s,r)=>s+r.ve,0);
  const av = projetoAvanco(pr);
  const teamE = lastTeamEdit(atrib);
  return `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="dtl-header">
        <div style="min-width:0;">
          <div class="dtl-code">${esc(pr?.codigo||'—')} · ${esc(pr?.setor||'')} · ${esc(pr?.coordenacao||'')}</div>
          <div class="dtl-title">${esc(pr?.nome||'—')}</div>
          <div class="dtl-meta"><span>${icon('hash',12)} ${progGid(programacao)}</span><span>${icon('calendar',12)} Ciclo ${esc(programacao.ciclo||'—')}</span><span>${icon('trend',12)} Orçado ${fmtMoney(pr?.valorOrcado||0)}</span><span>${icon('star',12)} Avanço físico ${av.fisicoPct.toFixed(1)}%</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${projStatusBadge(pr?.status)}${teamBadgeHtml(atrib)}</div>
      </div>

      <div class="dtl-grid">
        <div class="dtl-tile"><div class="dtl-tile-lbl">Equipe</div><div class="dtl-tile-val"><span class="badge-prefix">${equipeLabel(eq)}</span></div>${metaWarningHtml(atrib)? `<div style="margin-top:6px;">${metaWarningHtml(atrib)}</div>`:''}</div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Data programada</div><div class="dtl-tile-val mono">${fmtDate(atrib.dataProgramada)}</div>${late? `<div class="late-flag" style="font-size:11px;margin-top:4px;">VENCIDA</div>`:''}</div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Encarregado</div><div class="dtl-tile-val">${esc(eq?.encarregado||'—')}</div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Status</div><div class="dtl-tile-val">${statusBadge(atrib.status, late)}</div></div>
        <div class="dtl-tile" style="grid-column:1/-1;"><div class="dtl-tile-lbl">Local de execução</div><div class="dtl-tile-val">${programacao.local? esc(programacao.local) : '—'}</div>${(programacao.local||programacao.localLat!=null)? `<div style="margin-top:4px;font-size:11.5px;"><a href="${esc(localMapsHref(programacao.local,programacao.localLat,programacao.localLng))}" target="_blank" rel="noopener" style="color:var(--blue);font-weight:600;">${icon('pin',11)} Abrir no Google Maps</a></div>`:''}</div>
      </div>

      ${teamE? `<div class="dtl-team-note">${icon('alert',14)} <div><strong>Alterada pela equipe</strong> em ${fmtDateTime(teamE.ts)} — ${esc(teamE.motivo||'')}</div></div>`:''}

      ${(() => {
        const todasFotos = (atrib.atividades||[]).flatMap(a => String(a.fotos||'').split(';;').filter(Boolean));
        if(!todasFotos.length) return '';
        return `<div class="dtl-section">
          <div class="dtl-section-head"><h4>Fotos da execução</h4><span class="mono">${todasFotos.length} foto(s)</span></div>
          <div style="padding:12px;display:flex;gap:8px;flex-wrap:wrap;">
            ${todasFotos.map((url, fi) => `<div class="dtl-exec-foto" data-fotos='${esc(JSON.stringify(todasFotos))}' data-idx="${fi}" style="width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);cursor:zoom-in;flex-shrink:0;"><img src="${esc(url)}" alt="Foto execução ${fi+1}" style="width:100%;height:100%;object-fit:cover;"></div>`).join('')}
          </div>
        </div>`;
      })()}

      <div class="dtl-section">
        <div class="dtl-section-head"><h4>Atividades</h4><span class="mono">${fmtMoney(totPrev)} previsto</span></div>
        <div class="table-scroll"><table class="min">
          <thead><tr><th>Código</th><th>Descrição</th><th>Un.</th><th>Prev.</th><th>Exec.</th><th>V. unit.</th><th>V. prev.</th><th>V. exec.</th></tr></thead>
          <tbody>${rows.map(r=>`<tr>
            <td class="mono" style="color:var(--accent);font-weight:700;">${esc(r.at?.codigo||'?')}</td>
            <td>${esc(r.at?.descricao||'')}</td><td>${esc(r.at?.unidade||'')}</td>
            <td class="mono">${r.prev||'—'}</td>
            <td class="mono">${r.exec!=null? r.exec:'—'}</td>
            <td class="mono">${fmtMoney(r.vu)}</td>
            <td class="mono">${fmtMoney(r.vp)}</td>
            <td class="mono">${fmtMoney(r.ve)}</td>
          </tr>`).join('')}
          <tr class="dtl-total-row"><td colspan="6">Totais</td><td class="mono">${fmtMoney(totPrev)}</td><td class="mono">${fmtMoney(totExec)}</td></tr>
          </tbody>
        </table></div>
      </div>

      ${(programacao.anexos&&programacao.anexos.length)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Anexos do programador</h4><span class="mono">${programacao.anexos.length} imagem(ns)</span></div>
        ${anexosDisplayHtml(programacao.anexos)}
      </div>`:''}

      ${(programacao.localLat!=null && programacao.localLng!=null)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Localização no mapa</h4></div>
        <div style="padding:12px;"><a href="${esc(staticMapUrl(programacao.localLat,programacao.localLng,16,800,450))}" target="_blank" rel="noopener">${localThumbHtml(programacao.local,programacao.localLat,programacao.localLng)}</a></div>
      </div>`:''}

      ${String(programacao.orientacoesPlanejamento||'').trim()? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Orientações do Setor de Planejamento</h4></div>
        <div style="white-space:pre-wrap;line-height:1.55;">${esc(programacao.orientacoesPlanejamento)}</div>
      </div>`:''}

      ${comAcoes? `<div class="dtl-actions">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="dtl-actions-lbl">Alterar status:</span>
          ${STATUS_PROG.filter(s=>s!==atrib.status).map(s=>`<button type="button" class="btn btn-sm" data-set-status="${s}">→ ${s}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm" data-whats-detail="${programacao.id}" data-whats-eq="${atrib.equipeId}">${icon('whatsapp',13)} Encaminhar WhatsApp</button>
          <button type="button" class="btn btn-sm" data-edit-detail="${programacao.id}">${icon('edit',13)} Editar programação</button>
          <button type="button" class="btn btn-sm" data-doc-detail="${programacao.id}">${icon('print',13)} Documento de campo</button>
          <button type="button" class="btn btn-sm" data-reprog-detail="${programacao.id}|${atrib.id}">${icon('reprog',13)} Reprogramar</button>
          <button type="button" class="btn btn-sm" data-hist-detail="${atrib.id}">${icon('history',13)} Histórico</button>
        </div>
      </div>`:''}
    </div>`;
}
function openAtribDetalhe(atribId){
  atribId = Number(atribId);
  let programacao, atrib;
  for(const pg of DB.programacoes){ const found = (pg.atribuicoes||[]).find(a=>a.id===atribId); if(found){ programacao=pg; atrib=found; break; } }
  if(!atrib) return;
  const body = atribDetalheHtml(programacao, atrib);
  openModal({ title:'Detalhe da programação', bodyHtml: body, submitLabel:'Fechar', wide:true,
    onMount:(root)=>{
      root.querySelectorAll('[data-set-status]').forEach(b=>b.addEventListener('click', ()=>{
        if(!requerEscrita()) return;
        pedirMotivoStatus(atrib.id, b.dataset.setStatus);
      }));
      root.querySelectorAll('[data-whats-detail]').forEach(b=>b.addEventListener('click', ()=>encaminharWhats(b.dataset.whatsDetail, b.dataset.whatsEq)));
      root.querySelectorAll('[data-edit-detail]').forEach(b=>b.addEventListener('click', ()=>{
        document.getElementById('modal-root').innerHTML='';
        openProgramacaoModal(b.dataset.editDetail);
      }));
      root.querySelectorAll('[data-doc-detail]').forEach(b=>b.addEventListener('click', ()=>openDocProgramacao(b.dataset.docDetail)));
      root.querySelectorAll('[data-reprog-detail]').forEach(b=>b.addEventListener('click', ()=>{ const [pgId,atId]=b.dataset.reprogDetail.split('|'); openReprogramarManual(pgId, atId); }));
      root.querySelectorAll('[data-hist-detail]').forEach(b=>b.addEventListener('click', ()=>openHistoricoModal(b.dataset.histDetail)));
    },
    onSubmit:()=>true
  });
}

/* --- criação/edição de programação com múltiplas equipes --- */
    function openProgramacaoModal(id){
      if(!requerEscrita()) return;
      const pg = id ? DB.programacoes.find(x=>x.id===Number(id)) : null;
      if(id && !progVisivelPorId(id)){ toast('Você não tem permissão para acessar esta programação.', 'error'); return; }
  let atribs = pg ? pg.atribuicoes.map(a=>({ equipeId:String(a.equipeId), atividades: a.atividades.map(x=>({atividadeId:String(x.atividadeId), quantidadePrevista:x.quantidadePrevista??''})) })) : [{ equipeId:'', atividades:[{atividadeId:'',quantidadePrevista:''}] }];
  let selProjeto = pg? findProjeto(pg.projetoId) : null;
  let anexos = pg ? (pg.anexos||[]).map(a=>({...a})) : [];
  let anexosEnviando = false;
  let localAddr = pg?.local||'';
  let localLat = pg?.localLat??null;
  let localLng = pg?.localLng??null;

  function atribBlockHtml(a,i){
    const eqList = equipesDoProjeto(selProjeto);
    // Garante que a equipe atual (se houver) apareça no dropdown mesmo se não passar no filtro
    if(a.equipeId){
      const currentEq = DB.equipes.find(e=>String(e.id)===String(a.equipeId));
      if(currentEq && !eqList.some(e=>String(e.id)===String(currentEq.id))){
        eqList.push(currentEq);
      }
    }
    const searchId = `prog-act-search-${i}`;
    return `<div class="atrib-block" data-idx="${i}">
      <div class="atrib-head">
        <select class="atrib-equipe" data-idx="${i}"><option value="">Selecione a equipe…</option>${eqList.map(e=>`<option value="${e.id}" ${String(a.equipeId)===String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' · '+esc(e.encarregado):''}</option>`).join('')}</select>
        ${atribs.length>1? `<button type="button" class="icon-btn atrib-remove" data-idx="${i}">${icon('trash',14)}</button>`:''}
      </div>
      <div class="atrib-meta-live" data-idx="${i}"></div>
      <div class="field" style="margin-bottom:8px;">
        <label for="${searchId}">${icon('search',14)} Buscar atividade (código ou descrição)</label>
        <input type="search" id="${searchId}" placeholder="Filtrar atividades…" style="width:100%;">
      </div>
      <div class="atrib-activities">${a.atividades.map((at,j)=>activityRowHtml(a,i,at,j)).join('')}</div>
      <button type="button" class="btn btn-sm btn-ghost atrib-add-activity" data-idx="${i}">${icon('plus',13)} Adicionar atividade</button>
    </div>`;
  }
  function activityRowHtml(a,i,at,j){
    return `<div class="activity-row" data-idx="${i}" data-jdx="${j}">
      <select class="act-select" data-idx="${i}" data-jdx="${j}"><option value="">Atividade…</option>${atividadesOrdenadas().map(x=>`<option value="${x.id}" ${String(at.atividadeId)===String(x.id)?'selected':''}>${isFavorita(x.id)?'★ ':''}${esc(x.codigo)} · ${esc(x.descricao)}</option>`).join('')}</select>
      <input type="number" step="0.01" min="0" class="act-qty" data-idx="${i}" data-jdx="${j}" placeholder="Qtd." value="${at.quantidadePrevista??''}">
      ${a.atividades.length>1? `<button type="button" class="icon-btn act-remove" data-idx="${i}" data-jdx="${j}">${icon('close',13)}</button>`:''}
    </div>`;
  }
  function renderAtribsHtml(){ return atribs.map((a,i)=> atribBlockHtml(a,i)).join(''); }

  const baseFieldsHtml = `
    <div class="field"><label>Projeto <span class="req">*</span></label><select name="projetoId" id="pg-projeto" required>${projetosVisiveis().filter(p=>!['Encerrado','Aguardando Viabilidade'].includes(p.status)).map(pr=>`<option value="${pr.id}" ${pg?.projetoId===pr.id?'selected':''}>${esc(pr.codigo)} · ${esc(pr.nome)}</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Setor</label><input type="text" id="pg-setor" disabled value=""><div class="field-hint">💡 Preenchido automaticamente do projeto.</div></div>
      <div class="field"><label>Coordenação</label><input type="text" id="pg-coord" disabled value=""><div class="field-hint">💡 Preenchido automaticamente do projeto.</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Data início <span class="req">*</span></label><input type="date" name="dataInicio" required value="${pg?.dataProgramada||''}"></div>
      <div class="field"><label>Data fim (opcional)</label><input type="date" name="dataFim" value="${pg?.dataProgramada||''}"><div class="field-hint">💡 Se preenchido, cria uma programação para cada dia no intervalo. Deixe vazio ou igual à data início para criar apenas 1 programação.</div></div>
    </div>
    <div class="field-row">
      <div class="field" style="flex:1;"><label>Ciclo recebido carteira <span class="req">*</span></label><input type="text" name="ciclo" class="ciclo-input" id="pg-ciclo" required maxlength="13" value="${esc(pg?.ciclo||'')}" placeholder="CICLO-XX/XXXX"><div class="field-hint">💡 Preenchido automaticamente do projeto; pode ser ajustado.</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Nº SI</label><input type="text" name="numeroSI" value="${esc(pg?.numeroSI||'')}" placeholder="Opcional"></div>
      <div class="field"><label>Status SI</label><select name="statusSI"><option value="">Selecione…</option>${['FALTA ELABORAR','ELABORADO','APROVADO','CONFIRMADO','CANCELADO'].map(v=>`<option ${pg?.statusSI===v?'selected':''}>${v}</option>`).join('')}</select><div class="field-hint">💡 Obrigatório quando o Nº SI for informado.</div></div>
    </div>
    <div class="field"><label>Observações gerais</label><textarea name="observacoes">${esc(pg?.observacoes||'')}</textarea></div>
    <div class="field">
      <label>Local / endereço de execução</label>
      <input type="text" name="local" id="pg-local" required value="${esc(pg?.local||'')}" placeholder="Digite o endereço onde a equipe vai executar…">
      <div class="field-hint">💡 Obrigatório. Enquanto você digita, geramos automaticamente o link do Google Maps com a localização. Também dá para abrir o mapa e marcar o ponto exato. O local e o mapa vão para o documento (PDF), para os registros e para a mensagem do WhatsApp.</div>
      <div id="pg-local-tools"></div>
      <div id="pg-map-wrap" style="display:none;margin-top:8px;">
        <div id="pg-local-map" style="height:460px;width:100%;border-radius:10px;overflow:hidden;border:1px solid var(--border-soft);"></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-primary" id="pg-map-confirm">Confirmar local no mapa</button>
          <button type="button" class="btn btn-sm btn-ghost" id="pg-map-cancel">Fechar mapa</button>
        </div>
      </div>
    </div>
    <div class="field"><label>Anexos do programador</label>
      <input type="file" id="pg-anexos-input" accept="image/*" multiple>
      <div class="field-hint">💡 Imagens para a equipe visualizar (croqui, localização, detalhe do serviço). Também saem no RDO. A programação só pode ser salva depois que todas as imagens terminarem de enviar.</div>
      <div id="pg-anexos-preview">${anexosGridHtml(anexos, true)}</div>
      <div id="pg-anexos-progress" style="display:none;margin-top:8px;">
        <div id="pg-anexos-progress-text" style="font-size:11px;color:var(--muted);margin-bottom:4px;">Enviando…</div>
        <div style="height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div id="pg-anexos-progress-fill" style="height:100%;width:0%;background:var(--accent);transition:width .2s;"></div></div>
      </div>
    </div>
    <div class="field"><label>Orientações do Setor de Planejamento</label>
      <textarea name="orientacoesPlanejamento" rows="3" placeholder="Orientação de execução, restrições, pontos de atenção para a equipe de campo...">${esc(pg?.orientacoesPlanejamento||'')}</textarea>
    </div>
    ${renderCustomFieldsInputs('programacoes', pg)}
    <div class="field"><label>Equipes e atividades <span class="req">*</span></label>
      <div id="atribs-container">${renderAtribsHtml()}</div>
      <button type="button" class="btn btn-sm" id="add-atrib-btn" style="margin-top:6px;align-self:flex-start;">${icon('plus',13)} Adicionar equipe</button>
    </div>`;

  openModal({
    title: pg? 'Editar programação' : 'Nova programação', bodyHtml: baseFieldsHtml, extraWide: true, submitLabel: pg? 'Salvar alterações':'Programar',
    onMount:(root)=>{
      bindCicloMasks(root);
      const projSel = root.querySelector('#pg-projeto');
      function applyProjetoData(){
        const pr = projSel.value? findProjeto(Number(projSel.value)) : null;
        selProjeto = pr;
        root.querySelector('#pg-setor').value = pr?.setor||'';
        root.querySelector('#pg-coord').value = pr?.coordenacao||'';
        root.querySelector('#pg-ciclo').value = pr?.ciclo? cicloMask(pr.ciclo) : '';
        refreshContainer();
      }
      projSel.addEventListener('change', applyProjetoData);
      applyProjetoData();
      function refreshContainer(){
        const ok = equipesDoProjeto(selProjeto);
        atribs.forEach(a=>{
          if(a.equipeId && !ok.some(e=>String(e.id)===String(a.equipeId))){
            const currentEq = DB.equipes.find(e=>String(e.id)===String(a.equipeId));
            if(!currentEq) a.equipeId=''; // só limpa se a equipe não existe mais
          }
        });
        document.getElementById('atribs-container').innerHTML = renderAtribsHtml(); bindDynamic();
      }
      function atualizarMetaIndicadores(){
        root.querySelectorAll('.atrib-meta-live').forEach(el=>{
          const i = Number(el.dataset.idx);
          const a = atribs[i];
          const eq = a && a.equipeId? findEquipe(a.equipeId) : null;
          const meta = metaDiaria(eq);
          const total = (a?.atividades||[]).reduce((s,at)=>{
            const atDef = at.atividadeId? findAtividade(at.atividadeId) : null;
            return s + (parseFloat(at.quantidadePrevista)||0) * (atDef?.valorUnitario||0);
          },0);
          if(!eq){ el.innerHTML=''; return; }
          if(!meta){
            el.innerHTML = `<div class="atrib-meta-wrap"><span style="font-size:11px;color:var(--muted);">Programação total: <strong>${fmtMoney(total)}</strong> (meta diária não definida para esta equipe)</span></div>`;
            return;
          }
          const pct = Math.round(total/meta*100);
          const cor = pct>=100? 'var(--green)' : pct>=50? 'var(--accent)' : 'var(--red)';
          el.innerHTML = `<div class="atrib-meta-wrap">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <strong style="font-size:11px;letter-spacing:.02em;">PROGRAMAÇÃO EM <span style="color:${cor};">${pct}%</span> DA META DA EQUIPE</strong>
              <span style="font-size:11px;color:var(--muted);">${fmtMoney(total)} de ${fmtMoney(meta)}</span>
            </div>
            <div class="atrib-meta-bar"><div style="width:${Math.min(100,pct)}%;background:${cor};"></div></div>
          </div>`;
        });
      }
      function bindDynamic(){
        root.querySelectorAll('.atrib-equipe').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].equipeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.atrib-remove').forEach(b=>b.addEventListener('click', e=>{ atribs.splice(Number(e.currentTarget.dataset.idx),1); refreshContainer(); }));
        root.querySelectorAll('.atrib-add-activity').forEach(b=>b.addEventListener('click', e=>{ atribs[Number(e.currentTarget.dataset.idx)].atividades.push({atividadeId:'',quantidadePrevista:''}); refreshContainer(); }));
        root.querySelectorAll('.act-select').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].atividadeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-qty').forEach(s=>s.addEventListener('input', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].quantidadePrevista = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-remove').forEach(b=>b.addEventListener('click', e=>{ const i=Number(e.currentTarget.dataset.idx), j=Number(e.currentTarget.dataset.jdx); atribs[i].atividades.splice(j,1); refreshContainer(); }));
        root.querySelectorAll('input[type="search"][id^="prog-act-search-"]').forEach(input=>{
          const idx = input.id.replace('prog-act-search-','');
          input.addEventListener('input', ()=>{
            const term = input.value.toLowerCase();
            root.querySelectorAll(`.act-select[data-idx="${idx}"]`).forEach(sel=>{
              const selected = sel.value;
              Array.from(sel.options).forEach(opt=>{
                if(opt.value==='') return;
                const txt = opt.textContent.toLowerCase();
                opt.style.display = txt.includes(term) ? '' : 'none';
              });
              if(selected && !Array.from(sel.options).find(o=>o.value===selected && o.style.display!=='none')){
                sel.value = '';
              }
            });
          });
        });
        atualizarMetaIndicadores();
      }
      bindDynamic();
      document.getElementById('add-atrib-btn').addEventListener('click', ()=>{ atribs.push({equipeId:'',atividades:[{atividadeId:'',quantidadePrevista:''}]}); refreshContainer(); });
      const anexosPreview = root.querySelector('#pg-anexos-preview');
      const anexosInput = root.querySelector('#pg-anexos-input');
      const anexosProgress = root.querySelector('#pg-anexos-progress');
      const anexosProgressText = root.querySelector('#pg-anexos-progress-text');
      const anexosProgressFill = root.querySelector('#pg-anexos-progress-fill');
      function paintAnexos(){
        anexosPreview.innerHTML = anexosGridHtml(anexos, true);
        anexosPreview.querySelectorAll('.anexo-remove').forEach(b=>b.addEventListener('click', ()=>{
          anexos.splice(Number(b.dataset.i),1); paintAnexos();
        }));
      }
      anexosInput.addEventListener('change', async ()=>{
        const files = Array.from(anexosInput.files||[]);
        if(!files.length) return;
        const sobra = Math.max(0, 8 - anexos.length);
        const fila = files.slice(0, sobra);
        if(files.length > sobra) toast('Máximo de 8 anexos por programação.', 'error');
        if(!fila.length){ anexosInput.value=''; return; }
        anexosInput.disabled = true;
        anexosEnviando = true;
        const total = fila.length;
        let feitos = 0;
        const atualizar = ()=>{
          anexosProgressFill.style.width = Math.round(feitos/total*100)+'%';
          anexosProgressText.textContent = total>1? `Enviando ${Math.min(feitos+1,total)} de ${total}…` : 'Enviando…';
        };
        anexosProgress.style.display = 'block';
        paintAnexos();
        atualizar();
        await Promise.all(fila.map(async (f)=>{
          let url = '';
          try{
            const blob = await comprimirImagem(f);
            url = await uploadToImgbb(blob);
          }catch(e){ toast('Falha ao enviar a imagem '+esc(f.name)+' ('+e.message+'). Tente novamente.', 'error'); }
          if(url) anexos.push({ nome: f.name||('anexo-'+Date.now()), url, ts: Date.now() });
          else toast('Falha ao enviar '+esc(f.name), 'error');
          feitos++;
          atualizar();
          paintAnexos();
        }));
        anexosEnviando = false;
        anexosProgress.style.display = 'none';
        anexosInput.disabled = false; anexosInput.value='';
        paintAnexos();
      });
      paintAnexos();
      /* --- Local / mapa (Geoapify) --- */
      const localInput = root.querySelector('#pg-local');
      const localTools = root.querySelector('#pg-local-tools');
      const mapWrap = root.querySelector('#pg-map-wrap');
      const mapEl = root.querySelector('#pg-local-map');
      let localDeb = null;
      let localMap = null, localMarker = null, localPicked = null;
      function paintLocalTools(){
        const btn = `<button type="button" class="btn btn-sm" id="pg-map-pick-btn">${icon('pin',13)} Selecionar no mapa</button>`;
        if(!localAddr && localLat==null && localLng==null){ localTools.innerHTML = `<div style="margin-top:8px;">${btn}</div>`; return; }
        localTools.innerHTML = `
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;">
            ${btn}
            <a href="${esc(localMapsHref(localAddr,localLat,localLng))}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;color:var(--blue);font-weight:600;font-size:12.5px;">${icon('pin',13)} Abrir no Google Maps</a>
            ${(localLat!=null && localLng!=null)? `<a href="${esc(staticMapUrl(localLat,localLng,15,640,320))}" target="_blank" rel="noopener" title="Clique para ampliar o mapa">${localThumbHtml(localAddr,localLat,localLng)}</a>`:''}
          </div>`;
      }
      async function geocodeLocal(addr){
        const g = await geoapifyGeocode(addr);
        if(String(addr).trim()!==String(localInput.value).trim()) return;
        if(!g){ localLat=null; localLng=null; paintLocalTools(); return; }
        localLat = g.lat; localLng = g.lng; localAddr = g.label; localInput.value = g.label;
        paintLocalTools();
      }
      localInput.addEventListener('input', ()=>{
        const val = localInput.value.trim();
        localAddr = val;
        clearTimeout(localDeb);
        localDeb = setTimeout(()=>{
          if(!val){ localLat=null; localLng=null; paintLocalTools(); return; }
          paintLocalTools();
          geocodeLocal(val);
        }, 700);
      });
      function initLocalMap(){
        if(localMap) return;
        loadLeaflet().then(L=>{
          const hasFix = (localLat!=null&&localLng!=null);
          const center = hasFix? [localLat, localLng] : [-17.79, -50.92];
          localMap = L.map(mapEl, { maxZoom:22, minZoom:2, zoomSnap:1, zoomControl:true, touchZoom:true, scrollWheelZoom:true, layers:[] }).setView(center, hasFix? 16 : 12);
          // 1) Satélite (Esri World Imagery) — gratuito, mundial, alta resolução, sem chave
          const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 20,
            maxNativeZoom: 20,
            attribution:'Tiles © <a href="https://www.esri.com/">Esri</a> — Source: Esri, Maxar, Earthstar Geographics'
          });
          // 2) Cartográfico (OSM) — fallback global
          const osmLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            maxNativeZoom: 19,
            attribution:'© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          });
          // 3) Geoapify (cartográfico melhorado) — se a chave funcionar
          const geoLayer = L.tileLayer('https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}{r}.png?apiKey={apiKey}', {
            apiKey: MAPS_KEY,
            maxZoom: 20,
            maxNativeZoom: 20,
            tileSize: 256,
            attribution:'Powered by <a href="https://www.geoapify.com/">Geoapify</a> | <a href="https://openmaptiles.org/">© OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>'
          });
          // Adiciona satélite como base padrão
          satLayer.addTo(localMap);
          // Controle de camadas para o usuário escolher
          L.control.layers({
            'Satélite (Esri)': satLayer,
            'Cartográfico (OSM)': osmLayer,
            'Cartográfico (Geoapify)': geoLayer
          }, null, {collapsed:false, position:'topright'}).addTo(localMap);
          function placeMarker(pos){
            if(localMarker){ localMarker.setLatLng(pos); }
            else { localMarker = L.marker(pos, {draggable:true, riseOnHover:true}).addTo(localMap); localMarker.on('dragend', ()=>{ localPicked = localMarker.getLatLng(); }); }
            const z = localMap.getZoom();
            if(z < 16) localMap.setView(pos, 16); else localMap.panTo(pos);
          }
          if(hasFix) placeMarker([localLat, localLng]);
          localMap.on('click', e=>{ localPicked = e.latlng; placeMarker(e.latlng); });
          setTimeout(()=>{ localMap.invalidateSize(); }, 60);
        }).catch(()=>{ toast('Não foi possível carregar o mapa.', 'error'); mapWrap.style.display='none'; });
      }
      localTools.addEventListener('click', e=>{
        if(!e.target.closest('#pg-map-pick-btn')) return;
        mapWrap.style.display='block';
        if(!localMap) initLocalMap();
        else setTimeout(()=>{ localMap.invalidateSize(); }, 60);
      });
      root.querySelector('#pg-map-confirm').addEventListener('click', async ()=>{
        if(!localPicked){ toast('Clique no mapa para posicionar o marcador.', 'error'); return; }
        const lat = localPicked.lat, lng = localPicked.lng;
        const addr = await geoapifyReverse(lat, lng);
        localLat = lat; localLng = lng;
        if(addr){ localAddr = addr; localInput.value = addr; }
        else { localAddr = localInput.value.trim()||'Ponto marcado no mapa'; }
        mapWrap.style.display='none';
        paintLocalTools();
        toast('Local marcado no mapa.');
      });
      root.querySelector('#pg-map-cancel').addEventListener('click', ()=>{ mapWrap.style.display='none'; });
      paintLocalTools();
    },
    onSubmit:(fd)=>{
      if(anexosEnviando){ toast('Aguarde o envio das imagens dos anexos antes de salvar.', 'error'); return false; }
      const ciclo = cicloMask(fd.get('ciclo'));
      if(!isCicloValido(ciclo)){ toast('Informe o ciclo recebido no formato CICLO-XX/XXXX (ex.: CICLO-01/2026).', 'error'); return false; }
      if(!atribs.length || atribs.some(a=>!a.equipeId)){ toast('Selecione a equipe em todos os blocos.', 'error'); return false; }
      for(const a of atribs){ if(!a.atividades.length || a.atividades.some(x=>!x.atividadeId)){ toast('Selecione a atividade em todas as linhas.', 'error'); return false; } }
      const dataInicio = fd.get('dataInicio'); const dataFim = fd.get('dataFim') || dataInicio;
      if(!dataInicio){ toast('Informe a data de início.', 'error'); return false; }
      if(dataFim && dataFim < dataInicio){ toast('A data fim não pode ser anterior à data início.', 'error'); return false; }
      const datas = gerarDatasIntervalo(dataInicio, dataFim || dataInicio);
      if(datas.length > 31){ toast('O intervalo não pode ultrapassar 31 dias.', 'error'); return false; }
      const projetoId = Number(fd.get('projetoId')); const observacoes = fd.get('observacoes').trim();
      const orientacoesPlanejamento = String(fd.get('orientacoesPlanejamento')||'').trim();
      const numeroSI = String(fd.get('numeroSI')||'').trim();
      let statusSI = String(fd.get('statusSI')||'');
      if(numeroSI && !statusSI){ toast('Informe o Status SI — obrigatório quando o Nº SI é preenchido.', 'error'); return false; }
      if(!numeroSI) statusSI = '';
      const custom = parseCustomFieldsFromForm('programacoes', fd);
      const local = String(fd.get('local')||'').trim()||localAddr||'';
      if(!local){ toast('Informe o local da programação.', 'error'); return false; }
      const locLat = local? localLat : null;
      const locLng = local? localLng : null;
      if(pg){
        const dataBaseAntiga = pg.dataProgramada;
        pg.projetoId = projetoId; pg.dataProgramada = dataInicio; pg.ciclo = ciclo; pg.observacoes = observacoes; pg.orientacoesPlanejamento = orientacoesPlanejamento; pg.custom = custom; pg.anexos = anexos; pg.local = local; pg.localLat = locLat; pg.localLng = locLng; pg.numeroSI = numeroSI; pg.statusSI = statusSI;
        const oldAtribs = pg.atribuicoes;
        pg.atribuicoes = atribs.map(a=>{
          const existing = oldAtribs.find(old => String(old.equipeId)===String(a.equipeId));
          const novasAtividades = a.atividades.map(x=>({atividadeId:Number(x.atividadeId), quantidadePrevista: x.quantidadePrevista?parseFloat(x.quantidadePrevista):null, quantidadeExecutada: existing? (existing.atividades.find(y=>y.atividadeId===Number(x.atividadeId))?.quantidadeExecutada ?? null) : null}));
          if(existing){ if(existing.dataProgramada===dataBaseAntiga) existing.dataProgramada = dataInicio; existing.atividades = novasAtividades; return existing; }
          return { id: nextId(), equipeId:Number(a.equipeId), dataProgramada: dataInicio, status:'Programado', atividades: novasAtividades, historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Atribuição adicionada à programação'}] };
        });
        toast('Programação atualizada.');
        registrarEvento('edicao','programacao',pg.id,progGid(pg), (pg.atribuicoes||[]).length+' equipe(s), '+pg.atribuicoes.reduce((s,a)=>s+(a.atividades?.length||0),0)+' atividade(s), '+anexos.length+' anexo(s)');
      } else {
        const grupoId = 'GRP-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
        let count = 0;
        for(const dt of datas){
          const novaProg = { id: nextId(), gid: novoGid(), grupoId, projetoId, dataProgramada: dt, ciclo, numeroSI, statusSI, observacoes, orientacoesPlanejamento, custom, anexos: anexos.map(a=>({...a})), local, localLat: locLat, localLng: locLng,
            atribuicoes: atribs.map(a=> ({ id: nextId(), equipeId:Number(a.equipeId), dataProgramada: dt, status:'Programado',
              atividades: a.atividades.map(x=>({atividadeId:Number(x.atividadeId), quantidadePrevista:x.quantidadePrevista?parseFloat(x.quantidadePrevista):null, quantidadeExecutada:null})),
              historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Programação criada'}] })) };
          DB.programacoes.push(novaProg);
          count++;
        }
        toast(count>1? count+' programações criadas no intervalo.' : 'Programação criada.');
        registrarEvento('criacao','programacao',DB.programacoes[DB.programacoes.length-1].id,progGid(DB.programacoes[DB.programacoes.length-1]), count+' programação(ões), '+atribs.length+' equipe(s), '+atribs.reduce((s,a)=>s+a.atividades.length,0)+' atividade(s), '+anexos.length+' anexo(s)');
      }
      saveData(); renderContent(); renderBanner();
    }
  });
}

function openReprogramarManual(pgId, atId){
  openReprogramarConfirmacao(atId);
}
    function openReprogramarConfirmacao(atribId, novaDataPrefill){
      if(!requerEscrita()) return;
      const atrib = findAtribuicaoGlobal(atribId);
  if(!atrib) return;
  if(['Concluído','Cancelado'].includes(atrib.status)){ toast('Não é possível reprogramar um item concluído ou cancelado.', 'error'); return; }
  const eq = findEquipe(atrib.equipeId);
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:4px;">Equipe ${equipeLabel(eq)}</div>
    <div class="field"><label>Data atual</label><input type="text" value="${fmtDate(atrib.dataProgramada)}" disabled></div>
    <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" name="novaData" required value="${novaDataPrefill||atrib.dataProgramada}"></div>
    <div class="field"><label>Motivo da reprogramação <span class="req">*</span></label><select name="motivo" required><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
    <div class="field"><label>Observações <span class="req">*</span></label><textarea name="obs" required placeholder="Descreva o motivo e as observações da reprogramação"></textarea></div>
  `;
  openModal({
    title:'Reprogramar programação', bodyHtml: body, submitLabel:'Confirmar reprogramação',
    onSubmit:(fd)=>{
      const novaData = fd.get('novaData'); const motivo = fd.get('motivo'); const obs = fd.get('obs').trim();
      if(!motivo){ toast('Selecione o motivo da reprogramação.', 'error'); return false; }
      if(!obs){ toast('Informe a observação da reprogramação.', 'error'); return false; }
      const dataAntiga = atrib.dataProgramada;
      atrib.dataProgramada = novaData; atrib.status = 'Reprogramado';
      atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
        const pgY = progDaAtribuicao(atrib.id);
        registrarEvento('reprogramacao','atribuicao',atrib.id, (pgY? progGid(pgY)+' · ': '')+equipeLabel(findEquipe(atrib.equipeId)), fmtDate(dataAntiga)+' → '+fmtDate(novaData)+' · '+motivo+(obs? ' · '+obs:''));
        saveData(); renderContent(); renderBanner(); toast('Programação reprogramada.');
    }
  });
}

/* =========================================================
   DOCUMENTO DE CAMPO (impressão / PDF)
========================================================= */
function equipePageUrl(progId, equipeId){
  let base = location.href.split(/[?#]/)[0];
  base = base.replace(/[\\/]index\.html$/i, '');
  if(base && !base.endsWith('/')) base += '/';
  return base + 'team.html?equipe=' + progId + (equipeId? '&e='+equipeId : '');
}
function equipePageUrlPoda(id, equipeId){
  let base = location.href.split(/[?#]/)[0];
  base = base.replace(/[\\/]index\.html$/i, '');
  if(base && !base.endsWith('/')) base += '/';
  return base + 'team.html?poda=' + id + (equipeId? '&e='+equipeId : '');
}
function equipePageUrlOse(id, equipeId){
  let base = location.href.split(/[?#]/)[0];
  base = base.replace(/[\\/]index\.html$/i, '');
  if(base && !base.endsWith('/')) base += '/';
  return base + 'team.html?ose=' + id + (equipeId? '&e='+equipeId : '');
}

/* ── WHATSAPP ── */
const WHATS_SUPORTE = '556496151084';
function phoneDigits(p){ return String(p||'').replace(/\D/g,''); }
function waLink(phone, text){ return 'https://wa.me/' + phoneDigits(phone) + '?text=' + encodeURIComponent(text); }

/* =========================================================
   LOCAL DE EXECUÇÃO — Geoapify (mapa, geocodificação e imagem)
========================================================= */
const MAPS_KEY = 'cb9a3186df512370a0b85db130ca34d1';
function mapsLinkByAddress(addr){ return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(String(addr||'').trim()); }
function mapsLinkByCoords(lat,lng){ return 'https://www.google.com/maps/search/?api=1&query='+Number(lat)+','+Number(lng); }
function staticMapEsriUrl(lat,lng,zoom,w,h){
  const z = zoom||16, width = w||640, height = h||360;
  const dLng = (360/Math.pow(2,z)) * (width/256);
  const dLat = (170.1022/Math.pow(2,z)) * (height/256);
  const minLng = Number(lng)-dLng, minLat = Number(lat)-dLat, maxLng = Number(lng)+dLng, maxLat = Number(lat)+dLat;
  const bbox = [minLng, minLat, maxLng, maxLat].map(v=>Number(v).toFixed(6)).join(',');
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&size=${width},${height}&imageSR=4326&format=png&f=image`;
}
function staticMapUrl(lat,lng,zoom,w,h){
  const z = zoom||16, width = Math.min((w||640), 650), height = Math.min((h||360), 450);
  return `https://static-maps.yandex.ru/1.x/?ll=${Number(lng)},${Number(lat)}&z=${z}&size=${width},${height}&l=map&pt=${Number(lng)},${Number(lat)},pm2rdm`;
}
function staticMapFallbackUrl(lat,lng,zoom,w,h){
  const z = zoom||16, width = w||640, height = h||360;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${Number(lat)},${Number(lng)}&zoom=${z}&size=${width}x${height}&markers=${Number(lat)},${Number(lng)},red-pushpin`;
}
function staticMapProximo(img){
  try{
    const srcs = JSON.parse(img.dataset.srcs||'[]');
    const n = (Number(img.dataset.si)||0)+1;
    if(n < srcs.length){ img.dataset.si = n; img.src = srcs[n]; }
    else { img.onerror = null; }
  }catch(e){ img.onerror = null; }
}
function staticMapImgTag(lat,lng,zoom,w,h,alt,style){
  const srcs = [staticMapEsriUrl(lat,lng,zoom,w,h), staticMapUrl(lat,lng,zoom,w,h), staticMapFallbackUrl(lat,lng,zoom,w,h)];
  return `<img src="${esc(srcs[0])}" data-srcs="${esc(JSON.stringify(srcs))}" alt="${esc(alt||'Mapa')}" style="${esc(style||'width:100%;max-width:520px;border-radius:8px;border:1px solid var(--border-soft);display:block;')}" onerror="staticMapProximo(this)">`;
}
async function geoapifyGeocode(addr){
  if(!String(addr||'').trim()) return null;
  try{
    const res = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(addr)}&apiKey=${MAPS_KEY}&limit=1&format=json`);
    if(!res.ok) return null;
    const j = await res.json();
    const f = j && j.features && j.features[0];
    if(!f) return null;
    const p = f.properties||{};
    return { lat:Number(f.lat??p.lat), lng:Number(f.lon??p.lon), label: p.formatted||String(addr) };
  }catch(e){ return null; }
}
async function geoapifyReverse(lat,lng){
  try{
    const res = await fetch(`https://api.geoapify.com/v1/geocode/reverse?lat=${Number(lat)}&lon=${Number(lng)}&apiKey=${MAPS_KEY}&limit=1&format=json`);
    if(!res.ok) return '';
    const j = await res.json();
    const p = j && j.features && j.features[0] && j.features[0].properties;
    return (p && p.formatted)||'';
  }catch(e){ return ''; }
}
function localMapsHref(local, lat, lng){
  if(lat!=null && lng!=null) return mapsLinkByCoords(lat,lng);
  return mapsLinkByAddress(local);
}
function qrCodeUrl(data, size=120){
  return 'https://api.qrserver.com/v1/create-qr-code/?size='+size+'x'+size+'&data='+encodeURIComponent(data);
}
function localThumbHtml(local, lat, lng){
  if(lat==null || lng==null) return '';
  return staticMapImgTag(lat,lng,17,640,320, 'Mapa: '+(local||''), 'width:100%;max-width:520px;border-radius:8px;border:1px solid var(--border-soft);display:block;');
}
let _leafletLoaded = null;
function loadLeaflet(){
  if(_leafletLoaded) return _leafletLoaded;
  if(window.L){ _leafletLoaded = Promise.resolve(window.L); return _leafletLoaded; }
  _leafletLoaded = new Promise((resolve,reject)=>{
    const link = document.createElement('link');
    link.rel='stylesheet'; link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    const sc = document.createElement('script');
    sc.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    sc.onload = ()=> resolve(window.L);
    sc.onerror = ()=> reject(new Error('Falha ao carregar o mapa'));
    document.head.appendChild(sc);
  });
  return _leafletLoaded;
}
function localWhatsLine(local, lat, lng){
  if(!local && (lat==null || lng==null)) return '';
  if(lat!=null && lng!=null){
    return [`*Local:* ${local||'Ponto marcado no mapa'}`,`*Ver no mapa:* ${mapsLinkByCoords(lat,lng)}`,`*Imagem da localização:* ${staticMapEsriUrl(lat,lng,15,640,360)}`];
  }
  return [`*Local:* ${local}`,`*Ver no mapa:* ${mapsLinkByAddress(local)}`];
}
function buildWhatsMessage(prog, atrib){
  const pr = findProjeto(prog.projetoId);
  const eq = findEquipe(atrib.equipeId);
  const ativs = (atrib.atividades||[]).map((a,i)=>{
    const at = findAtividade(a.atividadeId);
    return `${i+1}. *${at?.codigo||'?'}* · ${at?.descricao||''} — ${a.quantidadePrevista??'—'} ${at?.unidade||''}`;
  }).join('\n');
  return [
    `*G26 New · Programação de Redes Elétricas*`,
    ``,
    `*Programação:* ${progGid(prog)}`,
    `*Projeto:* ${pr?.nome||'—'} (${pr?.codigo||''})`,
    `*Setor:* ${pr?.setor||'—'}  ·  *Coordenação:* ${pr?.coordenacao||'—'}`,
    `*Data:* ${fmtDate(atrib.dataProgramada)}  ·  *Ciclo:* ${prog.ciclo||'—'}`,
    `*Equipe:* ${equipeLabel(eq)}`,
    ``,
    ...localWhatsLine(prog.local, prog.localLat, prog.localLng),
    ``,
    `*Atividades programadas:*`,
    ativs||'—',
    ``,
    `*Supervisor:* ${eq?.supervisor||'—'}`,
    `*Encarregado:* ${eq?.encarregado||'—'}  ·  *Motorista:* ${eq?.motorista||'—'}`,
    ``,
    `*Acesso da equipe (QR):*`,
    equipePageUrl(prog.id, atrib.equipeId),
    ``,
    `_Caso tenha problemas técnicos com a ferramenta, entre em contato:_`,
    `https://wa.me/${WHATS_SUPORTE}`
  ].join('\n');
}
function encaminharWhats(progId, filtroEquipeId){
  const prog = DB.programacoes.find(p=>p.id===Number(progId));
  if(!prog) return;
  let teams = (prog.atribuicoes||[]).filter(a=>a.status!=='Cancelado');
  if(filtroEquipeId) teams = teams.filter(a=>String(a.equipeId)===String(filtroEquipeId));
  if(!teams.length) return;
  if(teams.length===1){
    const atrib = teams[0];
    const eq = findEquipe(atrib.equipeId);
    if(!eq?.whatsapp || !phoneDigits(eq.whatsapp)){ toast('Sem WhatsApp cadastrado para: '+equipeLabel(eq)+'. Edite a equipe e informe o número.', 'error'); return; }
    window.open(waLink(eq.whatsapp, buildWhatsMessage(prog, atrib)), '_blank');
    toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
    registrarEvento('compartilhamento','programacao',prog.id,progGid(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
    return;
  }
  const body = teams.map(atrib=>{
    const eq = findEquipe(atrib.equipeId);
    const temWhats = eq?.whatsapp && phoneDigits(eq.whatsapp);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(equipeLabel(eq))}</div>
        <div style="font-size:11px;color:var(--muted-2);">${temWhats? esc(eq.whatsapp) : 'Sem WhatsApp cadastrado'}</div>
      </div>
      <button type="button" class="btn btn-sm${temWhats?' btn-primary':' btn-ghost'}" ${temWhats?`data-wa-send="${atrib.equipeId}"`:'disabled'} style="white-space:nowrap;">${icon('whatsapp',13)} Enviar</button>
    </div>`;
  }).join('');
  openModal({
    title: 'Encaminhar para equipe(s)',
    bodyHtml: `<div style="margin-bottom:8px;font-size:12px;color:var(--muted);">Selecione a equipe para enviar a programação via WhatsApp. Cada equipe receberá apenas suas atividades.</div>${body}`,
    submitLabel: 'Enviar para todas',
    onSubmit: ()=>{
      teams.forEach(atrib=>{
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildWhatsMessage(prog, atrib)), '_blank');
        }
      });
      toast(teams.length+' mensagem(ns) encaminhada(s).');
      registrarEvento('compartilhamento','programacao',prog.id,progGid(prog), 'Encaminhado via WhatsApp para '+teams.length+' equipe(s)');
      return true;
    },
    onMount: (root)=>{
      root.querySelectorAll('[data-wa-send]').forEach(b=>b.addEventListener('click', ()=>{
        const eqId = Number(b.dataset.waSend);
        const atrib = teams.find(a=>a.equipeId===eqId);
        if(!atrib) return;
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildWhatsMessage(prog, atrib)), '_blank');
          toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
          registrarEvento('compartilhamento','programacao',prog.id,progGid(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
        }
      }));
    }
  });
}
function qrSvgHtml(url, cellSize){
  if(typeof qrcode==='undefined' || !url) return '';
  try{
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(cellSize||3, 2);
  }catch(e){ return ''; }
}
function printDocumento(html){
  const root = document.getElementById('print-root');
  root.innerHTML = `<div class="print-sheet">${html}</div>`;
  const imgs = root.querySelectorAll('img');
  if(!imgs.length){ window.print(); return; }
  const inicio = Date.now();
  let impresso = false;
  function tentarImprimir(){
    if(impresso) return;
    if(Date.now()-inicio > 8000){ impresso=true; window.print(); return; }
    const pendentes = Array.from(imgs).filter(img=> !img.complete || img.naturalWidth===0).length;
    if(pendentes===0){ impresso=true; window.print(); return; }
    setTimeout(tentarImprimir, 250);
  }
  tentarImprimir();
}
function printProjeto(id){
  const pj = findProjeto(id);
  if(!pj){ toast('Projeto não encontrado.', 'error'); return; }
  printDocumento(buildDocProjeto(pj));
}
function buildDocProjeto(pj){
  const av = projetoAvanco(pj);
  const programacoes = DB.programacoes.filter(p=>p.projetoId===pj.id);
  const countProg = programacoes.length;
  const countEquipes = programacoes.reduce((s,pg)=>s+(pg.atribuicoes?.length||0),0);
  const totalAtividades = programacoes.reduce((s,pg)=>s+pg.atribuicoes.reduce((t,a)=>t+(a.atividades?.length||0),0),0);
  const qrUrl = location.origin + location.pathname.replace(/\/[^/]*$/,'') + '/team.html?projeto=' + pj.id;
  const statusColors = {'Aguardando Viabilidade':'#2563eb','Em Andamento':'#f59e0b','Concluído':'#16a34a','Encerrado':'#6b7280','Cancelado':'#dc2626'};
  const statusColor = statusColors[pj.status]||'#6b7280';
  const diasVencimento = pj.dataVencimento ? diasEntre(todayISO(), pj.dataVencimento) : null;
  const diasViabilidade = pj.dataRecebimentoCarteira && !pj.dataViabilizacao ? diasEntre(todayISO(), prazoViabilidadeProjeto(pj)) : null;
  const alertaVenc = (diasVencimento!=null && diasVencimento<0) ? `VENCIDO há ${-diasVencimento} dia(s)` : (diasVencimento!=null && diasVencimento===0 ? 'Vence hoje' : (diasVencimento!=null && diasVencimento<=5 ? `Vence em ${diasVencimento} dia(s)` : ''));
  const alertaViab = (diasViabilidade!=null && diasViabilidade<0) ? `VIABILIDADE ATRASADA ${-diasViabilidade} dia(s)` : (diasViabilidade!=null && diasViabilidade<=5 ? `Viabilizar em ${diasViabilidade} dia(s)` : '');
  const plano = pj.planoFisico||[];
  const rowsPlano = plano.map((x,idx)=>{
    const at = findAtividade(x.atividadeId);
    return `<tr><td style="text-align:center;">${idx+1}</td><td class="mono" style="font-weight:700;">${esc(at?.codigo||'?')}</td><td>${esc(at?.descricao||'')}</td><td style="text-align:center;">${esc(at?.unidade||'')}</td><td style="text-align:center;">${x.quantidade??'—'}</td></tr>`;
  }).join('') || '<tr><td colspan="5" style="text-align:center;color:#666;padding:12px;">Nenhuma atividade no plano físico</td></tr>';
  const rowsProg = programacoes.map(pg=>{
    const atrCount = pg.atribuicoes?.length||0;
    const atvCount = pg.atribuicoes.reduce((s,a)=>s+(a.atividades?.length||0),0);
    const eqLabels = pg.atribuicoes.map(a=>equipeLabel(findEquipe(a.equipeId))).join(', ')||'—';
    return `<tr><td>${esc(progGid(pg))}</td><td>${fmtDate(pg.dataProgramada)}</td><td>${esc(pg.ciclo||'—')}</td><td>${atrCount}</td><td>${atvCount}</td><td>${esc(eqLabels)}</td><td>${projStatusBadge(pg.status)}</td></tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:#666;padding:12px;">Nenhuma programação vinculada</td></tr>';
  const customFields = DB.customFields.projetos||[];
  const customRows = customFields.map(f=>`<tr><th>${esc(f.label)}</th><td colspan="3">${esc(pj.custom?.[f.id]||'—')}</td></tr>`).join('');
  return `
  <div class="ps-head" style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:start;border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px;">
    <div style="border:2px solid ${statusColor};border-radius:8px;padding:12px;background:${statusColor}15;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:${statusColor};font-weight:700;margin-bottom:6px;">STATUS DO PROJETO</div>
      <div style="font-size:14px;font-weight:700;color:${statusColor};">${pj.status}</div>
      ${alertaVenc? `<div style="margin-top:8px;padding:6px 8px;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;font-size:11px;color:#991b1b;">${icon('alert',12)} ${alertaVenc}</div>`:''}
      ${alertaViab? `<div style="margin-top:8px;padding:6px 8px;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;font-size:11px;color:#92400e;">${icon('alert',12)} ${alertaViab}</div>`:''}
      <div style="margin-top:10px;border-top:1px solid ${statusColor}40;padding-top:10px;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-bottom:4px;">AÇÕES DISPONÍVEIS</div>
        <ul style="margin:0;padding-left:16px;font-size:11px;line-height:1.8;color:#333;">
          <li>${pj.status==='Aguardando Viabilidade'? 'Viabilizar projeto (preencha data de viabilização)' : pj.status==='Em Andamento'? 'Criar programações, acompanhar avanço' : pj.status==='Concluído'? 'Encerrar projeto' : '—'}</li>
          <li>Imprimir / exportar PDF deste relatório</li>
          <li>Ver programações vinculadas</li>
          <li>${pj.status!=='Encerrado' && pj.status!=='Cancelado'? 'Editar dados do projeto' : 'Projeto finalizado'}</li>
        </ul>
      </div>
    </div>
    <div>
      <h1 style="margin:0;font-size:18px;font-weight:700;color:#000;">${esc(pj.codigo)} · ${esc(pj.nome)}</h1>
      <div style="margin-top:4px;font-size:12px;color:#333;">${esc(pj.descricao||'')}</div>
      <div style="display:flex;gap:24px;margin-top:10px;font-size:11px;color:#444;flex-wrap:wrap;">
        <div><strong>Setor/Coord.:</strong> ${esc(pj.setor||'—')} / ${esc(pj.coordenacao||'—')}</div>
        <div><strong>Cidade:</strong> ${esc(pj.cidade||'—')}</div>
        <div><strong>Ciclo:</strong> ${esc(pj.ciclo||'—')}</div>
        <div><strong>Período:</strong> ${fmtDate(pj.dataInicio)} → ${fmtDate(pj.dataFim||'—')}</div>
        <div><strong>Receb. carteira:</strong> ${fmtDate(pj.dataRecebimentoCarteira)}${pj.dataViabilizacao? ` · Viabilizado: ${fmtDate(pj.dataViabilizacao)}` : ''}</div>
        <div><strong>Vencimento:</strong> ${fmtDate(pj.dataVencimento||'—')}</div>
        <div><strong>Orçado:</strong> ${fmtMoney(pj.valorOrcado||0)}</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <div class="ps-qr" style="flex-shrink:0;">${qrSvgHtml(qrUrl, 3)}<div class="ps-qr-cap">Escaneie para ver detalhes</div></div>
        <div style="font-size:10px;color:#666;max-width:280px;">Link do projeto: ${esc(qrUrl)}</div>
      </div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:14px;">
    <div class="ps-block" style="break-inside:avoid;">
      <div class="ps-block-head">AVANÇO FÍSICO / FINANCEIRO</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div style="border:1px solid #ddd;border-radius:6px;padding:10px;background:#fafafa;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-bottom:4px;">FÍSICO</div>
          <div style="font-size:22px;font-weight:700;color:${av.fisicoPct>=100?'#16a34a':av.fisicoPct>=80?'#f59e0b':'#2563eb'};">${av.fisicoPct.toFixed(1)}%</div>
          <div style="font-size:10.5px;color:#666;margin-top:2px;">${av.concluidoLinhas}/${av.totalLinhas} linhas concluídas</div>
        </div>
        <div style="border:1px solid #ddd;border-radius:6px;padding:10px;background:#fafafa;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-bottom:4px;">FINANCEIRO</div>
          <div style="font-size:22px;font-weight:700;color:${av.financeiroPct>=100?'#16a34a':av.financeiroPct>=80?'#f59e0b':'#2563eb'};">${av.financeiroPct.toFixed(1)}%</div>
          <div style="font-size:10.5px;color:#666;margin-top:2px;">Executado: ${fmtMoney(av.financeiroExecutado)} / ${fmtMoney(pj.valorOrcado||0)}</div>
          <div style="font-size:10.5px;color:#666;margin-top:2px;">Restante: ${fmtMoney(av.restante)}</div>
        </div>
      </div>
    </div>
    <div class="ps-block" style="break-inside:avoid;">
      <div class="ps-block-head">RESUMO DE PROGRAMAÇÕES</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;text-align:center;">
        <div style="border:1px solid #ddd;border-radius:6px;padding:8px;background:#f0f9ff;"><div style="font-size:20px;font-weight:700;color:#2563eb;">${countProg}</div><div style="font-size:10px;color:#666;">Programações</div></div>
        <div style="border:1px solid #ddd;border-radius:6px;padding:8px;background:#f0fdf4;"><div style="font-size:20px;font-weight:700;color:#16a34a;">${countEquipes}</div><div style="font-size:10px;color:#666;">Equipes</div></div>
        <div style="border:1px solid #ddd;border-radius:6px;padding:8px;background:#fef3c7;"><div style="font-size:20px;font-weight:700;color:#f59e0b;">${totalAtividades}</div><div style="font-size:10px;color:#666;">Atividades</div></div>
      </div>
    </div>
  </div>
  <div class="ps-block" style="break-inside:avoid;margin-bottom:14px;">
    <div class="ps-block-head">PLANO FÍSICO — ATIVIDADES PREVISTAS</div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
      <thead><tr style="background:#f4f4f4;"><th style="width:30px;border:1px solid #444;padding:4px;">#</th><th style="width:70px;border:1px solid #444;padding:4px;">Código</th><th style="border:1px solid #444;padding:4px;">Descrição</th><th style="width:50px;border:1px solid #444;padding:4px;">Unid.</th><th style="width:60px;border:1px solid #444;padding:4px;">Qtd.</th></tr></thead>
      <tbody>${rowsPlano}</tbody>
    </table>
  </div>
  ${programacoes.length? `
  <div class="ps-block" style="break-inside:avoid;margin-bottom:14px;">
    <div class="ps-block-head">PROGRAMAÇÕES VINCULADAS</div>
    <table style="width:100%;border-collapse:collapse;font-size:10px;">
      <thead><tr style="background:#f4f4f4;"><th style="border:1px solid #444;padding:4px;">GID</th><th style="border:1px solid #444;padding:4px;">Data</th><th style="border:1px solid #444;padding:4px;">Ciclo</th><th style="width:50px;border:1px solid #444;padding:4px;">Eqps</th><th style="width:50px;border:1px solid #444;padding:4px;">Atvs</th><th style="border:1px solid #444;padding:4px;">Equipes</th><th style="border:1px solid #444;padding:4px;">Status</th></tr></thead>
      <tbody>${rowsProg}</tbody>
    </table>
  </div>`:''}
  ${programacoes.length? `
  <div class="ps-block" style="break-inside:avoid;margin-bottom:14px;">
    <div class="ps-block-head">DETALHES DAS PROGRAMAÇÕES (por equipe)</div>
    ${programacoes.map(pg=>{
      const prLocal = pg.local? `<tr><th style="border:1px solid #444;padding:4px;background:#f4f4f4;width:110px;">Local de execução</th><td style="border:1px solid #444;padding:4px;" colspan="5"><strong>${esc(pg.local)}</strong>${(pg.localLat!=null&&pg.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(pg.localLat,pg.localLng))}">${esc(mapsLinkByCoords(pg.localLat,pg.localLng))}</a>`:''}</td></tr>`:'';
      const prObs = String(pg.orientacoesPlanejamento||'').trim()? `<tr><th style="border:1px solid #444;padding:4px;background:#f4f4f4;">Orientações</th><td style="border:1px solid #444;padding:4px;white-space:pre-wrap;" colspan="5">${esc(pg.orientacoesPlanejamento)}</td></tr>`:'';
      return `
      <div style="margin-bottom:12px;break-inside:avoid;">
        <div style="font-weight:700;font-size:11.5px;border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:6px;">${progGid(pg)} — ${fmtDate(pg.dataProgramada)} — Ciclo ${esc(pg.ciclo||'—')}</div>
        <table style="width:100%;border-collapse:collapse;font-size:9.5px;">
          <thead><tr style="background:#f4f4f4;"><th style="border:1px solid #444;padding:4px;width:110px;">Equipe</th><th style="border:1px solid #444;padding:4px;width:60px;">Encarregado</th><th style="border:1px solid #444;padding:4px;width:62px;">Código</th><th style="border:1px solid #444;padding:4px;">Atividade</th><th style="border:1px solid #444;padding:4px;width:46px;">Prev.</th><th style="border:1px solid #444;padding:4px;width:46px;">Exec.</th><th style="border:1px solid #444;padding:4px;width:70px;">Status</th></tr></thead>
          <tbody>${(pg.atribuicoes||[]).map(at=>{
            const eq = findEquipe(at.equipeId);
            const linhas = (at.atividades||[]).map(a=>{
              const atDef = findAtividade(a.atividadeId);
              const exec = at.status==='Concluído' ? (a.quantidadeExecutada!=null? a.quantidadeExecutada : a.quantidadePrevista) : (a.quantidadeExecutada!=null? a.quantidadeExecutada : null);
              return `<tr><td>${esc(equipeLabel(eq))}</td><td>${esc(eq?.encarregado||'—')}</td><td class="mono" style="font-weight:700;">${esc(atDef?.codigo||'?')}</td><td>${esc(atDef?.descricao||'')}</td><td style="text-align:center;">${a.quantidadePrevista??'—'}</td><td style="text-align:center;">${exec!=null?exec:'—'}</td><td>${esc(at.status||'—')}</td></tr>`;
            }).join('') || `<tr><td colspan="7" style="border:1px solid #444;padding:4px;color:#666;">Sem atividades</td></tr>`;
            return linhas;
          }).join('')}</tbody>
        </table>
        ${prLocal}
        ${prObs}
      </div>`;
    }).join('')}
  </div>`:''}
  ${customRows? `
  <div class="ps-block" style="break-inside:avoid;margin-bottom:14px;">
    <div class="ps-block-head">CAMPOS PERSONALIZADOS</div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
      <tbody>${customRows}</tbody>
    </table>
  </div>`:''}
  <div style="margin-top:10px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;display:flex;justify-content:space-between;">
    <div>Assinatura do responsável: <span class="ps-line" style="width:260px;"></span></div>
    <div>Data: ____/____/____</div>
  </div>`;
}
function docAtribuicaoHtml(prog, atrib){
  const pr = findProjeto(prog.projetoId);
  const eq = findEquipe(atrib.equipeId);
  const rows = atrib.atividades.map((a,idx)=>{
    const at = findAtividade(a.atividadeId);
    return `<tr>
      <td style="text-align:center;">${idx+1}</td>
      <td class="mono" style="font-weight:700;">${esc(at?.codigo||'?')}</td>
      <td>${esc(at?.descricao||'')}</td>
      <td style="text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="text-align:center;">${a.quantidadePrevista??'—'}</td>
      <td style="height:22px;"></td>
      <td></td>
    </tr>`;
  }).join('');
  const qrUrl = equipePageUrl(prog.id, atrib.equipeId);
  return `
  <div class="ps-block">
    <div class="ps-block-head">
      <div>${progGid(prog)} — ${esc(pr?.nome||'Projeto')} (${esc(pr?.codigo||'')}) — ${equipeLabel(eq)} — ${fmtDate(atrib.dataProgramada)}</div>
      <div class="ps-qr">${qrSvgHtml(qrUrl, 3)}<div class="ps-qr-cap">Escaneie para alterar as atividades</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Supervisor</th><td>${esc(eq?.supervisor||'—')}</td><th>Encarregado</th><td>${esc(eq?.encarregado||'—')}</td></tr>
      <tr><th>Motorista</th><td>${esc(eq?.motorista||'—')}</td><th>Eletricistas</th><td>${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</td></tr>
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:''}</td></tr>`:''}
    </table>
    <table>
      <thead><tr><th style="width:26px;">#</th><th>Código</th><th>Descrição</th><th style="width:40px;">Un.</th><th style="width:52px;">Qtd prev.</th><th style="width:64px;">Qtd exec.</th><th>Obs.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="ps-check"><div><strong>Executou?</strong> &nbsp;☐ SIM &nbsp;☐ NÃO &nbsp;☐ PARCIAL</div><div><strong>Data da execução:</strong> ____/____/____</div></div>
    <div class="ps-sign"><strong>Observações do campo:</strong><div class="ps-obs"></div></div>
    <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
  </div>`;
}
function buildDocProgramacao(prog){
  const pr = findProjeto(prog.projetoId);
  return `
    <div class="ps-head">
      <div><h1>G26 New · Programação de Redes Elétricas</h1><div class="ps-sub">Documento de campo — programação</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(prog.dataProgramada)}</div><div class="ps-sub">Emissão: ${fmtDateTime(Date.now())}</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Programação</th><td><strong>${progGid(prog)}</strong></td><th>Emissão</th><td>${fmtDateTime(Date.now())}</td></tr>
      <tr><th>Projeto</th><td colspan="3"><strong>${esc(pr?.nome||'—')}</strong> (${esc(pr?.codigo||'')})</td></tr>
      <tr><th>Setor</th><td>${esc(pr?.setor||'—')}</td><th>Coordenação</th><td>${esc(pr?.coordenacao||'—')}</td></tr>
      <tr><th>Ciclo</th><td>${esc(prog.ciclo||'—')}</td><th>Valor orçado</th><td>${fmtMoney(pr?.valorOrcado||0)}</td></tr>
      <tr><th>Período do projeto</th><td colspan="3">${fmtDate(pr?.dataInicio)} → ${fmtDate(pr?.dataFim)}</td></tr>
      ${prog.observacoes? `<tr><th>Observações gerais</th><td colspan="3">${esc(prog.observacoes)}</td></tr>`:''}
      ${String(prog.orientacoesPlanejamento||'').trim()? `<tr><th>Orientações do Setor de Planejamento</th><td colspan="3">${esc(prog.orientacoesPlanejamento)}</td></tr>`:''}
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:(prog.local? ` — <a href="${esc(mapsLinkByAddress(prog.local))}">${esc(mapsLinkByAddress(prog.local))}</a>`:'')}</td></tr>`:''}
    </table>
    ${prog.atribuicoes.map(at=> docAtribuicaoHtml(prog, at)).join('')}
    ${(prog.localLat!=null&&prog.localLng!=null)? `<div class="ps-block" style="page-break-before:auto;break-before:auto;margin-top:8px;">
      <div class="ps-block-head">Localização no mapa — ${progGid(prog)}</div>
      ${staticMapImgTag(prog.localLat,prog.localLng,16,720,420, 'Mapa: '+(prog.local||''), 'width:100%;max-width:620px;border:1px solid #999;border-radius:4px;')}
      <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div class="ps-qr-box">${qrSvgHtml(mapsLinkByCoords(prog.localLat,prog.localLng), 4)}</div>
        <div style="font-size:11px;color:#333;"><strong>Escaneie para abrir no Google Maps</strong><br>${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</div>
      </div>
    </div>`:''}
    <div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>
    ${docAnexosHtml(prog)}
  `;
}
function docAnexosHtml(prog){
  const anexos = prog.anexos||[];
  if(!anexos.length) return '';
  return `
  <div class="ps-block" style="page-break-before:always;break-before:page;">
    <div class="ps-block-head">Anexos do programador — ${progGid(prog)}</div>
    <div class="ps-anexos">
      ${anexos.map(a=>`<figure class="ps-anexo"><img src="${esc(anexoSrc(a))}" alt="${esc(a.nome||'anexo')}"><figcaption>${esc(a.nome||'')}</figcaption></figure>`).join('')}
    </div>
    <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
  </div>`;
}
function docAnexosHtmlGeneric(prog, labelFn){
  const anexos = prog.anexos||[];
  if(!anexos.length) return '';
  return `
  <div class="ps-block" style="page-break-before:always;break-before:page;">
    <div class="ps-block-head">Anexos do programador — ${labelFn(prog)}</div>
    <div class="ps-anexos">
      ${anexos.map(a=>`<figure class="ps-anexo"><img src="${esc(anexoSrc(a))}" alt="${esc(a.nome||'anexo')}"><figcaption>${esc(a.nome||'')}</figcaption></figure>`).join('')}
    </div>
    <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
  </div>`;
}
function buildDocData(data, list){
  return `
    <div class="ps-head">
      <div><h1>G26 New · Programação de Redes Elétricas</h1><div class="ps-sub">Documento de campo — ${fmtDate(data)}</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(data)}</div><div class="ps-sub">${list.length} equipe(s) programada(s)</div></div>
    </div>
    ${list.map(x=> docAtribuicaoHtml(x.programacao, x.atribuicao)).join('')}
    <div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>
  `;
}
function openDocumentoDataModal(){
  const body = `
    <div class="field"><label>Data <span class="req">*</span></label><input type="date" name="data" required value="${todayISO()}"></div>
    <div class="field-hint">💡 Gera um documento de campo com todas as equipes programadas nesta data, para imprimir e preencher em campo.</div>`;
  openModal({
    title:'Documento de campo — por data', bodyHtml:body, submitLabel:'Gerar e imprimir',
    onSubmit:(fd)=>{
      const data = fd.get('data');
      if(!data){ toast('Informe a data.', 'error'); return false; }
      const list = flatAtribuicoes().filter(x=> x.atribuicao.dataProgramada===data && x.atribuicao.status!=='Cancelado');
      if(!list.length){ toast('Nenhuma programação nesta data.', 'error'); return false; }
      printDocumento(buildDocData(data, list));
    }
  });
}
function openDocProgramacao(pgId){
  const prog = DB.programacoes.find(p=>p.id===Number(pgId));
  if(!prog) return;
  printDocumento(buildDocProgramacao(prog));
}

/* =========================================================
   HISTÓRICO
========================================================= */
function globalHistorico(){
  const events = [];
  flatAtribuicoes().forEach(x=> (x.atribuicao.historico||[]).forEach(h=> events.push({...h, atribId:x.atribuicao.id, projetoId:x.programacao.projetoId, equipeId:x.atribuicao.equipeId})));
  return events.sort((a,b)=> b.ts - a.ts);
}
const HIST_TIPOS = [{v:'',l:'Todos os eventos'},{v:'criacao',l:'Criação'},{v:'status',l:'Mudança de status'},{v:'reprogramacao',l:'Reprogramação'},{v:'confirmacao',l:'Confirmação de execução'},{v:'equipe',l:'Alteração da equipe'},{v:'rdo_edicao',l:'Edição de RDO'}];
function renderHistorico(){
  const el = document.getElementById('content');
  const minTs = histFilters.dataDe? new Date(histFilters.dataDe+'T00:00:00').getTime() : (histFilters.ultimasHs? Date.now()-histFilters.ultimasHs*3600e3 : -Infinity);
  const maxTs = histFilters.dataAte? new Date(histFilters.dataAte+'T23:59:59').getTime() : Infinity;
  const events = globalHistorico().filter(h=>{
    if(histFilters.tipo && h.tipo!==histFilters.tipo) return false;
    if(histFilters.projeto && String(h.projetoId)!==histFilters.projeto) return false;
    if(h.ts < minTs || h.ts > maxTs) return false;
    return true;
  });
  const janela = histFilters.ultimasHs? `últimas ${histFilters.ultimasHs}h` : (histFilters.dataDe||histFilters.dataAte? `de ${histFilters.dataDe||'…'} a ${histFilters.dataAte||'…'}` : 'tudo');
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <select id="f-h-tipo">${HIST_TIPOS.map(t=>`<option value="${t.v}" ${histFilters.tipo===t.v?'selected':''}>${t.l}</option>`).join('')}</select>
        <select id="f-h-projeto"><option value="">Todos os projetos</option>${projetosVisiveis().map(p=>`<option value="${p.id}" ${histFilters.projeto==String(p.id)?'selected':''}>${esc(p.codigo)} · ${esc(p.nome)}</option>`).join('')}</select>
        <input type="date" id="f-h-data-de" value="${histFilters.dataDe}" title="Data inicial">
        <span style="color:var(--muted);font-size:12px;">até</span>
        <input type="date" id="f-h-data-ate" value="${histFilters.dataAte}" title="Data final">
        <button class="btn btn-sm" id="f-h-12h" title="Últimas 12 horas">12h</button>
        <button class="btn btn-sm" id="f-h-24h" title="Últimas 24 horas">24h</button>
        <button class="btn btn-sm" id="f-h-7d" title="Últimos 7 dias">7 dias</button>
        <button class="btn btn-sm" id="f-h-mes-atual" title="Filtrar pelo mês vigente">Mês atual</button>
        <button class="btn btn-sm btn-ghost" id="f-h-limpar-datas" title="Remover filtros e mostrar tudo">Tudo</button>
      </div>
      <span style="font-size:12px;color:var(--muted);">${events.length} eventos · ${janela}</span>
    </div>
    ${events.length? `<div class="panel">${renderHistoricoTimeline(events, true)}</div>` : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhum evento encontrado com os filtros.</p></div></div>`}`;
  document.getElementById('f-h-tipo').addEventListener('change', e=>{ histFilters.tipo=e.target.value; renderContent(); });
  document.getElementById('f-h-projeto').addEventListener('change', e=>{ histFilters.projeto=e.target.value; renderContent(); });
  document.getElementById('f-h-data-de').addEventListener('change', e=>{ histFilters.dataDe=e.target.value; histFilters.ultimasHs=0; renderContent(); });
  document.getElementById('f-h-data-ate').addEventListener('change', e=>{ histFilters.dataAte=e.target.value; histFilters.ultimasHs=0; renderContent(); });
  document.getElementById('f-h-12h').addEventListener('click', ()=>{ histFilters.ultimasHs=12; histFilters.dataDe=''; histFilters.dataAte=''; renderContent(); });
  document.getElementById('f-h-24h').addEventListener('click', ()=>{ histFilters.ultimasHs=24; histFilters.dataDe=''; histFilters.dataAte=''; renderContent(); });
  document.getElementById('f-h-7d').addEventListener('click', ()=>{ histFilters.ultimasHs=168; histFilters.dataDe=''; histFilters.dataAte=''; renderContent(); });
  document.getElementById('f-h-mes-atual').addEventListener('click', ()=>{ const r=monthRangeISO(); histFilters.ultimasHs=0; histFilters.dataDe=r.de; histFilters.dataAte=r.ate; renderContent(); });
  document.getElementById('f-h-limpar-datas').addEventListener('click', ()=>{ histFilters.ultimasHs=0; histFilters.dataDe=''; histFilters.dataAte=''; renderContent(); });
  el.querySelectorAll('[data-open-atrib]').forEach(r=>r.addEventListener('click', ()=>openAtribDetalhe(r.dataset.openAtrib)));
}
function renderHistoricoTimeline(events, withContext){
  if(!events.length) return `<div style="padding:24px;color:var(--muted-2);font-size:12.5px;">Sem eventos recentes.</div>`;
  return `<div class="timeline">${events.map(h=>{
    let atrib=null, pg=null;
    for(const p of DB.programacoes){ const f=(p.atribuicoes||[]).find(a=>a.id===h.atribId); if(f){ atrib=f; pg=p; break; } }
    const eq = atrib? findEquipe(atrib.equipeId) : null;
    let dotColor='var(--muted)', title='';
    if(h.tipo==='criacao'){ dotColor='var(--blue)'; title='Programação criada'; }
    else if(h.tipo==='status'){ dotColor=STATUS_COLOR[h.para]||'var(--muted)'; title=`Status alterado: ${h.de} → ${h.para}`; }
    else if(h.tipo==='reprogramacao'){ dotColor='var(--purple)'; title=`Reprogramada: ${fmtDate(h.de)} → ${fmtDate(h.para)}`; }
    else if(h.tipo==='confirmacao'){ dotColor='var(--green)'; title='Execução confirmada'; }
    else if(h.tipo==='equipe'){ dotColor='var(--accent)'; title='Atividades alteradas pela equipe'; }
    else if(h.tipo==='rdo_edicao'){ dotColor='var(--purple)'; title='Registro RDO editado'; }
    const ctx = withContext && pg ? `<div class="tl-meta">${esc(findProjeto(pg.projetoId)?.codigo||'')} · ${esc(findProjeto(pg.projetoId)?.nome||'')} · Equipe ${equipeLabel(eq)}</div>` : '';
    return `<div class="tl-item ${withContext?'clickable':''}" ${withContext?`data-open-atrib="${h.atribId}"`:''} style="--dot-c:${dotColor}"><div class="tl-title">${title}</div><div class="tl-meta">${fmtDateTime(h.ts)} · <strong style="color:var(--muted);">${autor(h)}</strong></div>${ctx}${h.motivo? `<div class="tl-motivo"><strong>Motivo:</strong> ${esc(h.motivo)}${h.obs? ' — '+esc(h.obs):''}</div>`:''}</div>`;
  }).join('')}</div>`;
}
function openHistoricoModal(atribId){
  atribId = Number(atribId);
  let atrib;
  for(const p of DB.programacoes){ const f=(p.atribuicoes||[]).find(a=>a.id===atribId); if(f){ atrib=f; break; } }
  if(!atrib) return;
  const body = renderHistoricoTimeline([...(atrib.historico||[])].map(h=>({...h,atribId})).sort((a,b)=>b.ts-a.ts));
  openModal({ title:'Histórico', bodyHtml:body, submitLabel:'Fechar', onSubmit:()=>true, wide:true });
}

/* =========================================================
   ADMINISTRAÇÃO — campos personalizados
========================================================= */
let adminModulo = 'equipes';
function renderAdmin(){
  const el = document.getElementById('content');
  el.innerHTML = `
    ${monPanelHtml()}
    <div class="tabs" style="margin-bottom:16px;">${MODULOS_ADMIN.map(m=>`<button class="tab ${adminModulo===m.k?'active':''}" data-mod="${m.k}">${m.l}</button>`).join('')}</div>
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-head">
        <div><h3>Usuários e níveis de acesso</h3><div class="admin-field-meta">Crie usuários e defina o papel e o nível de acesso de cada um.</div></div>
        <button class="btn btn-primary btn-sm" id="btn-novo-usuario">${icon('plus',13)} Novo usuário</button>
      </div>
      <div id="admin-users-list"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Campos personalizados — ${MODULOS_ADMIN.find(m=>m.k===adminModulo).l}</h3></div>
      <div id="admin-fields-list"></div>
      <div class="admin-add-form">
        <div class="field-row">
          <div class="field"><label>Nome do campo</label><input type="text" id="new-field-label" placeholder="Ex: Contrato"></div>
          <div class="field"><label>Tipo</label><select id="new-field-type">${CUSTOM_FIELD_TYPES.map(t=>`<option value="${t.v}">${t.l}</option>`).join('')}</select></div>
        </div>
        <div class="field" id="new-field-opts-wrap" style="display:none;"><label>Opções (separadas por vírgula)</label><input type="text" id="new-field-opts" placeholder="Opção 1, Opção 2, Opção 3"></div>
        <button class="btn btn-primary btn-sm" id="add-field-btn" style="align-self:flex-start;">${icon('plus',13)} Adicionar campo</button>
      </div>
    </div>
    <div class="panel" style="margin-top:24px;">
      <div class="panel-head"><h3>Respostas RDO - Saída da Base</h3></div>
      <div id="admin-rdo-list"></div>
    </div>
    <div class="panel" style="margin-top:24px;">
      <div class="panel-head">
        <div><h3>Cidades</h3><div class="admin-field-meta">Cadastre cidades e defina cores de identificação para uso na Tabulação do Calendário.</div></div>
        <button class="btn btn-primary btn-sm" id="btn-nova-cidade">${icon('plus',13)} Nova cidade</button>
      </div>
      <div id="admin-cidades-list"></div>
    </div>`;
  el.querySelectorAll('[data-mod]').forEach(b=>b.addEventListener('click', ()=>{ adminModulo=b.dataset.mod; renderAdmin(); }));
  bindMonPanel();
  paintAdminUsersList();
  document.getElementById('btn-novo-usuario').addEventListener('click', ()=>openUsuarioModal());
  paintAdminFieldsList();
  document.getElementById('new-field-type').addEventListener('change', e=>{ document.getElementById('new-field-opts-wrap').style.display = e.target.value==='select'? 'block':'none'; });
  document.getElementById('add-field-btn').addEventListener('click', ()=>{
    const label = document.getElementById('new-field-label').value.trim();
    const tipo = document.getElementById('new-field-type').value;
    const opts = document.getElementById('new-field-opts').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(!label){ toast('Informe o nome do campo.', 'error'); return; }
    DB.customFields[adminModulo].push({ id: nextId(), label, tipo, opcoes: tipo==='select'? opts: [] });
    registrarEvento('config','sistema',null,'Campo personalizado', 'Campo "'+label+'" adicionado no módulo '+adminModulo);
    saveData(); toast('Campo adicionado.'); renderAdmin();
  });
  document.getElementById('btn-nova-cidade').addEventListener('click', ()=>openCidadeModal());
  paintAdminCidadesList();
  try{ paintAdminRdoList(); }catch(e){ console.error('RDO list error:', e); }
}
function paintAdminUsersList(){
  const wrap = document.getElementById('admin-users-list');
  const users = DB.usuarios||[];
  wrap.innerHTML = users.length? users.map(u=>{
    const perm = u.permissoes||{};
    const permKeys = Object.keys(perm);
    const temEdit = permKeys.filter(k=>perm[k]==='edicao').length;
    const temVer = permKeys.filter(k=>perm[k]==='leitura').length;
    const permResumo = permKeys.length ? `${temEdit} editar, ${temVer} ver` : nivelLabel(u.nivel);
    return `<div class="admin-field-row">
      <div>
        <strong>${esc(u.nome)}</strong>
        <div class="admin-field-meta">${esc(u.login)} · ${permResumo}${u.setor||u.coordenacao? ' · '+esc([u.setor,u.coordenacao].filter(Boolean).join(' / ')):''}${u.ativo?'':' · Inativo'}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-edit-user="${u.id}">${icon('edit',14)}</button>
        <button class="icon-btn" data-del-user="${u.id}">${icon('trash',14)}</button>
      </div>
    </div>`;
  }).join('') : `<div style="padding:20px;color:var(--muted-2);font-size:12.5px;">Nenhum usuário cadastrado. Clique em "Novo usuário" para começar.</div>`;
  wrap.querySelectorAll('[data-edit-user]').forEach(b=>b.addEventListener('click', ()=>openUsuarioModal(b.dataset.editUser)));
  wrap.querySelectorAll('[data-del-user]').forEach(b=>b.addEventListener('click', ()=>deleteUsuario(b.dataset.delUser)));
}
    function openUsuarioModal(id){
      if(!requerEscrita()) return;
      const u = id ? (DB.usuarios||[]).find(x=>x.id===Number(id)) : null;
      const perm = u?.permissoes || {};
      const permGrid = TELAS.map(t => {
        const val = perm[t.id] || 'nenhum';
        return `<div style="display:grid;grid-template-columns:1fr 100px 90px 80px;gap:0;align-items:center;border-bottom:1px solid var(--border-soft);padding:6px 0;font-size:13px;">
          <span style="font-weight:500;">${t.label}</span>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;justify-content:center;"><input type="radio" name="perm_${t.id}" value="nenhum" ${val==='nenhum'?'checked':''} style="margin:0;"> Nenhum</label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;justify-content:center;"><input type="radio" name="perm_${t.id}" value="leitura" ${val==='leitura'?'checked':''} style="margin:0;"> Ver</label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;justify-content:center;"><input type="radio" name="perm_${t.id}" value="edicao" ${val==='edicao'?'checked':''} style="margin:0;"> Editar</label>
        </div>`;
      }).join('');
      const body = `
      <div class="field"><label>Nome <span class="req">*</span></label><input type="text" name="nome" required value="${esc(u?.nome||'')}" placeholder="Nome do usuário"></div>
      <div class="field"><label>Login <span class="req">*</span></label><input type="text" name="login" required value="${esc(u?.login||'')}" placeholder="Ex: jose.silva"></div>
      <div class="field"><label>Senha <span class="req">*</span></label><input type="password" name="senha" ${u? '': 'required'} value="" placeholder="${u? 'Deixe em branco para manter a atual':'Defina uma senha'}"></div>
      <div class="field-row">
        <div class="field"><label>Setor</label><select name="setor"><option value="">Todos</option><option ${u?.setor==='MANUTENÇÃO'?'selected':''}>MANUTENÇÃO</option><option ${u?.setor==='OBRAS'?'selected':''}>OBRAS</option></select></div>
        <div class="field"><label>Coordenação</label><select name="coordenacao"><option value="">Todas</option><option ${u?.coordenacao==='RIO VERDE'?'selected':''}>RIO VERDE</option><option ${u?.coordenacao==='QUIRINOPOLIS'?'selected':''}>QUIRINOPOLIS</option></select></div>
      </div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="ativo" id="u-ativo" style="width:auto;" ${u? (u.ativo?'checked':'') : 'checked'}><label for="u-ativo" style="margin:0;">Usuário ativo</label></div>
      <div class="field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="aprovador" id="u-aprovador" style="width:auto;" ${u?.aprovador?'checked':''}><label for="u-aprovador" style="margin:0;">Aprovador de execução</label><div class="field-hint" style="margin-left:4px;">💡 Marcando esta caixa, os alertas que perguntam se a equipe executou (ou não) a atividade aparecerão apenas para este usuário aprovar.</div></div>
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px;flex-wrap:wrap;">
          <h4 style="margin:0;font-size:14px;">Permissões por tela</h4>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <select id="copiar-acessos" style="font-size:11px;padding:5px 6px;max-width:220px;">
              <option value="">Copiar acessos de…</option>
              ${(DB.usuarios||[]).filter(x=>String(x.id)!==String(u?.id)).map(x=>`<option value="${x.id}">${esc(x.nome)} (${esc(x.login)})</option>`).join('')}
            </select>
            <button type="button" class="btn btn-sm" id="perm-todos-ver" style="font-size:11px;">Marcar Todas: Ver</button>
            <button type="button" class="btn btn-sm" id="perm-todos-editar" style="font-size:11px;">Marcar Todas: Editar</button>
            <button type="button" class="btn btn-sm" id="perm-todos-nenhum" style="font-size:11px;">Desmarcar Todas</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 100px 90px 80px;gap:0;padding:0 0 4px 0;border-bottom:2px solid var(--border);margin-bottom:0;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">
          <span>Tela</span><span style="text-align:center;">Nenhum</span><span style="text-align:center;">Ver</span><span style="text-align:center;">Editar</span>
        </div>
        ${permGrid}
      </div>
    `;
  openModal({
    title: u? 'Editar usuário' : 'Novo usuário', bodyHtml: body, submitLabel: u? 'Salvar alterações':'Criar usuário', wide:true,
    onMount:(modal)=>{
      modal.querySelector('#perm-todos-ver')?.addEventListener('click', ()=>{ TELAS.forEach(t=>{ const r=modal.querySelector(`input[name="perm_${t.id}"][value="leitura"]`); if(r) r.checked=true; }); });
      modal.querySelector('#perm-todos-editar')?.addEventListener('click', ()=>{ TELAS.forEach(t=>{ const r=modal.querySelector(`input[name="perm_${t.id}"][value="edicao"]`); if(r) r.checked=true; }); });
      modal.querySelector('#perm-todos-nenhum')?.addEventListener('click', ()=>{ TELAS.forEach(t=>{ const r=modal.querySelector(`input[name="perm_${t.id}"][value="nenhum"]`); if(r) r.checked=true; }); });
      modal.querySelector('#copiar-acessos')?.addEventListener('change', (e)=>{
        const src = (DB.usuarios||[]).find(x=>String(x.id)===String(e.target.value));
        if(!src) return;
        const perm = src.permissoes||{};
        TELAS.forEach(t=>{
          const v = perm[t.id]||'nenhum';
          const r = modal.querySelector(`input[name="perm_${t.id}"][value="${v}"]`);
          if(r) r.checked = true;
        });
        toast('Acessos copiados de '+src.nome+'. Ajuste se necessário antes de salvar.');
      });
    },
    onSubmit:(fd)=>{
      const nome = fd.get('nome').trim(), login = fd.get('login').trim();
      const senha = fd.get('senha');
      if(!nome || !login){ toast('Informe nome e login.', 'error'); return false; }
      if(!u && !senha){ toast('Defina uma senha.', 'error'); return false; }
      if(DB.usuarios.some(x=>x.login.toLowerCase()===login.toLowerCase() && String(x.id)!==String(u?.id))){ toast('Já existe um usuário com este login.', 'error'); return false; }
      const permissoes = {};
      TELAS.forEach(t=>{ const v = fd.get('perm_'+t.id); if(v && v!=='nenhum') permissoes[t.id] = v; });
      const data = { nome, login, role:'administrador', nivel:'total', setor: fd.get('setor')||'', coordenacao: fd.get('coordenacao')||'', ativo: fd.get('ativo')==='on', aprovador: fd.get('aprovador')==='on', permissoes };
      if(senha) data.senha = senha;
      if(u){ Object.assign(u, data); toast('Usuário atualizado.'); registrarEvento('edicao','usuario',u.id,u.login,'Usuário atualizado · permissões atualizadas'); }
      else { data.id = nextId(); data.senha = senha; DB.usuarios.push(data); toast('Usuário criado.'); registrarEvento('criacao','usuario',data.id,data.login,'Usuário criado'); }
      saveData(); renderContent();
    }
  });
}
function deleteUsuario(id){
  const u = (DB.usuarios||[]).find(x=>x.id===Number(id));
  if(!u) return;
  if(u.role==='administrador' && (DB.usuarios||[]).filter(x=>x.role==='administrador' && x.ativo).length<=1){ toast('Deve existir ao menos um administrador ativo.', 'error'); return; }
  if(!confirm('Excluir o usuário "'+u.nome+'"?')) return;
  registrarEvento('exclusao','usuario',u.id,u.login,'Usuário excluído · '+roleLabel(u.role));
  DB.usuarios = DB.usuarios.filter(x=>x.id!==Number(id)); saveData(); renderContent(); toast('Usuário excluído.');
}
function paintAdminFieldsList(){
  const list = DB.customFields[adminModulo]||[];
  const wrap = document.getElementById('admin-fields-list');
  wrap.innerHTML = list.length? list.map(f=>`
    <div class="admin-field-row">
      <div><strong>${esc(f.label)}</strong><div class="admin-field-meta">${CUSTOM_FIELD_TYPES.find(t=>t.v===f.tipo)?.l||f.tipo}${f.tipo==='select'? ' · '+esc((f.opcoes||[]).join(', ')):''}</div></div>
      <button class="icon-btn" data-del-field="${f.id}">${icon('trash',14)}</button>
    </div>`).join('') : `<div style="padding:20px;color:var(--muted-2);font-size:12.5px;">Nenhum campo personalizado neste módulo ainda.</div>`;
  wrap.querySelectorAll('[data-del-field]').forEach(b=>b.addEventListener('click', ()=>{
    if(!confirm('Remover este campo? Os valores já preenchidos serão mantidos ocultos.')) return;
    const f = DB.customFields[adminModulo].find(f=>f.id===Number(b.dataset.delField));
    DB.customFields[adminModulo] = DB.customFields[adminModulo].filter(f=>f.id!==Number(b.dataset.delField));
    registrarEvento('config','sistema',null,'Campo personalizado', 'Campo "'+(f?.label||'')+'" removido do módulo '+adminModulo);
    saveData(); renderAdmin();
  }));
}
function paintAdminRdoList(){
  const wrap = document.getElementById('admin-rdo-list');
  const rdoEntries = [];
  (DB.programacoes||[]).forEach(pg=>{
    (pg.atribuicoes||[]).forEach(at=>{
      const rdo = at.rdoRespostas||{};
      rdoEntries.push({ programacao: pg, atribuicao: at, respostas: rdo });
    });
  });
  if(!rdoEntries.length){
    wrap.innerHTML = `<div style="padding:20px;color:var(--muted-2);font-size:12.5px;">Nenhuma resposta RDO registrada ainda. As equipes devem completar o RDO na página da equipe.</div>`;
    return;
  }
  wrap.innerHTML = rdoEntries.map(entry=>`
    <div class="admin-field-row" style="border-bottom:1px solid var(--border); padding-bottom:24px; margin-bottom:24px;">
      <div style="font-weight:700;font-size:14px;color:var(--dark);margin-bottom:8px;">
        Programação ${progGid(entry.prog)} - ${entry.prog.atribuicoes.map(a=>String(a.equipeId)).join(', ')} ${entry.atribuicao.status||'Programado'}
      </div>
      <div style="margin-bottom:16px;">
        <h4>Dados da Programação</h4>
        <p><strong>Data programada:</strong> ${fmtDate(entry.prog.dataProgramada)}</p>
        <p><strong>Ciclo:</strong> ${entry.prog.ciclo||'—'}</p>
        <p><strong>Projeto:</strong> ${entry.prog.projetoId ? ((()=>{ const _p=(DB.projetos||[]).find(p=>p.id===entry.prog.projetoId); return _p? `${_p.codigo||''} · ${_p.nome}`:'—'; })()) : '—'}</p>
        <p><strong>Local de execução:</strong> ${entry.prog.local? esc(entry.prog.local) : '—'}${entry.prog.local||entry.prog.localLat!=null? ` <a href="${esc(localMapsHref(entry.prog.local,entry.prog.localLat,entry.prog.localLng))}" target="_blank" rel="noopener" style="color:var(--blue);font-weight:600;font-size:12px;">${icon('pin',11)} Ver no Google Maps</a>`:''}</p>
        ${(entry.prog.localLat!=null && entry.prog.localLng!=null)? `<a href="${esc(staticMapUrl(entry.prog.localLat,entry.prog.localLng,17,800,360))}" target="_blank" rel="noopener" style="display:inline-block;max-width:480px;">${localThumbHtml(entry.prog.local,entry.prog.localLat,entry.prog.localLng)}</a>`:''}
      </div>
      <div style="margin-bottom:16px;">
        <h4>Respostas RDO</h4>
        <table style="width:100%;border-collapse:collapse;">
          ${RDO_QUESTIONS.map(q=>`
            <tr style="margin-bottom:8px;">
              <td style="width:40%;font-weight:600;padding-right:16px;">${q.label}</td>
              <td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;min-width:200px;background:rgba(87,199,199,.08);">
                ${String(entry.respostas[q.id])||'-- não respondido --'}
              </td>
            </tr>`).join('')}
        </table>
      </div>
      <div style="margin-bottom:16px;">
        <h4>Horários</h4>
        <table style="width:100%;border-collapse:collapse;">
          ${RDO_HORARIOS.map(h=>`
            <tr><td style="font-weight:600;padding-right:16px;">${h.label}</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao[h.k]||'--'}</td></tr>`).join('')}
        </table>
      </div>
      <div style="margin-bottom:16px;">
        <h4>KM do Veículo</h4>
        <table style="width:100%;border-collapse:collapse;">
          ${RDO_KM.map(h=>`
            <tr><td style="font-weight:600;padding-right:16px;">${h.label}</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao[h.k]||'--'}</td></tr>`).join('')}
        </table>
      </div>
      <div style="margin-bottom:16px;">
        <h4>Condições Climáticas e Impedimentos</h4>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="font-weight:600;padding-right:16px;">Condições climáticas</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoCondicoes||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Impedimento execução (somente se sim)</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoImpedimento||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Falta de material</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoFaltaMaterial||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Projeto Incoerente</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoProjetoIncoerente||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Equipe incompleta</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoEquipeIncompleta||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Falta de veículo</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoFaltaVeiculo||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Impedimento de acesso</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoImpedimentoAcesso||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Licença ambiental</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoLicencaAmbiental||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Autorização/embargo</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoAutorizacaoEmbargo||'--'}</td></tr>
          <tr><td style="font-weight:600;padding-right:16px;">Desligamento conforme programado</td><td style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;">${entry.atribuicao.rdoDesligamento||'--'}</td></tr>
        </table>
      </div>
    </div>`).join('');
}
function paintAdminCidadesList(){
  const wrap = document.getElementById('admin-cidades-list');
  const cids = DB.cidades||[];
  wrap.innerHTML = cids.length? cids.map(c=>`
    <div class="admin-field-row">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="width:18px;height:18px;border-radius:4px;background:${c.cor||'#6b7280'};flex-shrink:0;"></span>
        <strong>${esc(c.nome)}</strong>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-edit-cid="${c.id}">${icon('edit',14)}</button>
        <button class="icon-btn" data-del-cid="${c.id}">${icon('trash',14)}</button>
      </div>
    </div>`).join('') : `<div style="padding:20px;color:var(--muted-2);font-size:12.5px;">Nenhuma cidade cadastrada. Cadastre cidades para usar cores de identificação na Tabulação.</div>`;
  wrap.querySelectorAll('[data-edit-cid]').forEach(b=>b.addEventListener('click', ()=>openCidadeModal(b.dataset.editCid)));
  wrap.querySelectorAll('[data-del-cid]').forEach(b=>b.addEventListener('click', ()=>deleteCidade(b.dataset.delCid)));
}

/* =========================================================
   EMPTY STATE
========================================================= */
function emptyState(title, sub){
  return `<div class="panel"><div class="empty-state">${icon('empty',36)}<h3 style="margin-bottom:6px;">${title}</h3><p>${sub}</p><button class="btn btn-primary" id="empty-cta" style="margin-top:16px;">${icon('plus',15)} Adicionar</button></div></div>`;
}
function bindEmptyCta(el, fn){ const b = el.querySelector('#empty-cta'); if(b) b.addEventListener('click', fn); }

/* =========================================================
   BACKUP
========================================================= */
document.getElementById('btn-backup')?.addEventListener('click', ()=>{
  const choice = confirm('Clique OK para EXPORTAR os dados (baixar backup). Clique Cancelar para IMPORTAR um arquivo de backup.');
  if(choice){
    const blob = new Blob([JSON.stringify(DB, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `g26_new_backup_${todayISO()}.json`; a.click(); URL.revokeObjectURL(url);
    toast('Backup exportado.');
  } else { document.getElementById('import-file').click(); }
});
document.getElementById('import-file').addEventListener('change', (e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const parsed = JSON.parse(ev.target.result);
      if(!confirm('Importar substituirá TODOS os dados atuais. Continuar?')) return;
      DB = Object.assign(structuredClone(DEFAULT_DATA), parsed);
      DB.customFields = Object.assign(structuredClone(DEFAULT_DATA.customFields), parsed.customFields||{});
      migrarGids();
      saveData(); setView(currentView); toast('Dados importados com sucesso.');
    }catch(err){ toast('Arquivo inválido.', 'error'); }
  };
  reader.readAsText(file); e.target.value='';
});

/* =========================================================
   ROUTER
========================================================= */
function renderContent(){
  if(!telaPodeVer(currentView)){
    currentView = 'dashboard';
    renderNav();
  }
  const map = { dashboard: renderDashboard, alertas: renderAlertas, 'medição': renderMedição, 'medição-projetos': renderMediçãoProjetos, 'medição-oc': renderMediçãoOC, 'medição-ndsose': renderMediçãoNDSOSE, 'medição-poda': renderMediçãoPoda, equipes: renderEquipes, atividades: renderAtividades, projetos: renderProjetos, 'projetos-cadastro': renderProjetos, osepoda: renderOsePoda, ose: renderOse, 'ose-programacoes': renderOseProgramacoes, 'ose-rdo': renderOseRdo, poda: renderPoda, 'poda-programacoes': renderPodaProgramacoes, 'poda-rdo': renderPodaRdo, ocnds: renderOcNds, avanco: renderAvanco, programacoes: renderProgramacoes, historico: renderHistorico, admin: renderAdmin, 'rdo-projetos': renderRdoProjetos, 'rdo-ocnds': renderRdoOcNds };
  (map[currentView]||renderDashboard)();
}

/* =========================================================
   VIEW: OSE/PODA e OC/NDS (em desenvolvimento)
========================================================= */
/* =========================================================
   OSE — Obras Semi-Especiais (modelado a partir do PODA)
   Arquivo parcial: collado no final de app.js (antes do SEED)
   Armazena em DB.oseProgramacoes[]
   ========================================================= */

/* --- Ose helpers --- */
const STATUS_OSE = ['Programado','Em Execução','Concluído','Reprogramado','Cancelado'];
const TIPO_INTERVENCAO_OPCOES = ['MT','BT'];
let oseFilters = (()=>{ const r=monthRangeISO(); return { busca:'', equipe:'', status:'', dataDe:r.de, dataAte:r.ate, modo:'lista', calView:'mes', calDay:todayISO() }; })();
let oseCalRef = new Date();
function oseProgLabel(p){ return p.gid || ('OSE-'+String(p.id).padStart(7,'0')); }
function findOseProg(id){ return (DB.oseProgramacoes||[]).find(p=>p.id===Number(id)); }
function oseProgramacoesVisiveis(){
  const all = DB.oseProgramacoes||[];
  if(!usuarioRestrito()) return all;
  const eqIds = new Set(equipesVisiveis().map(e=>String(e.id)));
  return all.filter(pg=> (pg.atribuicoes||[]).some(a=> eqIds.has(String(a.equipeId))));
}
function flatOseAtribuicoes(){
  const out=[];
  (DB.oseProgramacoes||[]).forEach(pg=>{ (pg.atribuicoes||[]).forEach(at=> out.push({ programacao: pg, atribuicao: at })); });
  return out;
}
function oseAtribGlobal(atribId){
  for(const pg of (DB.oseProgramacoes||[])){ const f=(pg.atribuicoes||[]).find(a=>a.id===Number(atribId)); if(f) return {programacao:pg,atribuicao:f}; }
  return null;
}
function oseProgDaAtrib(atribId){
  return (DB.oseProgramacoes||[]).find(pg=> (pg.atribuicoes||[]).some(a=>a.id===Number(atribId)));
}
function oseProgramacoesFiltradas(){
  const norm = s=> String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const q = norm(oseFilters.busca);
  const st = oseFilters.status;
  const eqId = oseFilters.equipe;
  const de = oseFilters.dataDe;
  const ate = oseFilters.dataAte;
  return flatOseAtribuicoes().filter(x=>{
    const p = x.programacao, a = x.atribuicao;
    const eq = findEquipe(a.equipeId);
    if(st && a.status!==st) return false;
    if(eqId && String(a.equipeId)!==String(eqId)) return false;
    if(de && (a.dataProgramada||p.dataProgramacao||'') < de) return false;
    if(ate && (a.dataProgramada||p.dataProgramacao||'') > ate) return false;
    if(q){
      const hay = norm([p.municipio,p.subestacao,p.tipoIntervencao,p.status,p.statusDocumentacao,oseProgLabel(p),equipeLabel(eq),eq?.supervisor,fmtDate(a.dataProgramada||p.dataProgramacao),p.observacoes].join(' '));
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}
function osePedirMotivoStatus(atribId, novoStatus, onOk){
  if(!requerEscrita()) return;
  const r = oseAtribGlobal(atribId);
  if(!r || r.atribuicao.status===novoStatus) return;
  const de = r.atribuicao.status;
  const eq = findEquipe(r.atribuicao.equipeId);
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:12px;">Alterar status de <strong>${de}</strong> para <strong>${novoStatus}</strong>${eq? ' — '+esc(equipeLabel(eq)):''}</div>
    <div class="field"><label>Motivo <span class="req">*</span></label><input type="text" name="motivo" required maxlength="200" placeholder="Descreva o motivo desta alteração de status"></div>
    <div class="field"><label>Observações</label><textarea name="obs" rows="2" placeholder="Detalhes opcionais"></textarea></div>`;
  openModal({
    title:'Motivo da alteração de status', bodyHtml: body, submitLabel:'Alterar status',
    onSubmit:(fd)=>{
      const motivo = String(fd.get('motivo')||'').trim();
      const obs = String(fd.get('obs')||'').trim();
      if(!motivo){ toast('Informe o motivo da alteração.', 'error'); return false; }
      r.atribuicao.status = novoStatus;
      r.atribuicao.historico = r.atribuicao.historico||[];
      r.atribuicao.historico.push({...currentAutor(), ts:Date.now(), tipo:'status', de, para:novoStatus, motivo, obs: obs||null});
      registrarEvento('status','atribuicao',r.atribuicao.id, oseProgLabel(r.programacao)+' · '+equipeLabel(findEquipe(r.atribuicao.equipeId)), de+' → '+novoStatus+' · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); renderBanner(); toast('Status alterado para '+novoStatus+'.');
      onOk && onOk();
    }
  });
}
function openOseReprogramarConfirmacao(atribId, novaDataPrefill){
  if(!requerEscrita()) return;
  const r = oseAtribGlobal(atribId);
  if(!r) return;
  const atrib = r.atribuicao;
  if(['Concluído','Cancelado'].includes(atrib.status)){ toast('Não é possível reprogramar um item concluído ou cancelado.', 'error'); return; }
  const eq = findEquipe(atrib.equipeId);
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:4px;">Equipe ${equipeLabel(eq)}</div>
    <div class="field"><label>Data atual</label><input type="text" value="${fmtDate(atrib.dataProgramada)}" disabled></div>
    <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" name="novaData" required value="${novaDataPrefill||atrib.dataProgramada}"></div>
    <div class="field"><label>Motivo da reprogramação <span class="req">*</span></label><select name="motivo" required><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
    <div class="field"><label>Observações <span class="req">*</span></label><textarea name="obs" required placeholder="Descreva o motivo e as observações da reprogramação"></textarea></div>`;
  openModal({
    title:'Reprogramar programação OSE', bodyHtml: body, submitLabel:'Confirmar reprogramação',
    onSubmit:(fd)=>{
      const novaData = fd.get('novaData'); const motivo = fd.get('motivo'); const obs = fd.get('obs').trim();
      if(!motivo){ toast('Selecione o motivo da reprogramação.', 'error'); return false; }
      if(!obs){ toast('Informe a observação da reprogramação.', 'error'); return false; }
      const dataAntiga = atrib.dataProgramada;
      atrib.dataProgramada = novaData; atrib.status = 'Reprogramado';
      atrib.historico = atrib.historico||[];
      atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
      registrarEvento('reprogramacao','atribuicao',atrib.id, oseProgLabel(r.programacao)+' · '+equipeLabel(findEquipe(atrib.equipeId)), fmtDate(dataAntiga)+' → '+fmtDate(novaData)+' · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); renderBanner(); toast('Programação reprogramada.');
    }
  });
}

/* --- renderOseProgramacoes --- */
function renderOseProgramacoes(){
  const el = document.getElementById('content');
  if(!DB.equipes.length){
    el.innerHTML = emptyState('Cadastre equipes primeiro', 'A programação OSE requer ao menos uma equipe.');
    return;
  }
  const list = oseProgramacoesFiltradas();
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <input type="search" id="ose-f-busca" placeholder="Buscar município, subestação, equipe..." style="flex:1;min-width:180px;" value="${esc(oseFilters.busca)}">
        <select id="ose-f-equipe"><option value="">Todas as equipes</option>${equipesVisiveis().filter(e=>e.ativo!==false).map(e=>`<option value="${e.id}" ${oseFilters.equipe==String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' — '+esc(e.encarregado):''}</option>`).join('')}</select>
        <select id="ose-f-status"><option value="">Todos os status</option>${STATUS_OSE.map(s=>`<option ${oseFilters.status===s?'selected':''}>${s}</option>`).join('')}</select>
        <input type="date" id="ose-f-de" value="${oseFilters.dataDe}" title="Data inicial">
        <span style="color:var(--muted);font-size:12px;">até</span>
        <input type="date" id="ose-f-ate" value="${oseFilters.dataAte}" title="Data final">
        <button class="btn btn-sm" id="ose-f-mes-atual" title="Filtrar pelo mês vigente">${icon('calendar',12)} Mês atual</button>
        <button class="btn btn-sm btn-ghost" id="ose-f-limpar" title="Limpar filtros">Limpar</button>
      </div>
      <div class="tabs">
        <button class="tab ${oseFilters.modo==='lista'?'active':''}" data-modo="lista">Lista</button>
        <button class="tab ${oseFilters.modo==='fluxo'?'active':''}" data-modo="fluxo">Fluxo</button>
        <button class="tab ${oseFilters.modo==='calendario'?'active':''}" data-modo="calendario">Calendário</button>
      </div>
    </div>
    <div id="ose-area"></div>`;
  document.getElementById('ose-f-busca').addEventListener('input', e=>{ oseFilters.busca=e.target.value; renderContent(); });
  document.getElementById('ose-f-equipe').addEventListener('change', e=>{ oseFilters.equipe=e.target.value; renderContent(); });
  document.getElementById('ose-f-status').addEventListener('change', e=>{ oseFilters.status=e.target.value; renderContent(); });
  document.getElementById('ose-f-de').addEventListener('change', e=>{ oseFilters.dataDe=e.target.value; renderContent(); });
  document.getElementById('ose-f-ate').addEventListener('change', e=>{ oseFilters.dataAte=e.target.value; renderContent(); });
  document.getElementById('ose-f-mes-atual').addEventListener('click', ()=>{ const r=monthRangeISO(); oseFilters.dataDe=r.de; oseFilters.dataAte=r.ate; renderContent(); });
  document.getElementById('ose-f-limpar').addEventListener('click', ()=>{ oseFilters.busca=''; oseFilters.equipe=''; oseFilters.status=''; oseFilters.dataDe=''; oseFilters.dataAte=''; renderContent(); });
  el.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>{oseFilters.modo=t.dataset.modo; renderContent();}));

  const area = document.getElementById('ose-area');
  if(oseFilters.modo==='calendario'){ renderOseCalendarioInto(area, list); return; }
  if(!list.length){
    area.innerHTML = flatOseAtribuicoes().length
      ? emptyState('Nenhuma programação encontrada', 'Ajuste os filtros para ver as programações.')
      : emptyState('Nenhuma programação OSE', 'Clique em "Nova programação" para criar a primeira.');
    return;
  }
  if(oseFilters.modo==='lista') renderOseListaInto(area, list); else renderOseFluxoInto(area, list);
}

function renderOseListaInto(area, list){
  area.innerHTML = `<div class="panel"><div class="table-scroll"><table>
    <thead><tr><th>ID</th><th>Data</th><th>Nº OSE</th><th>Município</th><th>Subestação</th><th>Tipo</th><th>Equipe</th><th>Status Doc.</th><th>Atividades</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(x=>{
      const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
      const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
      const ativResumo = (a.atividades||[]).map(at=>{ const atd=findAtividade(at.atividadeId); return `${esc(atd?.codigo||'?')} ×${at.quantidadePrevista??'—'}`; }).join(', ');
      return `<tr style="cursor:pointer;" data-ose-open="${a.id}">
        <td class="mono" style="white-space:nowrap;">${oseProgLabel(p)}</td>
        <td class="mono">${fmtDate(a.dataProgramada)} ${late?'<div class="late-flag">VENCIDA</div>':''}</td>
        <td class="mono">${esc(p.numeroOse||'—')}</td>
        <td>${esc(p.municipio||'—')}</td>
        <td>${esc(p.subestacao||'—')}</td>
        <td><span class="badge" style="color:${p.tipoIntervencao==='Aéreo'?'var(--blue)':p.tipoIntervencao==='Subterrâneo'?'var(--accent)':'var(--purple)'};background:${p.tipoIntervencao==='Aéreo'?'rgba(78,140,235,.14)':p.tipoIntervencao==='Subterrâneo'?'rgba(224,164,88,.14)':'rgba(180,140,224,.14)'};">${esc(p.tipoIntervencao||'—')}</span></td>
        <td><span class="badge-prefix">${eqtlLabel(eq)}</span></td>
        <td><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(p.statusDocumentacao||'—')}</span></td>
        <td style="font-size:12px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ativResumo||'—'}</td>
        <td>${statusBadge(a.status, late)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" title="WhatsApp" data-ose-whats="${p.id}">${icon('whatsapp',14)}</button>
          <button class="icon-btn" title="Documento" data-ose-doc="${p.id}">${icon('print',14)}</button>
          <button class="icon-btn" title="Histórico" data-ose-hist="${a.id}">${icon('history',14)}</button>
          <button class="icon-btn" title="Reprogramar" data-ose-reprog="${a.id}">${icon('reprog',14)}</button>
          <button class="icon-btn" title="Editar" data-ose-edit="${p.id}">${icon('edit',14)}</button>
          <button class="icon-btn" title="Excluir" data-ose-del="${p.id}">${icon('trash',14)}</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
  bindOseRowActions(area);
}

function bindOseRowActions(area){
  area.querySelectorAll('[data-ose-open]').forEach(c=>c.addEventListener('click', (e)=>{ if(e.target.closest('.row-actions')) return; openOseDetalhe(c.dataset.oseOpen); }));
  area.querySelectorAll('[data-ose-whats]').forEach(b=>b.addEventListener('click', ()=>encaminharOseWhats(b.dataset.oseWhats)));
  area.querySelectorAll('[data-ose-doc]').forEach(b=>b.addEventListener('click', ()=>openOseDocProgramacao(b.dataset.oseDoc)));
  area.querySelectorAll('[data-ose-hist]').forEach(b=>b.addEventListener('click', ()=>openOseHistoricoModal(b.dataset.oseHist)));
  area.querySelectorAll('[data-ose-reprog]').forEach(b=>b.addEventListener('click', ()=>openOseReprogramarConfirmacao(b.dataset.oseReprog)));
  area.querySelectorAll('[data-ose-edit]').forEach(b=>b.addEventListener('click', ()=>openOseProgramacaoModal(Number(b.dataset.oseEdit))));
  area.querySelectorAll('[data-ose-del]').forEach(b=>b.addEventListener('click', ()=>{
    const p = findOseProg(Number(b.dataset.oseDel));
    if(!p) return;
    if(!confirm('Excluir a programação OSE '+oseProgLabel(p)+'?')) return;
    registrarEvento('exclusao','programacao',p.id,oseProgLabel(p),'Programação OSE excluída');
    DB.oseProgramacoes = DB.oseProgramacoes.filter(x=>x.id!==p.id);
    saveData(); renderContent(); toast('Programação excluída.');
  }));
}

/* --- OSE Kanban (Fluxo) --- */
function renderOseFluxoInto(area, list){
  const cols = STATUS_OSE.map(status=>{
    const items = list.filter(x=>x.atribuicao.status===status);
    const c = STATUS_COLOR[status]||'var(--muted)';
    return `<div class="kanban-col" style="--col-c:${c}" data-drop-status="${status}">
      <div class="kanban-col-head"><h4>${status}</h4><span class="count">${items.length}</span></div>
      <div class="kanban-cards">${items.map(x=>{
        const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
        const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
        return `<div class="kcard ${late?'pending':''}" draggable="true" data-atrib="${a.id}" data-open-ose="${a.id}">
          <div class="kc-code ${late?'late-blink late':''}">${late?'VENCIDA · ':''}${equipeLabel(eq)}</div>
          <div class="kc-title">${esc(p.municipio||'—')} · ${esc(p.subestacao||'—')}</div>
          <div class="kc-meta"><span>${esc(p.tipoIntervencao||'—')} · ${esc(p.statusDocumentacao||'—')}</span></div>
          <div class="kc-meta"><span>${fmtDate(a.dataProgramada)}</span><span class="mono" style="color:var(--accent);">${oseProgLabel(p)}</span></div>
        </div>`;
      }).join('') || `<div style="padding:14px;color:var(--muted-2);font-size:11.5px;">Vazio</div>`}</div>
    </div>`;
  }).join('');
  area.innerHTML = renderOseKanbanStrip() + `<div class="kanban">${cols}</div>`;
  bindOseKanbanDrag(area);
}

function renderOseKanbanStrip(){
  const days = [];
  const start = todayISO();
  for(let i=0;i<28;i++) days.push(shiftISO(start, i));
  return `<div class="kanban-strip">
    <div class="ks-title">${icon('reprog',13)} <strong>Reprogramar arrastando:</strong> arraste um card sobre uma data para reprogramar.</div>
    <div class="ks-days">${days.map(iso=>{
      const d = new Date(iso+'T12:00:00');
      const dow = d.toLocaleDateString('pt-BR',{weekday:'short'}).replace('.','');
      return `<div class="ks-day ${iso===todayISO()?'today':''}" data-date="${iso}" title="Reprogramar para ${fmtDate(iso)}"><span class="ks-dow">${dow}</span><span class="ks-num">${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}</span></div>`;
    }).join('')}</div>
  </div>`;
}

function bindOseKanbanDrag(area){
  let dragId = null;
  area.querySelectorAll('.kcard[draggable]').forEach(card=>{
    card.addEventListener('dragstart', e=>{
      dragId = card.dataset.atrib; card.classList.add('dragging');
      try{ e.dataTransfer.setData('text/plain', String(card.dataset.atrib)); e.dataTransfer.effectAllowed='move'; }catch(err){}
    });
    card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); });
  });
  area.querySelectorAll('.kanban-col').forEach(col=>{
    col.addEventListener('dragover', e=>{ e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', ()=>{ col.classList.remove('drag-over'); });
    col.addEventListener('drop', e=>{
      e.preventDefault(); col.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) osePedirMotivoStatus(id, col.dataset.dropStatus);
    });
  });
  area.querySelectorAll('.ks-day').forEach(day=>{
    day.addEventListener('dragover', e=>{ e.preventDefault(); day.classList.add('drag-over'); });
    day.addEventListener('dragleave', ()=>{ day.classList.remove('drag-over'); });
    day.addEventListener('drop', e=>{
      e.preventDefault(); day.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) openOseReprogramarConfirmacao(id, day.dataset.date);
    });
  });
  area.querySelectorAll('[data-open-ose]').forEach(c=>c.addEventListener('click', ()=>openOseDetalhe(c.dataset.openOse)));
}

/* --- OSE Calendário --- */
function renderOseCalendarioInto(area, list){
  const subTabs = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
      <div class="tabs">
        <button class="tab ${oseFilters.calView==='mes'?'active':''}" data-cal-view="mes">Mês (externa)</button>
        <button class="tab ${oseFilters.calView==='dia'?'active':''}" data-cal-view="dia">Dia (interna)</button>
      </div>
      ${oseFilters.calView==='dia'? `<div style="display:flex;align-items:center;gap:8px;">
        <button class="icon-btn" id="ose-day-prev">${icon('chevL',16)}</button>
        <span class="mono" style="color:var(--text);font-weight:700;">${fmtDate(oseFilters.calDay)}</span>
        <button class="icon-btn" id="ose-day-next">${icon('chevR',16)}</button>
      </div>`:''}
      <span style="font-size:12px;color:var(--muted);">${list.length} programação(ões)</span>
    </div>`;
  const bindCalTabs = ()=>{
    area.querySelectorAll('.tab[data-cal-view]').forEach(b=>b.addEventListener('click', ()=>{ oseFilters.calView=b.dataset.calView; renderContent(); }));
  };
  if(oseFilters.calView==='dia'){
    const dayList = list.filter(x=>(x.atribuicao.dataProgramada||x.programacao.dataProgramacao)===oseFilters.calDay);
    area.innerHTML = subTabs + (dayList.length? renderOseDayList(dayList) : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhuma programação em ${fmtDate(oseFilters.calDay)}.</p></div></div>`);
    bindCalTabs();
    const pv=area.querySelector('#ose-day-prev'), nx=area.querySelector('#ose-day-next');
    if(pv) pv.addEventListener('click', ()=>{ oseFilters.calDay=shiftISO(oseFilters.calDay,-1); renderContent(); });
    if(nx) nx.addEventListener('click', ()=>{ oseFilters.calDay=shiftISO(oseFilters.calDay,1); renderContent(); });
    area.querySelectorAll('[data-open-ose]').forEach(c=>c.addEventListener('click', ()=>openOseDetalhe(c.dataset.openOse)));
    area.querySelectorAll('[data-ose-doc]').forEach(c=>c.addEventListener('click', ()=>openOseDocProgramacao(c.dataset.oseDoc)));
    return;
  }
  const year = oseCalRef.getFullYear(), month = oseCalRef.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const monthName = oseCalRef.toLocaleDateString('pt-BR', {month:'long', year:'numeric'});
  const byDate = {};
  list.forEach(x=>{
    const d = x.atribuicao.dataProgramada||x.programacao.dataProgramacao;
    (byDate[d] = byDate[d]||[]).push(x);
  });
  let cells = '';
  for(let i=0;i<startDow;i++) cells += `<div class="cal-cell out"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const iso = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const items = byDate[iso]||[];
    const isToday = iso===todayISO();
    cells += `<div class="cal-cell ${isToday?'today':''}">
      <div class="cal-daynum" data-day-view="${iso}" style="cursor:pointer;" title="Ver dia">${d} ${items.length?`<span style="color:var(--accent);">· ${items.length}</span>`:''}</div>
      ${items.slice(0,3).map(x=>{
        const eq=findEquipe(x.atribuicao.equipeId); const late=x.atribuicao.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(x.atribuicao.status); const c=STATUS_COLOR[x.atribuicao.status]||'var(--muted)';
        return `<div class="cal-chip ${late?'late-blink late':''}" style="color:${late?'var(--purple)':c};border-color:${late?'rgba(180,140,224,.5)':'var(--border)'}" data-open-ose="${x.atribuicao.id}">${equipeLabel(eq)}</div>`;
      }).join('')}
      ${items.length>3? `<div style="font-size:10px;color:var(--accent);cursor:pointer;" data-day-view="${iso}">+${items.length-3} mais</div>`:''}
    </div>`;
  }
  const dows = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  area.innerHTML = `
    ${subTabs}
    <div class="panel" style="padding:16px;">
      <div class="cal-nav">
        <button class="icon-btn" id="ose-cal-prev">${icon('chevL',16)}</button>
        <h3 style="text-transform:capitalize;">${monthName}</h3>
        <button class="icon-btn" id="ose-cal-next">${icon('chevR',16)}</button>
      </div>
      <div class="cal-grid">${dows.map(d=>`<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
    </div>`;
  bindCalTabs();
  document.getElementById('ose-cal-prev').addEventListener('click', ()=>{ oseCalRef = new Date(year, month-1, 1); renderContent(); });
  document.getElementById('ose-cal-next').addEventListener('click', ()=>{ oseCalRef = new Date(year, month+1, 1); renderContent(); });
  area.querySelectorAll('[data-day-view]').forEach(c=>c.addEventListener('click', ()=>{ oseFilters.calDay=c.dataset.dayView; oseFilters.calView='dia'; renderContent(); }));
  area.querySelectorAll('[data-open-ose]').forEach(c=>c.addEventListener('click', ()=>openOseDetalhe(c.dataset.openOse)));
}

function renderOseDayList(dayList){
  return `<div style="display:flex;flex-direction:column;gap:14px;">${dayList.map(x=>{
    const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
    const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
    const ativResumo = (a.atividades||[]).map(at=>{ const atd=findAtividade(at.atividadeId); return `${esc(atd?.codigo||'?')} ×${at.quantidadePrevista??'—'}`; }).join(', ');
    return `<div class="panel">
      <div class="panel-head">
        <div><h3>${esc(p.municipio||'—')} · ${esc(p.subestacao||'—')}</h3><div class="admin-field-meta">${oseProgLabel(p)} · ${equipeLabel(eq)} · ${fmtDate(a.dataProgramada)}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${statusBadge(a.status, late)}</div>
      </div>
      <div style="padding:12px 16px;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${ativResumo||'Sem atividades'}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-sm" data-ose-doc="${p.id}">${icon('print',13)} Imprimir</button>
          <button class="btn btn-sm" data-open-ose="${a.id}">${icon('calendar',13)} Ver detalhe</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* --- OSE Detalhe Modal --- */
function oseDetalheHtml(programacao, atrib, comAcoes=true){
  const eq = findEquipe(atrib.equipeId);
  const late = atrib.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(atrib.status);
  const rows = (atrib.atividades||[]).map(a=>{
    const at = findAtividade(a.atividadeId);
    return { at, prev: a.quantidadePrevista||0, exec: a.quantidadeExecutada!=null? a.quantidadeExecutada : null };
  });
  return `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="dtl-header">
        <div style="min-width:0;">
          <div class="dtl-code">${esc(programacao.municipio||'—')} · ${esc(programacao.subestacao||'—')} · ${esc(programacao.tipoIntervencao||'')}</div>
          <div class="dtl-title">${oseProgLabel(programacao)}</div>
          <div class="dtl-meta"><span>${icon('calendar',12)} ${fmtDate(atrib.dataProgramada)}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${statusBadge(atrib.status, late)}</div>
      </div>

      <div class="dtl-grid">
        <div class="dtl-tile"><div class="dtl-tile-lbl">Equipe</div><div class="dtl-tile-val"><span class="badge-prefix">${equipeLabel(eq)}</span></div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Data programada</div><div class="dtl-tile-val mono">${fmtDate(atrib.dataProgramada)}</div>${late? `<div class="late-flag" style="font-size:11px;margin-top:4px;">VENCIDA</div>`:''}</div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Encarregado</div><div class="dtl-tile-val">${esc(eq?.encarregado||'—')}</div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Status</div><div class="dtl-tile-val">${statusBadge(atrib.status, late)}</div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Status Doc.</div><div class="dtl-tile-val"><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(programacao.statusDocumentacao||'—')}</span></div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Tipo Intervenção</div><div class="dtl-tile-val"><span class="badge" style="color:${programacao.tipoIntervencao==='Aéreo'?'var(--blue)':programacao.tipoIntervencao==='Subterrâneo'?'var(--accent)':'var(--purple)'};background:${programacao.tipoIntervencao==='Aéreo'?'rgba(78,140,235,.14)':programacao.tipoIntervencao==='Subterrâneo'?'rgba(224,164,88,.14)':'rgba(180,140,224,.14)'};">${esc(programacao.tipoIntervencao||'—')}</span></div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Município</div><div class="dtl-tile-val">${esc(programacao.municipio||'—')}</div></div>
        <div class="dtl-tile" style="grid-column:1/-1;"><div class="dtl-tile-lbl">Local de execução</div><div class="dtl-tile-val">${programacao.local? esc(programacao.local) : '—'}</div>${(programacao.local||programacao.localLat!=null)? `<div style="margin-top:4px;font-size:11.5px;"><a href="${esc(localMapsHref(programacao.local,programacao.localLat,programacao.localLng))}" target="_blank" rel="noopener" style="color:var(--blue);font-weight:600;">${icon('pin',11)} Abrir no Google Maps</a></div>`:''}</div>
      </div>

      <div class="dtl-section">
        <div class="dtl-section-head"><h4>Atividades</h4></div>
        <div class="table-scroll"><table class="min">
          <thead><tr><th>Código</th><th>Descrição</th><th>Un.</th><th>Prev.</th><th>Exec.</th></tr></thead>
          <tbody>${rows.map(r=>`<tr>
            <td class="mono" style="color:var(--accent);font-weight:700;">${esc(r.at?.codigo||'?')}</td>
            <td>${esc(r.at?.descricao||'')}</td><td>${esc(r.at?.unidade||'')}</td>
            <td class="mono">${r.prev||'—'}</td>
            <td class="mono">${r.exec!=null? r.exec:'—'}</td>
          </tr>`).join('')}
          </tbody>
        </table></div>
      </div>

      ${String(programacao.observacoes||'').trim()? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Observações</h4></div>
        <div style="white-space:pre-wrap;line-height:1.55;padding:12px;">${esc(programacao.observacoes)}</div>
      </div>`:''}

      ${(programacao.anexos&&programacao.anexos.length)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Anexos do programador</h4><span class="mono">${programacao.anexos.length} imagem(ns)</span></div>
        ${anexosDisplayHtml(programacao.anexos)}
      </div>`:''}

      ${(programacao.localLat!=null && programacao.localLng!=null)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Localização no mapa</h4></div>
        <div style="padding:12px;"><a href="${esc(staticMapUrl(programacao.localLat,programacao.localLng,16,800,450))}" target="_blank" rel="noopener">${localThumbHtml(programacao.local,programacao.localLat,programacao.localLng)}</a></div>
      </div>`:''}

      ${String(programacao.orientacoesPlanejamento||'').trim()? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Orientações do Setor de Planejamento</h4></div>
        <div style="white-space:pre-wrap;line-height:1.55;">${esc(programacao.orientacoesPlanejamento)}</div>
      </div>`:''}

      ${comAcoes? `<div class="dtl-actions">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="dtl-actions-lbl">Alterar status:</span>
          ${STATUS_OSE.filter(s=>s!==atrib.status).map(s=>`<button type="button" class="btn btn-sm" data-set-ose-status="${s}">→ ${s}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm" data-whats-ose="${programacao.id}">${icon('whatsapp',13)} WhatsApp</button>
          <button type="button" class="btn btn-sm" data-edit-ose="${programacao.id}">${icon('edit',13)} Editar</button>
          <button type="button" class="btn btn-sm" data-doc-ose="${programacao.id}">${icon('print',13)} Documento</button>
          <button type="button" class="btn btn-sm" data-reprog-ose="${atrib.id}">${icon('reprog',13)} Reprogramar</button>
          <button type="button" class="btn btn-sm" data-hist-ose="${atrib.id}">${icon('history',13)} Histórico</button>
        </div>
      </div>`:''}
    </div>`;
}

function openOseDetalhe(atribId){
  const r = oseAtribGlobal(Number(atribId));
  if(!r) return;
  const body = oseDetalheHtml(r.programacao, r.atribuicao);
  openModal({ title:'Detalhe da programação OSE', bodyHtml: body, submitLabel:'Fechar', wide:true,
    onMount:(root)=>{
      root.querySelectorAll('[data-set-ose-status]').forEach(b=>b.addEventListener('click', ()=>{
        if(!requerEscrita()) return;
        osePedirMotivoStatus(r.atribuicao.id, b.dataset.setOseStatus);
      }));
      root.querySelectorAll('[data-whats-ose]').forEach(b=>b.addEventListener('click', ()=>encaminharOseWhats(b.dataset.whatsOse)));
      root.querySelectorAll('[data-edit-ose]').forEach(b=>b.addEventListener('click', ()=>{
        document.getElementById('modal-root').innerHTML='';
        openOseProgramacaoModal(Number(b.dataset.editOse));
      }));
      root.querySelectorAll('[data-doc-ose]').forEach(b=>b.addEventListener('click', ()=>openOseDocProgramacao(b.dataset.docOse)));
      root.querySelectorAll('[data-reprog-ose]').forEach(b=>b.addEventListener('click', ()=>openOseReprogramarConfirmacao(b.dataset.reprogOse)));
      root.querySelectorAll('[data-hist-ose]').forEach(b=>b.addEventListener('click', ()=>openOseHistoricoModal(b.dataset.histOse)));
    },
    onSubmit:()=>true
  });
}

/* --- OSE WhatsApp --- */
function buildOseWhatsMessage(prog, atrib){
  const eq = findEquipe(atrib.equipeId);
  const ativs = (atrib.atividades||[]).map((a,i)=>{
    const at = findAtividade(a.atividadeId);
    return `${i+1}. *${at?.codigo||'?'}* · ${at?.descricao||''} — ${a.quantidadePrevista??'—'} ${at?.unidade||''}`;
  }).join('\n');
  return [
    `*G26 New · Programação de OSE*`,
    ``,
    `*Programação:* ${oseProgLabel(prog)}`,
    `*Município:* ${prog.municipio||'—'}  ·  *Subestação:* ${prog.subestacao||'—'}`,
    `*Tipo Intervenção:* ${prog.tipoIntervencao||'—'}`,
    `*Data:* ${fmtDate(atrib.dataProgramada)}`,
    `*Equipe:* ${equipeLabel(eq)}`,
    ``,
    ...localWhatsLine(prog.local, prog.localLat, prog.localLng),
    ``,
    `*Atividades programadas:*`,
    ativs||'—',
    ``,
    `*Supervisor:* ${eq?.supervisor||'—'}`,
    `*Encarregado:* ${eq?.encarregado||'—'}  ·  *Motorista:* ${eq?.motorista||'—'}`,
    ``,
    `*Acesso da equipe (QR):*`,
    equipePageUrlOse(prog.id, atrib.equipeId),
    ``,
    `_Caso tenha problemas técnicos, entre em contato:_`,
    `https://wa.me/${WHATS_SUPORTE}`
  ].join('\n');
}

function encaminharOseWhats(progId){
  const prog = findOseProg(Number(progId));
  if(!prog) return;
  const teams = (prog.atribuicoes||[]).filter(a=>a.status!=='Cancelado');
  if(!teams.length) return;
  if(teams.length===1){
    const atrib = teams[0];
    const eq = findEquipe(atrib.equipeId);
    if(!eq?.whatsapp || !phoneDigits(eq.whatsapp)){ toast('Sem WhatsApp cadastrado para: '+equipeLabel(eq)+'. Edite a equipe e informe o número.', 'error'); return; }
    window.open(waLink(eq.whatsapp, buildOseWhatsMessage(prog, atrib)), '_blank');
    toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
    registrarEvento('compartilhamento','programacao',prog.id,oseProgLabel(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
    return;
  }
  const body = teams.map(atrib=>{
    const eq = findEquipe(atrib.equipeId);
    const temWhats = eq?.whatsapp && phoneDigits(eq.whatsapp);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(equipeLabel(eq))}</div>
        <div style="font-size:11px;color:var(--muted-2);">${temWhats? esc(eq.whatsapp) : 'Sem WhatsApp cadastrado'}</div>
      </div>
      <button type="button" class="btn btn-sm${temWhats?' btn-primary':' btn-ghost'}" ${temWhats?`data-wa-ose-send="${atrib.equipeId}"`:'disabled'} style="white-space:nowrap;">${icon('whatsapp',13)} Enviar</button>
    </div>`;
  }).join('');
  openModal({
    title: 'Encaminhar para equipe(s)',
    bodyHtml: `<div style="margin-bottom:8px;font-size:12px;color:var(--muted);">Selecione a equipe para enviar a programação OSE via WhatsApp.</div>${body}`,
    submitLabel: 'Enviar para todas',
    onSubmit: ()=>{
      teams.forEach(atrib=>{
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildOseWhatsMessage(prog, atrib)), '_blank');
        }
      });
      toast(teams.length+' mensagem(ns) encaminhada(s).');
      registrarEvento('compartilhamento','programacao',prog.id,oseProgLabel(prog), 'Encaminhado via WhatsApp para '+teams.length+' equipe(s)');
      return true;
    },
    onMount: (root)=>{
      root.querySelectorAll('[data-wa-ose-send]').forEach(b=>b.addEventListener('click', ()=>{
        const eqId = Number(b.dataset.waOseSend);
        const atrib = teams.find(a=>a.equipeId===eqId);
        if(!atrib) return;
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildOseWhatsMessage(prog, atrib)), '_blank');
          toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
          registrarEvento('compartilhamento','programacao',prog.id,oseProgLabel(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
        }
      }));
    }
  });
}

/* --- OSE Documento de Campo --- */
function oseDocAtribuicaoHtml(prog, atrib){
  const eq = findEquipe(atrib.equipeId);
  const rows = (atrib.atividades||[]).map((a,idx)=>{
    const at = findAtividade(a.atividadeId);
    return `<tr>
      <td style="text-align:center;">${idx+1}</td>
      <td class="mono" style="font-weight:700;">${esc(at?.codigo||'?')}</td>
      <td>${esc(at?.descricao||'')}</td>
      <td style="text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="text-align:center;">${a.quantidadePrevista??'—'}</td>
      <td style="height:22px;"></td>
    </tr>`;
  }).join('');
  return `
  <div class="ps-block">
    <div class="ps-block-head">
      <div>${oseProgLabel(prog)} — ${esc(prog.municipio||'Município')} — ${equipeLabel(eq)} — ${fmtDate(atrib.dataProgramada)}</div>
      <div class="ps-qr">${qrSvgHtml(equipePageUrlOse(prog.id, atrib.equipeId), 3)}<div class="ps-qr-cap">Escaneie para acessar a página de serviço</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Supervisor</th><td>${esc(eq?.supervisor||'—')}</td><th>Encarregado</th><td>${esc(eq?.encarregado||'—')}</td></tr>
      <tr><th>Motorista</th><td>${esc(eq?.motorista||'—')}</td><th>Eletricistas</th><td>${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</td></tr>
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:''}</td></tr>`:''}
    </table>
    <table>
      <thead><tr><th style="width:26px;">#</th><th>Código</th><th>Descrição</th><th style="width:40px;">Un.</th><th style="width:52px;">Qtd prev.</th><th style="width:64px;">Qtd exec.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="ps-check"><div><strong>Executou?</strong> &nbsp;☐ SIM &nbsp;☐ NÃO &nbsp;☐ PARCIAL</div><div><strong>Data da execução:</strong> ____/____/____</div></div>
    <div class="ps-sign"><strong>Observações do campo:</strong><div class="ps-obs"></div></div>
    <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
  </div>`;
}
function buildOseDocProgramacao(prog){
  return `
    <div class="ps-head">
      <div><h1>G26 New · Programação OSE</h1><div class="ps-sub">Documento de campo — programação</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(prog.dataProgramacao)}</div><div class="ps-sub">Emissão: ${fmtDateTime(Date.now())}</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Programação</th><td><strong>${oseProgLabel(prog)}</strong></td><th>Emissão</th><td>${fmtDateTime(Date.now())}</td></tr>
      <tr><th>Município</th><td>${esc(prog.municipio||'—')}</td><th>Subestação</th><td>${esc(prog.subestacao||'—')}</td></tr>
      <tr><th>Tipo Intervenção</th><td>${esc(prog.tipoIntervencao||'—')}</td><th>Status Doc.</th><td>${esc(prog.statusDocumentacao||'—')}</td></tr>
      ${prog.observacoes? `<tr><th>Observações</th><td colspan="3">${esc(prog.observacoes)}</td></tr>`:''}
      ${String(prog.orientacoesPlanejamento||'').trim()? `<tr><th>Orientações do Setor de Planejamento</th><td colspan="3">${esc(prog.orientacoesPlanejamento)}</td></tr>`:''}
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:(prog.local? ` — <a href="${esc(mapsLinkByAddress(prog.local))}">${esc(mapsLinkByAddress(prog.local))}</a>`:'')}</td></tr>`:''}
    </table>
    ${(prog.atribuicoes||[]).map(at=> oseDocAtribuicaoHtml(prog, at)).join('')}
    ${(prog.localLat!=null&&prog.localLng!=null)? `<div class="ps-block" style="page-break-before:auto;break-before:auto;margin-top:8px;">
      <div class="ps-block-head">Localização no mapa — ${oseProgLabel(prog)}</div>
      ${staticMapImgTag(prog.localLat,prog.localLng,16,720,420, 'Mapa: '+(prog.local||''), 'width:100%;max-width:620px;border:1px solid #999;border-radius:4px;')}
      <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div class="ps-qr-box">${qrSvgHtml(mapsLinkByCoords(prog.localLat,prog.localLng), 4)}</div>
        <div style="font-size:11px;color:#333;"><strong>Escaneie para abrir no Google Maps</strong><br>${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</div>
      </div>
    </div>`:''}
<div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>
${docAnexosHtmlGeneric(prog, oseProgLabel)}
`;
}
function openOseDocProgramacao(pgId){
  const prog = findOseProg(Number(pgId));
  if(!prog) return;
  printDocumento(buildOseDocProgramacao(prog));
}
function openOseDocDataModal(){
  const body = `
    <div class="field"><label>Data <span class="req">*</span></label><input type="date" name="data" required value="${todayISO()}"></div>
    <div class="field-hint">Gera um documento de campo com todas as equipes OSE programadas nesta data.</div>`;
  openModal({
    title:'Documento de campo OSE — por data', bodyHtml:body, submitLabel:'Gerar e imprimir',
    onSubmit:(fd)=>{
      const data = fd.get('data');
      if(!data){ toast('Informe a data.', 'error'); return false; }
      const list = flatOseAtribuicoes().filter(x=> (x.atribuicao.dataProgramada||x.programacao.dataProgramacao)===data && x.atribuicao.status!=='Cancelado');
      if(!list.length){ toast('Nenhuma programação OSE nesta data.', 'error'); return false; }
      const html = `
        <div class="ps-head">
          <div><h1>G26 New · Programação OSE</h1><div class="ps-sub">Documento de campo — ${fmtDate(data)}</div></div>
          <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(data)}</div><div class="ps-sub">${list.length} equipe(s) programada(s)</div></div>
        </div>
        ${list.map(x=> oseDocAtribuicaoHtml(x.programacao, x.atribuicao)).join('')}
        <div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>`;
      printDocumento(html);
    }
  });
}

/* --- OSE Histórico --- */
function openOseHistoricoModal(atribId){
  const r = oseAtribGlobal(Number(atribId));
  if(!r) return;
  const events = [...(r.atribuicao.historico||[])].sort((a,b)=>b.ts-a.ts);
  if(!events.length){
    openModal({ title:'Histórico', bodyHtml:'<div style="padding:24px;color:var(--muted-2);font-size:12.5px;">Sem eventos registrados.</div>', submitLabel:'Fechar', onSubmit:()=>true, wide:true });
    return;
  }
  const html = `<div class="timeline">${events.map(h=>{
    let dotColor='var(--muted)', title='';
    if(h.tipo==='criacao'){ dotColor='var(--blue)'; title='Programação criada'; }
    else if(h.tipo==='status'){ dotColor=STATUS_COLOR[h.para]||'var(--muted)'; title=`Status alterado: ${h.de} → ${h.para}`; }
    else if(h.tipo==='reprogramacao'){ dotColor='var(--purple)'; title=`Reprogramada: ${fmtDate(h.de)} → ${fmtDate(h.para)}`; }
    else { title=h.tipo||'Evento'; }
    return `<div class="tl-item" style="--dot-c:${dotColor}"><div class="tl-title">${title}</div><div class="tl-meta">${fmtDateTime(h.ts)} · <strong style="color:var(--muted);">${autor(h)}</strong></div>${h.motivo? `<div class="tl-motivo"><strong>Motivo:</strong> ${esc(h.motivo)}${h.obs? ' — '+esc(h.obs):''}</div>`:''}</div>`;
  }).join('')}</div>`;
  openModal({ title:'Histórico — '+oseProgLabel(r.programacao), bodyHtml:html, submitLabel:'Fechar', onSubmit:()=>true, wide:true });
}

/* --- openOseProgramacaoModal --- */
function openOseProgramacaoModal(id){
  if(!requerEscrita()) return;
  const pg = id ? findOseProg(id) : null;
  let atribs = pg ? pg.atribuicoes.map(a=>({ equipeId:String(a.equipeId), atividades: a.atividades.map(x=>({atividadeId:String(x.atividadeId), quantidadePrevista:x.quantidadePrevista??'', qtdAnomalia:x.qtdAnomalia??''})) })) : [{ equipeId:'', atividades:[{atividadeId:'',quantidadePrevista:'',qtdAnomalia:''}] }];
  let anexos = pg ? (pg.anexos||[]).map(a=>({...a})) : [];
  let anexosEnviando = false;
  let localAddr = pg?.local||'';
  let localLat = pg?.localLat??null;
  let localLng = pg?.localLng??null;

  function atribBlockHtml(a,i){
    const searchId = `ose-act-search-${i}`;
    return `<div class="atrib-block" data-idx="${i}">
      <div class="atrib-head">
        <select class="atrib-equipe" data-idx="${i}"><option value="">Selecione a equipe…</option>${equipesVisiveis().filter(e=>e.ativo!==false).map(e=>`<option value="${e.id}" ${String(a.equipeId)===String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' · '+esc(e.encarregado):''}</option>`).join('')}</select>
        ${atribs.length>1? `<button type="button" class="icon-btn atrib-remove" data-idx="${i}">${icon('trash',14)}</button>`:''}
      </div>
      <div class="atrib-meta-live" data-idx="${i}"></div>
      <div class="field" style="margin-bottom:8px;">
        <label for="${searchId}">${icon('search',14)} Buscar atividade (código ou descrição)</label>
        <input type="search" id="${searchId}" placeholder="Filtrar atividades…" style="width:100%;">
      </div>
      <div class="atrib-activities">${a.atividades.map((at,j)=>activityRowHtml(a,i,at,j)).join('')}</div>
      <button type="button" class="btn btn-sm btn-ghost atrib-add-activity" data-idx="${i}">${icon('plus',13)} Adicionar atividade</button>
    </div>`;
  }
  function activityRowHtml(a,i,at,j){
    return `<div class="activity-row" data-idx="${i}" data-jdx="${j}">
      <select class="act-select" data-idx="${i}" data-jdx="${j}"><option value="">Atividade…</option>${atividadesOrdenadas().map(x=>`<option value="${x.id}" ${String(at.atividadeId)===String(x.id)?'selected':''}>${isFavorita(x.id)?'★ ':''}${esc(x.codigo)} · ${esc(x.descricao)}</option>`).join('')}</select>
      <input type="number" step="0.01" min="0" class="act-qty" data-idx="${i}" data-jdx="${j}" placeholder="Qtd." value="${at.quantidadePrevista??''}">
      <input type="number" step="1" min="0" class="act-anom" data-idx="${i}" data-jdx="${j}" placeholder="Anom." title="Quantidade de anomalias programadas" style="max-width:90px;" value="${at.qtdAnomalia??''}">
      ${a.atividades.length>1? `<button type="button" class="icon-btn act-remove" data-idx="${i}" data-jdx="${j}">${icon('close',13)}</button>`:''}
    </div>`;
  }
  function renderAtribsHtml(){ return atribs.map((a,i)=>atribBlockHtml(a,i)).join(''); }

  const bodyHtml = `
    <div class="field-row">
      <div class="field"><label>Município <span class="req">*</span></label><input type="text" name="municipio" value="${esc(pg?.municipio||'')}" required placeholder="Nome do município"></div>
      <div class="field"><label>Subestação</label><input type="text" name="subestacao" value="${esc(pg?.subestacao||'')}" placeholder="Nome da subestação"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Número da OSE</label><input type="text" name="numeroOse" value="${esc(pg?.numeroOse||'')}"></div>
      <div class="field"><label>Tipo de Intervenção</label><select name="tipoIntervencao"><option value="">Selecione…</option>${TIPO_INTERVENCAO_OPCOES.map(v=>`<option ${pg?.tipoIntervencao===v?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Status Documentação</label><select name="statusDocumentacao"><option value="">Selecione…</option>${STATUS_DOC_OPCOES.map(v=>`<option ${pg?.statusDocumentacao===v?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field-row">
      <div class="field"><label>Data início <span class="req">*</span></label><input type="date" name="dataProgramacao" required value="${pg?.dataProgramacao||todayISO()}"></div>
      <div class="field"><label>Data fim (opcional)</label><input type="date" name="dataFim" value="${pg?.dataProgramacao||''}"><div class="field-hint">Se preenchido, cria uma programação para cada dia no intervalo. Deixe vazio para criar apenas 1.</div></div>
    </div>
    <div class="field"><label>Observações</label><textarea name="observacoes" rows="2" placeholder="Observações da programação OSE">${esc(pg?.observacoes||'')}</textarea></div>
    <div class="field"><label>Local / endereço de execução</label>
      <input type="text" name="local" id="ose-local" required value="${esc(pg?.local||'')}" placeholder="Digite o endereço...">
      <div class="field-hint">Enquanto digita, geramos o link do Google Maps. Marque o ponto exato no mapa interativo.</div>
      <div id="ose-local-tools"></div>
      <div id="ose-map-wrap" style="display:none;margin-top:8px;">
        <div id="ose-local-map" style="height:460px;width:100%;border-radius:10px;overflow:hidden;border:1px solid var(--border-soft);"></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-primary" id="ose-map-confirm">Confirmar local no mapa</button>
          <button type="button" class="btn btn-sm btn-ghost" id="ose-map-cancel">Fechar mapa</button>
        </div>
      </div>
    </div>
    <div class="field"><label>Anexos</label>
      <input type="file" id="ose-anexos-input" accept="image/*" multiple>
      <div class="field-hint">Imagens para a equipe visualizar (croqui, localização, detalhe do serviço).</div>
      <div id="ose-anexos-preview">${anexosGridHtml(anexos, true)}</div>
      <div id="ose-anexos-progress" style="display:none;margin-top:8px;">
        <div id="ose-anexos-progress-text" style="font-size:11px;color:var(--muted);margin-bottom:4px;">Enviando…</div>
        <div style="height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div id="ose-anexos-progress-fill" style="height:100%;width:0%;background:var(--accent);transition:width .2s;"></div></div>
      </div>
    </div>
    <div class="field"><label>Orientações do Setor de Planejamento</label>
      <textarea name="orientacoesPlanejamento" rows="3" placeholder="Orientação de execução, restrições, pontos de atenção para a equipe...">${esc(pg?.orientacoesPlanejamento||'')}</textarea>
    </div>
    ${renderCustomFieldsInputs('programacoes', pg)}
    <div class="field"><label>Equipes e atividades <span class="req">*</span></label>
      <div id="atribs-container">${renderAtribsHtml()}</div>
      <button type="button" class="btn btn-sm" id="add-atrib-btn" style="margin-top:6px;align-self:flex-start;">${icon('plus',13)} Adicionar equipe</button>
    </div>`;

  openModal({
    title: pg? 'Editar programação OSE' : 'Nova programação OSE', bodyHtml, extraWide: true, submitLabel: pg? 'Salvar alterações':'Programar',
    onMount:(root)=>{
      function refreshContainer(){
        document.getElementById('atribs-container').innerHTML = renderAtribsHtml(); bindDynamic();
      }
      function bindDynamic(){
        root.querySelectorAll('.atrib-equipe').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].equipeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.atrib-remove').forEach(b=>b.addEventListener('click', e=>{ atribs.splice(Number(e.currentTarget.dataset.idx),1); refreshContainer(); }));
        root.querySelectorAll('.atrib-add-activity').forEach(b=>b.addEventListener('click', e=>{ atribs[Number(e.currentTarget.dataset.idx)].atividades.push({atividadeId:'',quantidadePrevista:'',qtdAnomalia:''}); refreshContainer(); }));
        root.querySelectorAll('.act-select').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].atividadeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-qty').forEach(s=>s.addEventListener('input', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].quantidadePrevista = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-anom').forEach(s=>s.addEventListener('input', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].qtdAnomalia = e.target.value; }));
        root.querySelectorAll('.act-remove').forEach(b=>b.addEventListener('click', e=>{ const i=Number(e.currentTarget.dataset.idx), j=Number(e.currentTarget.dataset.jdx); atribs[i].atividades.splice(j,1); refreshContainer(); }));
        root.querySelectorAll('input[type="search"][id^="ose-act-search-"]').forEach(input=>{
          const idx = input.id.replace('ose-act-search-','');
          input.addEventListener('input', ()=>{
            const term = input.value.toLowerCase();
            root.querySelectorAll(`.act-select[data-idx="${idx}"]`).forEach(sel=>{
              const selected = sel.value;
              Array.from(sel.options).forEach(opt=>{
                if(opt.value==='') return;
                opt.style.display = opt.textContent.toLowerCase().includes(term) ? '' : 'none';
              });
              if(selected && !Array.from(sel.options).find(o=>o.value===selected && o.style.display!=='none')) sel.value = '';
            });
          });
        });
        atualizarMetaIndicadores();
      }
      function atualizarMetaIndicadores(){
        root.querySelectorAll('.atrib-meta-live').forEach(el=>{
          const i = Number(el.dataset.idx);
          const a = atribs[i];
          const eq = a && a.equipeId? findEquipe(a.equipeId) : null;
          const meta = metaDiaria(eq);
          const total = (a?.atividades||[]).reduce((s,at)=>{
            const atDef = at.atividadeId? findAtividade(at.atividadeId) : null;
            return s + (parseFloat(at.quantidadePrevista)||0) * (atDef?.valorUnitario||0);
          },0);
          if(!eq){ el.innerHTML=''; return; }
          if(!meta){
            el.innerHTML = `<div class="atrib-meta-wrap"><span style="font-size:11px;color:var(--muted);">Programação total: <strong>${fmtMoney(total)}</strong> (meta diária não definida para esta equipe)</span></div>`;
            return;
          }
          const pct = Math.round(total/meta*100);
          const cor = pct>=100? 'var(--green)' : pct>=50? 'var(--accent)' : 'var(--red)';
          el.innerHTML = `<div class="atrib-meta-wrap">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <strong style="font-size:11px;letter-spacing:.02em;">PROGRAMAÇÃO EM <span style="color:${cor};">${pct}%</span> DA META DA EQUIPE</strong>
              <span style="font-size:11px;color:var(--muted);">${fmtMoney(total)} de ${fmtMoney(meta)}</span>
            </div>
            <div class="atrib-meta-bar"><div style="width:${Math.min(100,pct)}%;background:${cor};"></div></div>
          </div>`;
        });
      }
      bindDynamic();
      document.getElementById('add-atrib-btn').addEventListener('click', ()=>{ atribs.push({equipeId:'',atividades:[{atividadeId:'',quantidadePrevista:'',qtdAnomalia:''}]}); refreshContainer(); });

      const anexosPreview = root.querySelector('#ose-anexos-preview');
      const anexosInput = root.querySelector('#ose-anexos-input');
      const anexosProgress = root.querySelector('#ose-anexos-progress');
      const anexosProgressText = root.querySelector('#ose-anexos-progress-text');
      const anexosProgressFill = root.querySelector('#ose-anexos-progress-fill');
      function paintAnexos(){
        anexosPreview.innerHTML = anexosGridHtml(anexos, true);
        anexosPreview.querySelectorAll('.anexo-remove').forEach(b=>b.addEventListener('click', ()=>{
          anexos.splice(Number(b.dataset.i),1); paintAnexos();
        }));
      }
      anexosInput.addEventListener('change', async ()=>{
        const files = Array.from(anexosInput.files||[]);
        if(!files.length) return;
        const sobra = Math.max(0, 8 - anexos.length);
        const fila = files.slice(0, sobra);
        if(files.length > sobra) toast('Máximo de 8 anexos.', 'error');
        if(!fila.length){ anexosInput.value=''; return; }
        anexosInput.disabled = true;
        anexosEnviando = true;
        const total = fila.length;
        let feitos = 0;
        const atualizar = ()=>{
          anexosProgressFill.style.width = Math.round(feitos/total*100)+'%';
          anexosProgressText.textContent = total>1? `Enviando ${Math.min(feitos+1,total)} de ${total}…` : 'Enviando…';
        };
        anexosProgress.style.display = 'block';
        paintAnexos();
        atualizar();
        await Promise.all(fila.map(async (f)=>{
          let url = '';
          try{
            const blob = await comprimirImagem(f);
            url = await uploadToImgbb(blob);
          }catch(e){ toast('Falha ao enviar '+esc(f.name)+' ('+e.message+').', 'error'); }
          if(url) anexos.push({ nome: f.name||('anexo-'+Date.now()), url, ts: Date.now() });
          feitos++; atualizar(); paintAnexos();
        }));
        anexosEnviando = false;
        anexosProgress.style.display = 'none';
        anexosInput.disabled = false; anexosInput.value='';
        paintAnexos();
      });
      paintAnexos();

      const localInput = root.querySelector('#ose-local');
      const localTools = root.querySelector('#ose-local-tools');
      const mapWrap = root.querySelector('#ose-map-wrap');
      let leafletMap = null;
      function paintLocalTools(){
        if(!localAddr){ localTools.innerHTML=''; return; }
        localTools.innerHTML = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <a href="${esc(mapsLinkByAddress(localAddr))}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;color:var(--blue);font-weight:600;font-size:12.5px;">${icon('pin',13)} Abrir no Google Maps</a>
          <button type="button" class="btn btn-sm" id="ose-open-map" style="font-size:12px;">${icon('pin',13)} Marcar no mapa</button>
        </div>`;
        const openMapBtn = localTools.querySelector('#ose-open-map');
        if(openMapBtn) openMapBtn.addEventListener('click', ()=> showLeafletMap());
      }
      async function showLeafletMap(){
        mapWrap.style.display = 'block';
        try{
          const L = await loadLeaflet();
          const center = localLat!=null && localLng!=null ? [localLat, localLng] : [-17.85, -49.25];
          if(leafletMap){ leafletMap.remove(); leafletMap=null; }
          leafletMap = L.map('ose-local-map').setView(center, localLat!=null? 16 : 12);
          L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Esri' }).addTo(leafletMap);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, opacity:0.5 }).addTo(leafletMap);
          let marker = localLat!=null && localLng!=null ? L.marker(center).addTo(leafletMap) : null;
          leafletMap.on('click', (e)=>{
            if(marker) leafletMap.removeLayer(marker);
            marker = L.marker(e.latlng).addTo(leafletMap);
          });
          setTimeout(()=> leafletMap.invalidateSize(), 200);
          root.querySelector('#ose-map-confirm').onclick = async ()=>{
            if(!marker){ toast('Clique no mapa para marcar um ponto.', 'error'); return; }
            const ll = marker.getLatLng();
            localLat = ll.lat; localLng = ll.lng;
            const rev = await geoapifyReverse(localLat, localLng);
            if(rev){ localAddr = rev; localInput.value = rev; }
            mapWrap.style.display = 'none';
            paintLocalTools();
            toast('Local confirmado no mapa.');
          };
          root.querySelector('#ose-map-cancel').onclick = ()=>{ mapWrap.style.display = 'none'; };
        }catch(e){ toast('Falha ao carregar o mapa: '+e.message, 'error'); mapWrap.style.display='none'; }
      }
      let localDeb = null;
      localInput.addEventListener('input', ()=>{
        localAddr = localInput.value.trim();
        clearTimeout(localDeb);
        localDeb = setTimeout(paintLocalTools, 500);
      });
      paintLocalTools();
    },
    onSubmit:(fd)=>{
      if(anexosEnviando){ toast('Aguarde o envio das imagens.', 'error'); return false; }
      const municipio = fd.get('municipio').trim();
      if(!municipio){ toast('Informe o município.', 'error'); return false; }
      const dataProgramacao = fd.get('dataProgramacao');
      if(!dataProgramacao){ toast('Informe a data de programação.', 'error'); return false; }
      if(!atribs.length || atribs.some(a=>!a.equipeId)){ toast('Selecione a equipe em todos os blocos.', 'error'); return false; }
      for(const a of atribs){ if(!a.atividades.length || a.atividades.some(x=>!x.atividadeId)){ toast('Selecione a atividade em todas as linhas.', 'error'); return false; } }
      const observacoes = String(fd.get('observacoes')||'').trim();
      const orientacoesPlanejamento = String(fd.get('orientacoesPlanejamento')||'').trim();
      const local = String(fd.get('local')||'').trim()||localAddr||'';
      if(!local){ toast('Informe o local da programação.', 'error'); return false; }
      const custom = {};
      (DB.customFields.programacoes||[]).forEach(f=>{ const v=fd.get('cf_'+f.id); if(v!=null) custom[f.id]=v; });
      const base = {
        municipio, subestacao: fd.get('subestacao').trim(),
        numeroOse: fd.get('numeroOse').trim(),
        tipoIntervencao: fd.get('tipoIntervencao'),
        dataProgramacao, statusDocumentacao: fd.get('statusDocumentacao'),
        observacoes, orientacoesPlanejamento, custom,
        local, localLat: local? localLat : null, localLng: local? localLng : null, anexos: anexos.map(a=>({...a})),
        atividades: atribs.map(a=>({
          equipeId: Number(a.equipeId),
          atividades: a.atividades.map(x=>({atividadeId:Number(x.atividadeId), quantidadePrevista: x.quantidadePrevista?parseFloat(x.quantidadePrevista):null, qtdAnomalia: x.qtdAnomalia? parseFloat(x.qtdAnomalia): null, quantidadeExecutada:null}))
        }))
      };
      const dataFim = fd.get('dataFim');
      const datas = (dataFim && dataFim !== dataProgramacao) ? gerarDatasIntervalo(dataProgramacao, dataFim).slice(0,31) : [dataProgramacao];
      if(pg){
        Object.assign(pg, base);
        pg.atribuicoes = base.atividades.map((a,i)=>{
          const existing = pg.atribuicoes.find(x=>x.equipeId===a.equipeId);
          if(existing){ existing.atividades = a.atividades; return existing; }
          return { id: nextId(), equipeId:a.equipeId, dataProgramada:dataProgramacao, status:'Programado', atividades:a.atividades, historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Atribuição criada'}] };
        });
        pg.atribuicoes.forEach(at=>{ at.dataProgramada = dataProgramacao; });
        registrarEvento('edicao','programacao',pg.id,oseProgLabel(pg), (pg.atribuicoes||[]).length+' equipe(s), '+pg.atribuicoes.reduce((s,a)=>s+(a.atividades?.length||0),0)+' atividade(s)');
        toast('Programação OSE atualizada.');
      } else {
        if(datas.length > 1){
          let count = 0;
          for(const dt of datas){
            const novo = { id: nextId(), gid: null, ...base, dataProgramacao: dt,
              status: 'Programado',
              atribuicoes: base.atividades.map(a=>({ id: nextId(), equipeId:a.equipeId, dataProgramada:dt, status:'Programado', atividades:a.atividades.map(x=>({...x})), historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Programação criada'}] }))
            };
            DB.oseProgramacoes.push(novo);
            count++;
          }
          toast(count+' programações OSE criadas no intervalo.');
          registrarEvento('criacao','programacao',DB.oseProgramacoes[DB.oseProgramacoes.length-1].id,oseProgLabel(DB.oseProgramacoes[DB.oseProgramacoes.length-1]), count+' programação(ões) OSE');
        } else {
          const novo = { id: nextId(), gid: null, ...base,
            status: 'Programado',
            atribuicoes: base.atividades.map(a=>({ id: nextId(), equipeId:a.equipeId, dataProgramada:dataProgramacao, status:'Programado', atividades:a.atividades, historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Programação criada'}] }))
          };
          DB.oseProgramacoes.push(novo);
          toast('Programação OSE criada.');
          registrarEvento('criacao','programacao',novo.id,oseProgLabel(novo), novo.atribuicoes.length+' equipe(s), '+novo.atribuicoes.reduce((s,a)=>s+a.atividades.length,0)+' atividade(s)');
        }
      }
      saveData(); renderContent(); renderBanner();
    }
  });
}

/* --- renderOseRdo --- */
function renderOseRdo(){
  const el = document.getElementById('content');
  let registros = flatOseAtribuicoes().filter(rdoTemExecucao);
  registros.sort((a,b)=> String(b.atribuicao.dataProgramada||'').localeCompare(String(a.atribuicao.dataProgramada||'')));

  const stats = (()=>{
    const total = registros.length;
    const concluidos = registros.filter(x=>x.atribuicao.status==='Concluído').length;
    const totalExec = registros.reduce((s,x)=> s+rdoResumo(x).exec, 0);
    const mediaPct = total? Math.round(registros.reduce((s,x)=> s+rdoResumo(x).pct,0)/total) : 0;
    const imped = registros.filter(x=> rdoImpedimentos(x.atribuicao).length>0).length;
    return `
      <div class="grid-stats">
        <div class="stat-card"><div class="lbl">Registros de execução</div><div class="val">${total}</div></div>
        <div class="stat-card" style="--accent-c:var(--green);"><div class="lbl">Concluídas</div><div class="val">${concluidos}</div></div>
        <div class="stat-card" style="--accent-c:var(--blue);"><div class="lbl">Qtd. executada</div><div class="val">${fmtNum(totalExec)}</div></div>
        <div class="stat-card" style="--accent-c:var(--accent);"><div class="lbl">Conclusão média</div><div class="val">${mediaPct}<small>%</small></div></div>
        <div class="stat-card" style="--accent-c:var(--red);"><div class="lbl">Com impedimentos</div><div class="val">${imped}</div></div>
      </div>`;
  })();

  const equipes = [...new Set(registros.map(x=>x.atribuicao.equipeId))].map(id=> findEquipe(id)).filter(Boolean);

  const filters = `
    <div class="panel" style="padding:14px 16px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <input type="search" id="ose-rdo-f-busca" placeholder="Buscar por município, equipe, data, status..." style="flex:1;">
        <button class="btn btn-sm" id="ose-rdo-f-busca-aplicar">${icon('search',13)} Buscar</button>
      </div>
      <div class="filters">
        <label style="font-weight:600;">Equipe</label>
        <select id="ose-rdo-f-equipe"><option value="">Todas</option>${equipes.map(e=>`<option value="${e.id}">${esc(equipeLabel(e))}</option>`).join('')}</select>
        <label style="font-weight:600;">Status</label>
        <select id="ose-rdo-f-status"><option value="">Todos</option>${STATUS_OSE.map(s=>`<option>${s}</option>`).join('')}</select>
        <label style="font-weight:600;">De</label>
        <input type="date" id="ose-rdo-f-de">
        <label style="font-weight:600;">Até</label>
        <input type="date" id="ose-rdo-f-ate">
        <button class="btn btn-sm" id="ose-rdo-f-aplicar">${icon('grid',13)} Filtrar</button>
        <button class="btn btn-sm btn-ghost" id="ose-rdo-f-limpar">Limpar</button>
      </div>
    </div>`;

  const tabela = `
    <div class="panel" style="padding:0;overflow:hidden;">
      <div class="panel-head" style="padding:14px 16px;">
        <div><h3>Execuções OSE</h3><div class="admin-field-meta">Dados de execução OSE registrados pelas equipes.</div></div>
        <div class="filters" style="gap:6px;">
          <button class="btn btn-sm" id="ose-rdo-export">${icon('download',13)} Excel</button>
          <button class="btn btn-sm btn-ghost" id="ose-rdo-print">${icon('print',13)} Imprimir</button>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1200px;">
          <thead>
            <tr>
              <th style="width:30px;">#</th>
              <th>Programação</th>
              <th>Equipe</th>
              <th style="text-align:center;">Data</th>
              <th style="text-align:center;">Status</th>
              <th style="text-align:center;">Horários</th>
              <th style="text-align:center;">Clima</th>
              <th style="text-align:center;">Impedimentos</th>
              <th style="text-align:center;">Prev.</th>
              <th style="text-align:center;">Exec.</th>
              <th style="text-align:center;width:110px;">Progresso</th>
              <th style="text-align:center;">Confirmação</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${registros.map((x,i)=>{
              const eq = findEquipe(x.atribuicao.equipeId);
              const res = rdoResumo(x);
              const imped = rdoImpedimentos(x.atribuicao);
              const horarios = [x.atribuicao.rdoHorarioChegada, x.atribuicao.rdoHorarioSaidaObra].filter(Boolean).join(' → ')||'—';
              return `
                <tr data-ose-prog="${x.programacao.id}" data-ose-atrib="${x.atribuicao.id}" style="cursor:pointer;" title="Ver detalhes">
                  <td style="text-align:center;color:var(--muted-2);">${i+1}</td>
                  <td><strong>${oseProgLabel(x.programacao)}</strong><div class="admin-field-meta">${esc(x.programacao.municipio||'—')} · ${esc(x.programacao.subestacao||'—')}</div></td>
                  <td>${esc(equipeLabel(eq))}<div class="admin-field-meta">${esc(eq?.supervisor||'')}</div></td>
                  <td style="text-align:center;" class="mono">${fmtDate(x.atribuicao.dataProgramada)}</td>
                  <td style="text-align:center;">${rdoStatusBadge(x.atribuicao.status)}</td>
                  <td style="text-align:center;" class="mono">${esc(horarios)}</td>
                  <td style="text-align:center;">${esc(x.atribuicao.rdoCondicoes||'—')}</td>
                  <td style="text-align:center;">${imped.length? `<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);">${imped.length}</span>` : '—'}</td>
                  <td style="text-align:center;" class="mono">${fmtNum(res.prev)}</td>
                  <td style="text-align:center;" class="mono"><strong>${fmtNum(res.exec)}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="flex:1;height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${Math.min(100,res.pct)}%;background:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};border-radius:3px;"></div></div>
                      <span class="mono" style="font-size:11px;min-width:34px;text-align:right;">${res.pct}%</span>
                    </div>
                  </td>
                  <td style="text-align:center;" class="mono"><span style="font-size:11px;">${rdoConfData(x)}</span></td>
                  <td style="text-align:center;">${icon('search',13)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  if(!registros.length){
    el.innerHTML = `<div class="section-gap">${stats}<div class="panel"><div class="empty-state">${icon('check',36)}<h3 style="margin-bottom:6px;">Nenhuma execução OSE registrada</h3><p>Quando as equipes responderem o RDO de OSE, os dados de execução aparecerão aqui.</p></div></div></div>`;
    return;
  }

  el.innerHTML = `<div class="section-gap">${stats}${filters}${tabela}</div>`;

  const fEq = document.getElementById('ose-rdo-f-equipe');
  const fSt = document.getElementById('ose-rdo-f-status');
  const fDe = document.getElementById('ose-rdo-f-de');
  const fAte = document.getElementById('ose-rdo-f-ate');
  const fBusca = document.getElementById('ose-rdo-f-busca');
  const norm = s=> String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const aplicar = ()=>{
    const q = norm(fBusca.value.trim());
    registros.forEach(x=>{
      const eq = findEquipe(x.atribuicao.equipeId);
      const okEq = !fEq.value || String(x.atribuicao.equipeId)===String(fEq.value);
      const okSt = !fSt.value || x.atribuicao.status===fSt.value;
      const data = x.atribuicao.dataProgramada||'';
      const okDe = !fDe.value || data >= fDe.value;
      const okAte = !fAte.value || data <= fAte.value;
      const hay = norm([
        oseProgLabel(x.programacao), x.programacao.municipio, x.programacao.subestacao,
        equipeLabel(eq), eq?.supervisor, data, x.atribuicao.status,
        rdoImpedimentos(x.atribuicao).join(' '),
        String(x.programacao.id), String(x.atribuicao.id)
      ].join(' '));
      const okBusca = !q || hay.indexOf(q)!==-1;
      const tr = document.querySelector(`tr[data-ose-prog="${x.programacao.id}"][data-ose-atrib="${x.atribuicao.id}"]`);
      if(tr) tr.style.display = (okEq&&okSt&&okDe&&okAte&&okBusca)? '' : 'none';
    });
  };
  fBusca.addEventListener('input', aplicar);
  document.getElementById('ose-rdo-f-busca-aplicar').addEventListener('click', aplicar);
  document.getElementById('ose-rdo-f-aplicar').addEventListener('click', aplicar);
  document.getElementById('ose-rdo-f-limpar').addEventListener('click', ()=>{
    fEq.value=''; fSt.value=''; fDe.value=''; fAte.value=''; fBusca.value=''; aplicar();
  });

  document.querySelectorAll('tr[data-ose-prog]').forEach(tr=>{
    tr.addEventListener('click', ()=> openOseRDOModal(Number(tr.dataset.oseProg), Number(tr.dataset.oseAtrib)));
  });

  document.getElementById('ose-rdo-export').addEventListener('click', ()=> exportRDOTipo(registros,'ose'));
  document.getElementById('ose-rdo-print').addEventListener('click', ()=> printRDOReportTipo(registros,'ose'));
}

function openOseRDOModal(progId, attribId){
  const x = flatOseAtribuicoes().find(y=> y.programacao.id===progId && y.atribuicao.id===attribId);
  if(!x) return;
  const eq = findEquipe(x.atribuicao.equipeId);
  const rdo = x.atribuicao.rdoRespostas||{};
  const res = rdoResumo(x);
  const imped = rdoImpedimentos(x.atribuicao);
  const horarios = RDO_HORARIOS.map(h=> `
    <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
    <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');

  const body = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div>
        <h4 style="margin-bottom:8px;">Programação ${oseProgLabel(x.programacao)}</h4>
        <p class="admin-field-meta" style="margin:2px 0;">Município: ${esc(x.programacao.municipio||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Subestação: ${esc(x.programacao.subestacao||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Tipo Intervenção: ${esc(x.programacao.tipoIntervencao||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Data: ${fmtDate(x.atribuicao.dataProgramada)}</p>
        <div style="margin-top:8px;">${rdoStatusBadge(x.atribuicao.status)}</div>
      </div>
      <div>
        <h4 style="margin-bottom:8px;">Equipe</h4>
        <p class="admin-field-meta" style="margin:2px 0;"><strong>${esc(equipeLabel(eq))}</strong></p>
        <p class="admin-field-meta" style="margin:2px 0;">Supervisor: ${esc(eq?.supervisor||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Encarregado: ${esc(eq?.encarregado||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Motorista: ${esc(eq?.motorista||'—')}</p>
      </div>
    </div>
    ${(x.programacao.anexos&&x.programacao.anexos.length)? `<div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Anexos do programador</h4>
      ${anexosDisplayHtml(x.programacao.anexos)}
    </div>`:''}
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Horários do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">${horarios}</table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">KM do Veículo</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_KM.map(h=> `
          <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
          <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('')}
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Condições do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_QUESTIONS.map(q=>`
          <tr><td style="font-weight:600;padding:3px 12px 3px 0;">${q.label}</td>
          <td style="padding:3px 10px;">${String(rdo[q.id]||'')||'—'}</td></tr>`).join('')}
      </table>
      ${imped.length? `<div style="margin-top:10px;">${imped.map(i=>`<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);margin-right:4px;">${esc(i)}</span>`).join('')}</div>`:''}
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Atividades e quantidades executadas</h4>
      <div style="display:flex;gap:14px;margin-bottom:12px;">
        <span class="badge-prefix">Prev. ${fmtNum(res.prev)}</span>
        <span class="badge-prefix alt">Exec. ${fmtNum(res.exec)}</span>
        <span class="badge-prefix" style="color:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};">${res.pct}%</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr><th style="text-align:left;padding:4px 6px;">#</th><th style="text-align:left;">Código</th><th style="text-align:left;">Descrição</th><th style="text-align:center;">Un.</th><th style="text-align:center;">Prev.</th><th style="text-align:center;">Exec.</th><th style="text-align:center;">%</th><th style="text-align:center;" title="Anomalias programadas → executadas">Anom.</th><th style="text-align:center;">Fotos</th></tr></thead>
        <tbody>
          ${(x.atribuicao.atividades||[]).map((a,idx)=>{
            const at = findAtividade(a.atividadeId);
            const p = parseFloat(a.quantidadePrevista)||0;
            const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
            const pct = p? Math.round((e||0)/p*100) : 0;
            const fotos = String(a.fotos||'').split(';;').filter(Boolean);
            return `<tr style="border-top:1px solid var(--border-soft);">
              <td style="padding:4px 6px;color:var(--muted-2);">${idx+1}</td>
              <td class="mono" style="padding:4px 6px;">${esc(at?.codigo||'?')}</td>
              <td style="padding:4px 6px;">${esc(at?.descricao||'')}</td>
              <td style="text-align:center;">${esc(at?.unidade||'')}</td>
              <td style="text-align:center;" class="mono">${p? fmtNum(p):'—'}</td>
              <td style="text-align:center;" class="mono"><strong>${e!=null? fmtNum(e):'—'}</strong></td>
              <td style="text-align:center;color:${pct>=100?'var(--green)':pct>=50?'var(--accent)':'var(--red)'};font-weight:700;">${p? pct+'%':'—'}</td>
              <td style="text-align:center;" class="mono">${esc(String(a.qtdAnomalia??'—')+' → '+String(a.qtdAnomaliaExecutada??'—'))}</td>
              <td style="text-align:center;">${fotos.length? `<div class="rdo-fotos" style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap;">${fotos.map(u=>`<img class="rdo-foto" src="${esc(u)}" alt="foto" title="Ampliar" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;">`).join('')}</div>`:'<span style="color:var(--muted-2);">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Observação da execução</h4>
      <p style="font-size:13px;">${esc(x.atribuicao.observacao)||'—'}</p>
    </div>
    <div class="admin-field-meta">Confirmado pela equipe em <strong>${rdoConfData(x)}</strong></div>`;

  openModal({ title:'RDO OSE — Detalhes da execução', bodyHtml: body, submitLabel:'Fechar', wide:true, footerBtns:[
    { label: icon('edit',14)+' Editar registro', cls:'btn', onClick: ()=> editRdoModal(x, oseProgLabel) },
    { label: icon('print',14)+' Gerar PDF', cls:'btn', onClick: ()=> printRDOTipoCompleto(x,'ose') }
  ] });
}

/* --- OSE Confirmação de Execução (bloqueante) --- */
function openOseConfirmacaoModal(prog, atrib, onResolved){
  const root = document.getElementById('modal-root');
  const eq = findEquipe(atrib.equipeId);

  function activitiesSummaryHtml(){
    return (atrib.atividades||[]).map(a=>{ const at=findAtividade(a.atividadeId); return `${esc(at?.codigo||'')} · ${esc(at?.descricao||'')} <span style="color:var(--muted-2);">(${a.quantidadePrevista??'-'} previsto)</span>`; }).join('<br>');
  }

  function renderStep(step){
    let inner='';
    if(step==='question'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Programação OSE vencida — equipe <strong>${equipeLabel(eq)}</strong> — data prevista ${fmtDate(atrib.dataProgramada)}</div>
          <div style="margin:10px 0;font-size:13px;line-height:1.7;">${activitiesSummaryHtml()}</div>
          <div class="confirm-question">A PROGRAMAÇÃO FOI EXECUTADA?</div>
        </div>
        <div class="modal-foot" style="justify-content:center;gap:14px;">
          <button type="button" class="btn btn-ghost" id="pc-visualizar">${icon('search',14)} VISUALIZAR</button>
          <button type="button" class="btn btn-danger-solid" id="pc-nao">NÃO</button>
          <button type="button" class="btn btn-primary" id="pc-sim">SIM</button>
        </div>`;
    } else if(step==='visualizar'){
      const detalheHtml = oseDetalheHtml(prog, atrib, false);
      inner = `
        <div class="modal-body">
          <div class="confirm-banner">${icon('alert',15)} Confira os dados e o retorno da equipe antes de responder.</div>
          ${detalheHtml}
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-visualizar">← Voltar à pergunta</button></div>`;
    } else if(step==='sim'){
      inner = `
        <div class="modal-body">
          <div style="font-size:12.5px;color:var(--muted);">Confirme as quantidades executadas por <strong>${equipeLabel(eq)}</strong>. Você pode manter os valores previstos ou editar antes de concluir.</div>
          ${(atrib.atividades||[]).map((a,idx)=>{ const at=findAtividade(a.atividadeId);
            return `<div class="field"><label>${esc(at?.codigo||'')} · ${esc(at?.descricao||'')}</label><input type="number" step="0.01" class="exec-qty" data-idx="${idx}" value="${a.quantidadeExecutada ?? a.quantidadePrevista ?? ''}"></div>`;
          }).join('')}
          <div class="field"><label>Motivo da conclusão <span class="req">*</span></label><input type="text" id="psim-motivo" maxlength="200" placeholder="Ex.: OSE executada conforme programado"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-sim">← Voltar</button><button type="button" class="btn btn-primary" id="pc-concluir">Manter/editar e concluir</button></div>`;
    } else if(step==='nao'){
      inner = `
        <div class="modal-body">
          <div class="field"><label>Motivo <span class="req">*</span></label><select id="pnao-motivo"><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Observações</label><textarea id="pnao-obs" placeholder="Detalhes sobre o não cumprimento"></textarea></div>
          <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" id="pnao-data" value="${atrib.dataProgramada}"></div>
        </div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" id="pc-back-nao">← Voltar</button><button type="button" class="btn btn-primary" id="pc-reprogramar">Reprogramar</button></div>`;
    }
    root.innerHTML = `<div class="modal-overlay" id="modal-overlay-conf"><div class="modal" style="${step==='visualizar'?'max-width:820px;':''}"><div class="modal-head"><h3>Confirmação de execução — OSE</h3></div>${inner}</div></div>`;
    bind(step);
  }
  function bind(step){
    if(step==='question'){
      document.getElementById('pc-visualizar').addEventListener('click', ()=>renderStep('visualizar'));
      document.getElementById('pc-sim').addEventListener('click', ()=>renderStep('sim'));
      document.getElementById('pc-nao').addEventListener('click', ()=>renderStep('nao'));
    } else if(step==='visualizar'){
      document.getElementById('pc-back-visualizar').addEventListener('click', ()=>renderStep('question'));
    } else if(step==='sim'){
      document.getElementById('pc-back-sim').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('pc-concluir').addEventListener('click', ()=>{
        const motivo = document.getElementById('psim-motivo').value.trim();
        if(!motivo){ toast('Informe o motivo da conclusão.', 'error'); return; }
        document.querySelectorAll('.exec-qty').forEach(inp=>{ atrib.atividades[Number(inp.dataset.idx)].quantidadeExecutada = parseFloat(inp.value)||0; });
        const de = atrib.status;
        atrib.status='Concluído';
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'confirmacao', de, para:'Concluído', motivo});
        registrarEvento('confirmacao','programacao',prog.id,oseProgLabel(prog),'Execução confirmada — '+motivo);
        saveData(); root.innerHTML=''; toast('Programação OSE concluída.'); renderContent(); onResolved && onResolved();
      });
    } else if(step==='nao'){
      document.getElementById('pc-back-nao').addEventListener('click', ()=>renderStep('question'));
      document.getElementById('pc-reprogramar').addEventListener('click', ()=>{
        const motivo = document.getElementById('pnao-motivo').value;
        const obs = document.getElementById('pnao-obs').value.trim();
        const novaData = document.getElementById('pnao-data').value;
        if(!motivo || !novaData){ toast('Preencha motivo e nova data.', 'error'); return; }
        const dataAntiga = atrib.dataProgramada;
        atrib.dataProgramada = novaData;
        atrib.status = 'Reprogramado';
        atrib.historico = atrib.historico||[];
        atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
        registrarEvento('reprogramacao','atribuicao',atrib.id,oseProgLabel(prog)+' · '+equipeLabel(findEquipe(atrib.equipeId)),fmtDate(dataAntiga)+' → '+fmtDate(novaData)+' · '+motivo+(obs? ' · '+obs:''));
        saveData(); root.innerHTML=''; toast('Programação OSE reprogramada.'); renderContent(); onResolved && onResolved();
      });
    }
  }
  renderStep('question');
}

/* --- Export OSE CSV --- */
function exportOseProgramacoesCSV(){
  exportCSV('ose_programacoes.csv',
    ['ID','Data','Município','Subestação','Tipo Intervenção','Status Doc.','Equipe','Atividades','Status','Observações'],
    oseProgramacoesVisiveis().map(p=>{
      const eq = findEquipe(p.equipeId);
      const ativs = (p.atividades||[]).map(a=>{ const at=findAtividade(a.atividadeId); return `${at?.codigo||'?'} ×${a.quantidadePrevista??'—'}`; }).join(', ');
      return [oseProgLabel(p), fmtDate(p.dataProgramacao), p.municipio||'', p.subestacao||'', p.tipoIntervencao||'', p.statusDocumentacao||'', equipeLabel(eq), ativs, p.status||'', p.observacoes||''];
    }));
}
function renderOsePoda(){ setView('ose-programacoes'); }
function renderOse(){ setView('ose-programacoes'); }
function renderPoda(){ setView('poda-programacoes'); }

/* --- Poda helpers --- */
const STATUS_DOC_OPCOES = ['Confirmado','Em elaboração','Elaborado','Validado'];
const TIPO_REDE_OPCOES = ['MT','BT'];
const STATUS_PODA = ['Programado','Em Execução','Concluído','Reprogramado','Cancelado'];
let podaFilters = (()=>{ const r=monthRangeISO(); return { busca:'', equipe:'', status:'', dataDe:r.de, dataAte:r.ate, modo:'lista', calView:'mes', calDay:todayISO() }; })();
let podaCalRef = new Date();
function podaProgLabel(p){ return p.gid || ('PODA-'+String(p.id).padStart(7,'0')); }
function findPodaProg(id){ return (DB.podaProgramacoes||[]).find(p=>p.id===Number(id)); }
function podaProgramacoesVisiveis(){
  const all = DB.podaProgramacoes||[];
  if(!usuarioRestrito()) return all;
  const eqIds = new Set(equipesVisiveis().map(e=>String(e.id)));
  return all.filter(pg=> (pg.atribuicoes||[]).some(a=> eqIds.has(String(a.equipeId))));
}
function flatPodaAtribuicoes(){
  const out=[];
  (DB.podaProgramacoes||[]).forEach(pg=>{ (pg.atribuicoes||[]).forEach(at=> out.push({ programacao: pg, atribuicao: at })); });
  return out;
}
function podaAtribGlobal(atribId){
  for(const pg of (DB.podaProgramacoes||[])){ const f=(pg.atribuicoes||[]).find(a=>a.id===Number(atribId)); if(f) return {programacao:pg,atribuicao:f}; }
  return null;
}
function podaProgDaAtrib(atribId){
  return (DB.podaProgramacoes||[]).find(pg=> (pg.atribuicoes||[]).some(a=>a.id===Number(atribId)));
}
function podaProgramacoesFiltradas(){
  const norm = s=> String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const q = norm(podaFilters.busca);
  const st = podaFilters.status;
  const eqId = podaFilters.equipe;
  const de = podaFilters.dataDe;
  const ate = podaFilters.dataAte;
  return flatPodaAtribuicoes().filter(x=>{
    const p = x.programacao, a = x.atribuicao;
    const eq = findEquipe(a.equipeId);
    if(st && a.status!==st) return false;
    if(eqId && String(a.equipeId)!==String(eqId)) return false;
    if(de && (a.dataProgramada||p.dataProgramacao||'') < de) return false;
    if(ate && (a.dataProgramada||p.dataProgramacao||'') > ate) return false;
    if(q){
      const hay = norm([p.osi,p.subestacao,p.tipoRede,p.chave,p.status,p.statusDocumentacao,podaProgLabel(p),equipeLabel(eq),eq?.supervisor,fmtDate(a.dataProgramada||p.dataProgramacao),p.observacoes].join(' '));
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}
function podaPedirMotivoStatus(atribId, novoStatus, onOk){
  if(!requerEscrita()) return;
  const r = podaAtribGlobal(atribId);
  if(!r || r.atribuicao.status===novoStatus) return;
  const de = r.atribuicao.status;
  const eq = findEquipe(r.atribuicao.equipeId);
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:12px;">Alterar status de <strong>${de}</strong> para <strong>${novoStatus}</strong>${eq? ' — '+esc(equipeLabel(eq)):''}</div>
    <div class="field"><label>Motivo <span class="req">*</span></label><input type="text" name="motivo" required maxlength="200" placeholder="Descreva o motivo desta alteração de status"></div>
    <div class="field"><label>Observações</label><textarea name="obs" rows="2" placeholder="Detalhes opcionais"></textarea></div>`;
  openModal({
    title:'Motivo da alteração de status', bodyHtml: body, submitLabel:'Alterar status',
    onSubmit:(fd)=>{
      const motivo = String(fd.get('motivo')||'').trim();
      const obs = String(fd.get('obs')||'').trim();
      if(!motivo){ toast('Informe o motivo da alteração.', 'error'); return false; }
      r.atribuicao.status = novoStatus;
      r.atribuicao.historico = r.atribuicao.historico||[];
      r.atribuicao.historico.push({...currentAutor(), ts:Date.now(), tipo:'status', de, para:novoStatus, motivo, obs: obs||null});
      registrarEvento('status','atribuicao',r.atribuicao.id, podaProgLabel(r.programacao)+' · '+equipeLabel(findEquipe(r.atribuicao.equipeId)), de+' → '+novoStatus+' · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); renderBanner(); toast('Status alterado para '+novoStatus+'.');
      onOk && onOk();
    }
  });
}
function openPodaReprogramarConfirmacao(atribId, novaDataPrefill){
  if(!requerEscrita()) return;
  const r = podaAtribGlobal(atribId);
  if(!r) return;
  const atrib = r.atribuicao;
  if(['Concluído','Cancelado'].includes(atrib.status)){ toast('Não é possível reprogramar um item concluído ou cancelado.', 'error'); return; }
  const eq = findEquipe(atrib.equipeId);
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:4px;">Equipe ${equipeLabel(eq)}</div>
    <div class="field"><label>Data atual</label><input type="text" value="${fmtDate(atrib.dataProgramada)}" disabled></div>
    <div class="field"><label>Nova data <span class="req">*</span></label><input type="date" name="novaData" required value="${novaDataPrefill||atrib.dataProgramada}"></div>
    <div class="field"><label>Motivo da reprogramação <span class="req">*</span></label><select name="motivo" required><option value="">Selecione…</option>${MOTIVOS_REPROG.map(m=>`<option>${m}</option>`).join('')}</select></div>
    <div class="field"><label>Observações <span class="req">*</span></label><textarea name="obs" required placeholder="Descreva o motivo e as observações da reprogramação"></textarea></div>`;
  openModal({
    title:'Reprogramar programação de poda', bodyHtml: body, submitLabel:'Confirmar reprogramação',
    onSubmit:(fd)=>{
      const novaData = fd.get('novaData'); const motivo = fd.get('motivo'); const obs = fd.get('obs').trim();
      if(!motivo){ toast('Selecione o motivo da reprogramação.', 'error'); return false; }
      if(!obs){ toast('Informe a observação da reprogramação.', 'error'); return false; }
      const dataAntiga = atrib.dataProgramada;
      atrib.dataProgramada = novaData; atrib.status = 'Reprogramado';
      atrib.historico = atrib.historico||[];
      atrib.historico.push({...currentAutor(), ts:Date.now(), tipo:'reprogramacao', de:dataAntiga, para:novaData, motivo, obs});
      registrarEvento('reprogramacao','atribuicao',atrib.id, podaProgLabel(r.programacao)+' · '+equipeLabel(findEquipe(atrib.equipeId)), fmtDate(dataAntiga)+' → '+fmtDate(novaData)+' · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); renderBanner(); toast('Programação reprogramada.');
    }
  });
}

/* --- renderPodaProgramacoes --- */
function renderPodaProgramacoes(){
  const el = document.getElementById('content');
  if(!DB.equipes.length){
    el.innerHTML = emptyState('Cadastre equipes primeiro', 'A programação de poda requer ao menos uma equipe.');
    return;
  }
  const list = podaProgramacoesFiltradas();
  el.innerHTML = `
    <div class="panel-head" style="padding:0;margin-bottom:16px;border:none;">
      <div class="filters">
        <input type="search" id="poda-f-busca" placeholder="Buscar OSI, subestação, equipe..." style="flex:1;min-width:180px;" value="${esc(podaFilters.busca)}">
        <select id="poda-f-equipe"><option value="">Todas as equipes</option>${equipesVisiveis().filter(e=>e.ativo!==false).map(e=>`<option value="${e.id}" ${podaFilters.equipe==String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' — '+esc(e.encarregado):''}</option>`).join('')}</select>
        <select id="poda-f-status"><option value="">Todos os status</option>${STATUS_PODA.map(s=>`<option ${podaFilters.status===s?'selected':''}>${s}</option>`).join('')}</select>
        <input type="date" id="poda-f-de" value="${podaFilters.dataDe}" title="Data inicial">
        <span style="color:var(--muted);font-size:12px;">até</span>
        <input type="date" id="poda-f-ate" value="${podaFilters.dataAte}" title="Data final">
        <button class="btn btn-sm" id="poda-f-mes-atual" title="Filtrar pelo mês vigente">${icon('calendar',12)} Mês atual</button>
        <button class="btn btn-sm btn-ghost" id="poda-f-limpar" title="Limpar filtros">Limpar</button>
      </div>
      <div class="tabs">
        <button class="tab ${podaFilters.modo==='lista'?'active':''}" data-modo="lista">Lista</button>
        <button class="tab ${podaFilters.modo==='fluxo'?'active':''}" data-modo="fluxo">Fluxo</button>
        <button class="tab ${podaFilters.modo==='calendario'?'active':''}" data-modo="calendario">Calendário</button>
      </div>
    </div>
    <div id="poda-area"></div>`;
  document.getElementById('poda-f-busca').addEventListener('input', e=>{ podaFilters.busca=e.target.value; renderContent(); });
  document.getElementById('poda-f-equipe').addEventListener('change', e=>{ podaFilters.equipe=e.target.value; renderContent(); });
  document.getElementById('poda-f-status').addEventListener('change', e=>{ podaFilters.status=e.target.value; renderContent(); });
  document.getElementById('poda-f-de').addEventListener('change', e=>{ podaFilters.dataDe=e.target.value; renderContent(); });
  document.getElementById('poda-f-ate').addEventListener('change', e=>{ podaFilters.dataAte=e.target.value; renderContent(); });
  document.getElementById('poda-f-mes-atual').addEventListener('click', ()=>{ const r=monthRangeISO(); podaFilters.dataDe=r.de; podaFilters.dataAte=r.ate; renderContent(); });
  document.getElementById('poda-f-limpar').addEventListener('click', ()=>{ podaFilters.busca=''; podaFilters.equipe=''; podaFilters.status=''; podaFilters.dataDe=''; podaFilters.dataAte=''; renderContent(); });
  el.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>{podaFilters.modo=t.dataset.modo; renderContent();}));

  const area = document.getElementById('poda-area');
  if(podaFilters.modo==='calendario'){ renderPodaCalendarioInto(area, list); return; }
  if(!list.length){
    area.innerHTML = flatPodaAtribuicoes().length
      ? emptyState('Nenhuma programação encontrada', 'Ajuste os filtros para ver as programações.')
      : emptyState('Nenhuma programação de poda', 'Clique em "Nova programação" para criar a primeira.');
    return;
  }
  if(podaFilters.modo==='lista') renderPodaListaInto(area, list); else renderPodaFluxoInto(area, list);
}

function renderPodaListaInto(area, list){
  area.innerHTML = `<div class="panel"><div class="table-scroll"><table>
    <thead><tr><th>ID</th><th>Data</th><th>OSI</th><th>Subestação</th><th>Tipo</th><th>Equipe</th><th>Status Doc.</th><th>Atividades</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(x=>{
      const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
      const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
      const ativResumo = (a.atividades||[]).map(at=>{ const atd=findAtividade(at.atividadeId); return `${esc(atd?.codigo||'?')} ×${at.quantidadePrevista??'—'}`; }).join(', ');
      return `<tr style="cursor:pointer;" data-poda-open="${a.id}">
        <td class="mono" style="white-space:nowrap;">${podaProgLabel(p)}</td>
        <td class="mono">${fmtDate(a.dataProgramada)} ${late?'<div class="late-flag">VENCIDA</div>':''}</td>
        <td>${esc(p.osi||'—')}</td>
        <td>${esc(p.subestacao||'—')}</td>
        <td><span class="badge" style="color:${p.tipoRede==='MT'?'var(--blue)':'var(--accent)'};background:${p.tipoRede==='MT'?'rgba(78,140,235,.14)':'rgba(224,164,88,.14)'};">${esc(p.tipoRede||'—')}</span></td>
        <td><span class="badge-prefix">${eqtlLabel(eq)}</span></td>
        <td><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(p.statusDocumentacao||'—')}</span></td>
        <td style="font-size:12px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ativResumo||'—'}</td>
        <td>${statusBadge(a.status, late)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" title="WhatsApp" data-poda-whats="${p.id}">${icon('whatsapp',14)}</button>
          <button class="icon-btn" title="Documento" data-poda-doc="${p.id}">${icon('print',14)}</button>
          <button class="icon-btn" title="Histórico" data-poda-hist="${a.id}">${icon('history',14)}</button>
          <button class="icon-btn" title="Reprogramar" data-poda-reprog="${a.id}">${icon('reprog',14)}</button>
          <button class="icon-btn" title="Editar" data-poda-edit="${p.id}">${icon('edit',14)}</button>
          <button class="icon-btn" title="Excluir" data-poda-del="${p.id}">${icon('trash',14)}</button>
        </div></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
  bindPodaRowActions(area);
}

function bindPodaRowActions(area){
  area.querySelectorAll('[data-poda-open]').forEach(c=>c.addEventListener('click', (e)=>{ if(e.target.closest('.row-actions')) return; openPodaDetalhe(c.dataset.podaOpen); }));
  area.querySelectorAll('[data-poda-whats]').forEach(b=>b.addEventListener('click', ()=>encaminharPodaWhats(b.dataset.podaWhats)));
  area.querySelectorAll('[data-poda-doc]').forEach(b=>b.addEventListener('click', ()=>openPodaDocProgramacao(b.dataset.podaDoc)));
  area.querySelectorAll('[data-poda-hist]').forEach(b=>b.addEventListener('click', ()=>openPodaHistoricoModal(b.dataset.podaHist)));
  area.querySelectorAll('[data-poda-reprog]').forEach(b=>b.addEventListener('click', ()=>openPodaReprogramarConfirmacao(b.dataset.podaReprog)));
  area.querySelectorAll('[data-poda-edit]').forEach(b=>b.addEventListener('click', ()=>openPodaProgramacaoModal(Number(b.dataset.podaEdit))));
  area.querySelectorAll('[data-poda-del]').forEach(b=>b.addEventListener('click', ()=>{
    const p = findPodaProg(Number(b.dataset.podaDel));
    if(!p) return;
    if(!confirm('Excluir a programação de poda '+podaProgLabel(p)+'?')) return;
    registrarEvento('exclusao','programacao',p.id,podaProgLabel(p),'Programação de poda excluída');
    DB.podaProgramacoes = DB.podaProgramacoes.filter(x=>x.id!==p.id);
    saveData(); renderContent(); toast('Programação excluída.');
  }));
}

/* --- Poda Kanban (Fluxo) --- */
function renderPodaFluxoInto(area, list){
  const cols = STATUS_PODA.map(status=>{
    const items = list.filter(x=>x.atribuicao.status===status);
    const c = STATUS_COLOR[status]||'var(--muted)';
    return `<div class="kanban-col" style="--col-c:${c}" data-drop-status="${status}">
      <div class="kanban-col-head"><h4>${status}</h4><span class="count">${items.length}</span></div>
      <div class="kanban-cards">${items.map(x=>{
        const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
        const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
        return `<div class="kcard ${late?'pending':''}" draggable="true" data-atrib="${a.id}" data-open-poda="${a.id}">
          <div class="kc-code ${late?'late-blink late':''}">${late?'VENCIDA · ':''}${equipeLabel(eq)}</div>
          <div class="kc-title">${esc(p.osi||'—')} · ${esc(p.subestacao||'—')}</div>
          <div class="kc-meta"><span>${esc(p.tipoRede||'—')} · ${esc(p.statusDocumentacao||'—')}</span><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);font-size:10px;">${esc(p.chave||'')}</span></div>
          <div class="kc-meta"><span>${fmtDate(a.dataProgramada)}</span><span class="mono" style="color:var(--accent);">${podaProgLabel(p)}</span></div>
        </div>`;
      }).join('') || `<div style="padding:14px;color:var(--muted-2);font-size:11.5px;">Vazio</div>`}</div>
    </div>`;
  }).join('');
  area.innerHTML = renderPodaKanbanStrip() + `<div class="kanban">${cols}</div>`;
  bindPodaKanbanDrag(area);
}

function renderPodaKanbanStrip(){
  const days = [];
  const start = todayISO();
  for(let i=0;i<28;i++) days.push(shiftISO(start, i));
  return `<div class="kanban-strip">
    <div class="ks-title">${icon('reprog',13)} <strong>Reprogramar arrastando:</strong> arraste um card sobre uma data para reprogramar.</div>
    <div class="ks-days">${days.map(iso=>{
      const d = new Date(iso+'T12:00:00');
      const dow = d.toLocaleDateString('pt-BR',{weekday:'short'}).replace('.','');
      return `<div class="ks-day ${iso===todayISO()?'today':''}" data-date="${iso}" title="Reprogramar para ${fmtDate(iso)}"><span class="ks-dow">${dow}</span><span class="ks-num">${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}</span></div>`;
    }).join('')}</div>
  </div>`;
}

function bindPodaKanbanDrag(area){
  let dragId = null;
  area.querySelectorAll('.kcard[draggable]').forEach(card=>{
    card.addEventListener('dragstart', e=>{
      dragId = card.dataset.atrib; card.classList.add('dragging');
      try{ e.dataTransfer.setData('text/plain', String(card.dataset.atrib)); e.dataTransfer.effectAllowed='move'; }catch(err){}
    });
    card.addEventListener('dragend', ()=>{ card.classList.remove('dragging'); });
  });
  area.querySelectorAll('.kanban-col').forEach(col=>{
    col.addEventListener('dragover', e=>{ e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', ()=>{ col.classList.remove('drag-over'); });
    col.addEventListener('drop', e=>{
      e.preventDefault(); col.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) podaPedirMotivoStatus(id, col.dataset.dropStatus);
    });
  });
  area.querySelectorAll('.ks-day').forEach(day=>{
    day.addEventListener('dragover', e=>{ e.preventDefault(); day.classList.add('drag-over'); });
    day.addEventListener('dragleave', ()=>{ day.classList.remove('drag-over'); });
    day.addEventListener('drop', e=>{
      e.preventDefault(); day.classList.remove('drag-over');
      const id = Number(e.dataTransfer?.getData('text/plain') || dragId);
      if(id) openPodaReprogramarConfirmacao(id, day.dataset.date);
    });
  });
  area.querySelectorAll('[data-open-poda]').forEach(c=>c.addEventListener('click', ()=>openPodaDetalhe(c.dataset.openPoda)));
}

/* --- Poda Calendário --- */
function renderPodaCalendarioInto(area, list){
  const subTabs = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
      <div class="tabs">
        <button class="tab ${podaFilters.calView==='mes'?'active':''}" data-cal-view="mes">Mês (externa)</button>
        <button class="tab ${podaFilters.calView==='dia'?'active':''}" data-cal-view="dia">Dia (interna)</button>
      </div>
      ${podaFilters.calView==='dia'? `<div style="display:flex;align-items:center;gap:8px;">
        <button class="icon-btn" id="poda-day-prev">${icon('chevL',16)}</button>
        <span class="mono" style="color:var(--text);font-weight:700;">${fmtDate(podaFilters.calDay)}</span>
        <button class="icon-btn" id="poda-day-next">${icon('chevR',16)}</button>
      </div>`:''}
      <span style="font-size:12px;color:var(--muted);">${list.length} programação(ões)</span>
    </div>`;
  const bindCalTabs = ()=>{
    area.querySelectorAll('.tab[data-cal-view]').forEach(b=>b.addEventListener('click', ()=>{ podaFilters.calView=b.dataset.calView; renderContent(); }));
  };
  if(podaFilters.calView==='dia'){
    const dayList = list.filter(x=>(x.atribuicao.dataProgramada||x.programacao.dataProgramacao)===podaFilters.calDay);
    area.innerHTML = subTabs + (dayList.length? renderPodaDayList(dayList) : `<div class="panel"><div class="empty-state">${icon('empty',34)}<p>Nenhuma programação em ${fmtDate(podaFilters.calDay)}.</p></div></div>`);
    bindCalTabs();
    const pv=area.querySelector('#poda-day-prev'), nx=area.querySelector('#poda-day-next');
    if(pv) pv.addEventListener('click', ()=>{ podaFilters.calDay=shiftISO(podaFilters.calDay,-1); renderContent(); });
    if(nx) nx.addEventListener('click', ()=>{ podaFilters.calDay=shiftISO(podaFilters.calDay,1); renderContent(); });
    area.querySelectorAll('[data-open-poda]').forEach(c=>c.addEventListener('click', ()=>openPodaDetalhe(c.dataset.openPoda)));
    area.querySelectorAll('[data-poda-doc]').forEach(c=>c.addEventListener('click', ()=>openPodaDocProgramacao(c.dataset.podaDoc)));
    return;
  }
  const year = podaCalRef.getFullYear(), month = podaCalRef.getMonth();
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const monthName = podaCalRef.toLocaleDateString('pt-BR', {month:'long', year:'numeric'});
  const byDate = {};
  list.forEach(x=>{
    const d = x.atribuicao.dataProgramada||x.programacao.dataProgramacao;
    (byDate[d] = byDate[d]||[]).push(x);
  });
  let cells = '';
  for(let i=0;i<startDow;i++) cells += `<div class="cal-cell out"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const iso = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const items = byDate[iso]||[];
    const isToday = iso===todayISO();
    cells += `<div class="cal-cell ${isToday?'today':''}">
      <div class="cal-daynum" data-day-view="${iso}" style="cursor:pointer;" title="Ver dia">${d} ${items.length?`<span style="color:var(--accent);">· ${items.length}</span>`:''}</div>
      ${items.slice(0,3).map(x=>{
        const eq=findEquipe(x.atribuicao.equipeId); const late=x.atribuicao.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(x.atribuicao.status); const c=STATUS_COLOR[x.atribuicao.status]||'var(--muted)';
        return `<div class="cal-chip ${late?'late-blink late':''}" style="color:${late?'var(--purple)':c};border-color:${late?'rgba(180,140,224,.5)':'var(--border)'}" data-open-poda="${x.atribuicao.id}">${equipeLabel(eq)}</div>`;
      }).join('')}
      ${items.length>3? `<div style="font-size:10px;color:var(--accent);cursor:pointer;" data-day-view="${iso}">+${items.length-3} mais</div>`:''}
    </div>`;
  }
  const dows = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  area.innerHTML = `
    ${subTabs}
    <div class="panel" style="padding:16px;">
      <div class="cal-nav">
        <button class="icon-btn" id="poda-cal-prev">${icon('chevL',16)}</button>
        <h3 style="text-transform:capitalize;">${monthName}</h3>
        <button class="icon-btn" id="poda-cal-next">${icon('chevR',16)}</button>
      </div>
      <div class="cal-grid">${dows.map(d=>`<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
    </div>`;
  bindCalTabs();
  document.getElementById('poda-cal-prev').addEventListener('click', ()=>{ podaCalRef = new Date(year, month-1, 1); renderContent(); });
  document.getElementById('poda-cal-next').addEventListener('click', ()=>{ podaCalRef = new Date(year, month+1, 1); renderContent(); });
  area.querySelectorAll('[data-day-view]').forEach(c=>c.addEventListener('click', ()=>{ podaFilters.calDay=c.dataset.dayView; podaFilters.calView='dia'; renderContent(); }));
  area.querySelectorAll('[data-open-poda]').forEach(c=>c.addEventListener('click', ()=>openPodaDetalhe(c.dataset.openPoda)));
}

function renderPodaDayList(dayList){
  return `<div style="display:flex;flex-direction:column;gap:14px;">${dayList.map(x=>{
    const p=x.programacao, a=x.atribuicao, eq=findEquipe(a.equipeId);
    const late = a.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(a.status);
    const ativResumo = (a.atividades||[]).map(at=>{ const atd=findAtividade(at.atividadeId); return `${esc(atd?.codigo||'?')} ×${at.quantidadePrevista??'—'}`; }).join(', ');
    return `<div class="panel">
      <div class="panel-head">
        <div><h3>${esc(p.osi||'—')} · ${esc(p.subestacao||'—')}</h3><div class="admin-field-meta">${podaProgLabel(p)} · ${equipeLabel(eq)} · ${fmtDate(a.dataProgramada)}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${statusBadge(a.status, late)}</div>
      </div>
      <div style="padding:12px 16px;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${ativResumo||'Sem atividades'}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn btn-sm" data-poda-doc="${p.id}">${icon('print',13)} Imprimir</button>
          <button class="btn btn-sm" data-open-poda="${a.id}">${icon('calendar',13)} Ver detalhe</button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* --- Poda Detalhe Modal --- */
function podaDetalheHtml(programacao, atrib, comAcoes=true){
  const eq = findEquipe(atrib.equipeId);
  const late = atrib.dataProgramada < todayISO() && !['Concluído','Cancelado'].includes(atrib.status);
  const rows = (atrib.atividades||[]).map(a=>{
    const at = findAtividade(a.atividadeId);
    return { at, prev: a.quantidadePrevista||0, exec: a.quantidadeExecutada!=null? a.quantidadeExecutada : null };
  });
  return `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="dtl-header">
        <div style="min-width:0;">
          <div class="dtl-code">${esc(programacao.osi||'—')} · ${esc(programacao.subestacao||'—')} · ${esc(programacao.tipoRede||'')}</div>
          <div class="dtl-title">${podaProgLabel(programacao)}</div>
          <div class="dtl-meta"><span>${icon('hash',12)} ${esc(programacao.chave||'—')}</span><span>${icon('calendar',12)} ${fmtDate(atrib.dataProgramada)}</span><span>${icon('trend',12)} OSI ${esc(programacao.asi||'—')}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${statusBadge(atrib.status, late)}</div>
      </div>

      <div class="dtl-grid">
        <div class="dtl-tile"><div class="dtl-tile-lbl">Equipe</div><div class="dtl-tile-val"><span class="badge-prefix">${equipeLabel(eq)}</span></div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Data programada</div><div class="dtl-tile-val mono">${fmtDate(atrib.dataProgramada)}</div>${late? `<div class="late-flag" style="font-size:11px;margin-top:4px;">VENCIDA</div>`:''}</div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Encarregado</div><div class="dtl-tile-val">${esc(eq?.encarregado||'—')}</div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Status</div><div class="dtl-tile-val">${statusBadge(atrib.status, late)}</div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Status Doc.</div><div class="dtl-tile-val"><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(programacao.statusDocumentacao||'—')}</span></div></div>
        <div class="dtl-tile"><div class="dtl-tile-lbl">Tipo Rede</div><div class="dtl-tile-val"><span class="badge" style="color:${programacao.tipoRede==='MT'?'var(--blue)':'var(--accent)'};background:${programacao.tipoRede==='MT'?'rgba(78,140,235,.14)':'rgba(224,164,88,.14)'};">${esc(programacao.tipoRede||'—')}</span></div></div>
        <div class="dtl-tile" style="grid-column:1/-1;"><div class="dtl-tile-lbl">Local de execução</div><div class="dtl-tile-val">${programacao.local? esc(programacao.local) : '—'}</div>${(programacao.local||programacao.localLat!=null)? `<div style="margin-top:4px;font-size:11.5px;"><a href="${esc(localMapsHref(programacao.local,programacao.localLat,programacao.localLng))}" target="_blank" rel="noopener" style="color:var(--blue);font-weight:600;">${icon('pin',11)} Abrir no Google Maps</a></div>`:''}</div>
      </div>

      <div class="dtl-section">
        <div class="dtl-section-head"><h4>Atividades</h4></div>
        <div class="table-scroll"><table class="min">
          <thead><tr><th>Código</th><th>Descrição</th><th>Un.</th><th>Prev.</th><th>Exec.</th></tr></thead>
          <tbody>${rows.map(r=>`<tr>
            <td class="mono" style="color:var(--accent);font-weight:700;">${esc(r.at?.codigo||'?')}</td>
            <td>${esc(r.at?.descricao||'')}</td><td>${esc(r.at?.unidade||'')}</td>
            <td class="mono">${r.prev||'—'}</td>
            <td class="mono">${r.exec!=null? r.exec:'—'}</td>
          </tr>`).join('')}
          </tbody>
        </table></div>
      </div>

      ${String(programacao.observacoes||'').trim()? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Observações</h4></div>
        <div style="white-space:pre-wrap;line-height:1.55;padding:12px;">${esc(programacao.observacoes)}</div>
      </div>`:''}

      ${(programacao.anexos&&programacao.anexos.length)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Anexos do programador</h4><span class="mono">${programacao.anexos.length} imagem(ns)</span></div>
        ${anexosDisplayHtml(programacao.anexos)}
      </div>`:''}

      ${(programacao.localLat!=null && programacao.localLng!=null)? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Localização no mapa</h4></div>
        <div style="padding:12px;"><a href="${esc(staticMapUrl(programacao.localLat,programacao.localLng,16,800,450))}" target="_blank" rel="noopener">${localThumbHtml(programacao.local,programacao.localLat,programacao.localLng)}</a></div>
      </div>`:''}

      ${String(programacao.orientacoesPlanejamento||'').trim()? `<div class="dtl-section">
        <div class="dtl-section-head"><h4>Orientações do Setor de Planejamento</h4></div>
        <div style="white-space:pre-wrap;line-height:1.55;">${esc(programacao.orientacoesPlanejamento)}</div>
      </div>`:''}

      ${comAcoes? `<div class="dtl-actions">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="dtl-actions-lbl">Alterar status:</span>
          ${STATUS_PODA.filter(s=>s!==atrib.status).map(s=>`<button type="button" class="btn btn-sm" data-set-poda-status="${s}">→ ${s}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm" data-whats-poda="${programacao.id}">${icon('whatsapp',13)} WhatsApp</button>
          <button type="button" class="btn btn-sm" data-edit-poda="${programacao.id}">${icon('edit',13)} Editar</button>
          <button type="button" class="btn btn-sm" data-doc-poda="${programacao.id}">${icon('print',13)} Documento</button>
          <button type="button" class="btn btn-sm" data-reprog-poda="${atrib.id}">${icon('reprog',13)} Reprogramar</button>
          <button type="button" class="btn btn-sm" data-hist-poda="${atrib.id}">${icon('history',13)} Histórico</button>
        </div>
      </div>`:''}
    </div>`;
}

function openPodaDetalhe(atribId){
  const r = podaAtribGlobal(Number(atribId));
  if(!r) return;
  const body = podaDetalheHtml(r.programacao, r.atribuicao);
  openModal({ title:'Detalhe da programação de poda', bodyHtml: body, submitLabel:'Fechar', wide:true,
    onMount:(root)=>{
      root.querySelectorAll('[data-set-poda-status]').forEach(b=>b.addEventListener('click', ()=>{
        if(!requerEscrita()) return;
        podaPedirMotivoStatus(r.atribuicao.id, b.dataset.setPodaStatus);
      }));
      root.querySelectorAll('[data-whats-poda]').forEach(b=>b.addEventListener('click', ()=>encaminharPodaWhats(b.dataset.whatsPoda)));
      root.querySelectorAll('[data-edit-poda]').forEach(b=>b.addEventListener('click', ()=>{
        document.getElementById('modal-root').innerHTML='';
        openPodaProgramacaoModal(Number(b.dataset.editPoda));
      }));
      root.querySelectorAll('[data-doc-poda]').forEach(b=>b.addEventListener('click', ()=>openPodaDocProgramacao(b.dataset.docPoda)));
      root.querySelectorAll('[data-reprog-poda]').forEach(b=>b.addEventListener('click', ()=>openPodaReprogramarConfirmacao(b.dataset.reprogPoda)));
      root.querySelectorAll('[data-hist-poda]').forEach(b=>b.addEventListener('click', ()=>openPodaHistoricoModal(b.dataset.histPoda)));
    },
    onSubmit:()=>true
  });
}

/* --- Poda WhatsApp --- */
function buildPodaWhatsMessage(prog, atrib){
  const eq = findEquipe(atrib.equipeId);
  const ativs = (atrib.atividades||[]).map((a,i)=>{
    const at = findAtividade(a.atividadeId);
    return `${i+1}. *${at?.codigo||'?'}* · ${at?.descricao||''} — ${a.quantidadePrevista??'—'} ${at?.unidade||''}`;
  }).join('\n');
  return [
    `*G26 New · Programação de PODA*`,
    ``,
    `*Programação:* ${podaProgLabel(prog)}`,
    `*OSI:* ${prog.osi||'—'}  ·  *Subestação:* ${prog.subestacao||'—'}`,
    `*Tipo Rede:* ${prog.tipoRede||'—'}  ·  *Chave:* ${prog.chave||'—'}`,
    `*Data:* ${fmtDate(atrib.dataProgramada)}`,
    `*Equipe:* ${equipeLabel(eq)}`,
    ``,
    ...localWhatsLine(prog.local, prog.localLat, prog.localLng),
    ``,
    `*Atividades programadas:*`,
    ativs||'—',
    ``,
    `*Supervisor:* ${eq?.supervisor||'—'}`,
    `*Encarregado:* ${eq?.encarregado||'—'}  ·  *Motorista:* ${eq?.motorista||'—'}`,
    ``,
    `*Acesso da equipe (QR):*`,
    equipePageUrlPoda(prog.id, atrib.equipeId),
    ``,
    `_Caso tenha problemas técnicos, entre em contato:_`,
    `https://wa.me/${WHATS_SUPORTE}`
  ].join('\n');
}

function encaminharPodaWhats(progId){
  const prog = findPodaProg(Number(progId));
  if(!prog) return;
  const teams = (prog.atribuicoes||[]).filter(a=>a.status!=='Cancelado');
  if(!teams.length) return;
  if(teams.length===1){
    const atrib = teams[0];
    const eq = findEquipe(atrib.equipeId);
    if(!eq?.whatsapp || !phoneDigits(eq.whatsapp)){ toast('Sem WhatsApp cadastrado para: '+equipeLabel(eq)+'. Edite a equipe e informe o número.', 'error'); return; }
    window.open(waLink(eq.whatsapp, buildPodaWhatsMessage(prog, atrib)), '_blank');
    toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
    registrarEvento('compartilhamento','programacao',prog.id,podaProgLabel(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
    return;
  }
  const body = teams.map(atrib=>{
    const eq = findEquipe(atrib.equipeId);
    const temWhats = eq?.whatsapp && phoneDigits(eq.whatsapp);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div>
        <div style="font-weight:600;font-size:13px;">${esc(equipeLabel(eq))}</div>
        <div style="font-size:11px;color:var(--muted-2);">${temWhats? esc(eq.whatsapp) : 'Sem WhatsApp cadastrado'}</div>
      </div>
      <button type="button" class="btn btn-sm${temWhats?' btn-primary':' btn-ghost'}" ${temWhats?`data-wa-poda-send="${atrib.equipeId}"`:'disabled'} style="white-space:nowrap;">${icon('whatsapp',13)} Enviar</button>
    </div>`;
  }).join('');
  openModal({
    title: 'Encaminhar para equipe(s)',
    bodyHtml: `<div style="margin-bottom:8px;font-size:12px;color:var(--muted);">Selecione a equipe para enviar a programação de PODA via WhatsApp.</div>${body}`,
    submitLabel: 'Enviar para todas',
    onSubmit: ()=>{
      teams.forEach(atrib=>{
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildPodaWhatsMessage(prog, atrib)), '_blank');
        }
      });
      toast(teams.length+' mensagem(ns) encaminhada(s).');
      registrarEvento('compartilhamento','programacao',prog.id,podaProgLabel(prog), 'Encaminhado via WhatsApp para '+teams.length+' equipe(s)');
      return true;
    },
    onMount: (root)=>{
      root.querySelectorAll('[data-wa-poda-send]').forEach(b=>b.addEventListener('click', ()=>{
        const eqId = Number(b.dataset.waPodaSend);
        const atrib = teams.find(a=>a.equipeId===eqId);
        if(!atrib) return;
        const eq = findEquipe(atrib.equipeId);
        if(eq?.whatsapp && phoneDigits(eq.whatsapp)){
          window.open(waLink(eq.whatsapp, buildPodaWhatsMessage(prog, atrib)), '_blank');
          toast('Mensagem encaminhada para '+equipeLabel(eq)+'.');
          registrarEvento('compartilhamento','programacao',prog.id,podaProgLabel(prog), 'Encaminhado via WhatsApp para '+equipeLabel(eq));
        }
      }));
    }
  });
}

/* --- Poda Documento de Campo --- */
function podaDocAtribuicaoHtml(prog, atrib){
  const eq = findEquipe(atrib.equipeId);
  const rows = (atrib.atividades||[]).map((a,idx)=>{
    const at = findAtividade(a.atividadeId);
    return `<tr>
      <td style="text-align:center;">${idx+1}</td>
      <td class="mono" style="font-weight:700;">${esc(at?.codigo||'?')}</td>
      <td>${esc(at?.descricao||'')}</td>
      <td style="text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="text-align:center;">${a.quantidadePrevista??'—'}</td>
      <td style="height:22px;"></td>
    </tr>`;
  }).join('');
  return `
  <div class="ps-block">
    <div class="ps-block-head">
      <div>${podaProgLabel(prog)} — ${esc(prog.osi||'OSI')} — ${equipeLabel(eq)} — ${fmtDate(atrib.dataProgramada)}</div>
      <div class="ps-qr">${qrSvgHtml(equipePageUrlPoda(prog.id, atrib.equipeId), 3)}<div class="ps-qr-cap">Escaneie para acessar a página de serviço</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Supervisor</th><td>${esc(eq?.supervisor||'—')}</td><th>Encarregado</th><td>${esc(eq?.encarregado||'—')}</td></tr>
      <tr><th>Motorista</th><td>${esc(eq?.motorista||'—')}</td><th>Eletricistas</th><td>${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</td></tr>
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:''}</td></tr>`:''}
    </table>
    <table>
      <thead><tr><th style="width:26px;">#</th><th>Código</th><th>Descrição</th><th style="width:40px;">Un.</th><th style="width:52px;">Qtd prev.</th><th style="width:64px;">Qtd exec.</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="ps-check"><div><strong>Executou?</strong> &nbsp;☐ SIM &nbsp;☐ NÃO &nbsp;☐ PARCIAL</div><div><strong>Data da execução:</strong> ____/____/____</div></div>
    <div class="ps-sign"><strong>Observações do campo:</strong><div class="ps-obs"></div></div>
    <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
  </div>`;
}
function buildPodaDocProgramacao(prog){
  return `
    <div class="ps-head">
      <div><h1>G26 New · Programação de PODA</h1><div class="ps-sub">Documento de campo — programação</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(prog.dataProgramacao)}</div><div class="ps-sub">Emissão: ${fmtDateTime(Date.now())}</div></div>
    </div>
    <table class="ps-info">
      <tr><th>Programação</th><td><strong>${podaProgLabel(prog)}</strong></td><th>Emissão</th><td>${fmtDateTime(Date.now())}</td></tr>
      <tr><th>OSI</th><td>${esc(prog.osi||'—')}</td><th>Subestação</th><td>${esc(prog.subestacao||'—')}</td></tr>
      <tr><th>Tipo Rede</th><td>${esc(prog.tipoRede||'—')}</td><th>Chave</th><td>${esc(prog.chave||'—')}</td></tr>
      <tr><th>Qtd. Anomalia</th><td>${esc(String(prog.qtdAnomalia||'—'))}</td><th>OSE</th><td>${esc(String(prog.ose||'—'))}</td></tr>
      ${prog.observacoes? `<tr><th>Observações</th><td colspan="3">${esc(prog.observacoes)}</td></tr>`:''}
      ${String(prog.orientacoesPlanejamento||'').trim()? `<tr><th>Orientações do Setor de Planejamento</th><td colspan="3">${esc(prog.orientacoesPlanejamento)}</td></tr>`:''}
      ${prog.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(prog.local)}</strong>${(prog.localLat!=null&&prog.localLng!=null)? ` — <a href="${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}">${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</a>`:(prog.local? ` — <a href="${esc(mapsLinkByAddress(prog.local))}">${esc(mapsLinkByAddress(prog.local))}</a>`:'')}</td></tr>`:''}
    </table>
    ${(prog.atribuicoes||[]).map(at=> podaDocAtribuicaoHtml(prog, at)).join('')}
    ${(prog.localLat!=null&&prog.localLng!=null)? `<div class="ps-block" style="page-break-before:auto;break-before:auto;margin-top:8px;">
      <div class="ps-block-head">Localização no mapa — ${podaProgLabel(prog)}</div>
      ${staticMapImgTag(prog.localLat,prog.localLng,16,720,420, 'Mapa: '+(prog.local||''), 'width:100%;max-width:620px;border:1px solid #999;border-radius:4px;')}
      <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div class="ps-qr-box">${qrSvgHtml(mapsLinkByCoords(prog.localLat,prog.localLng), 4)}</div>
        <div style="font-size:11px;color:#333;"><strong>Escaneie para abrir no Google Maps</strong><br>${esc(mapsLinkByCoords(prog.localLat,prog.localLng))}</div>
      </div>
    </div>`:''}
<div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>
${docAnexosHtmlGeneric(prog, podaProgLabel)}
`;
}
function openPodaDocProgramacao(pgId){
const prog = findPodaProg(Number(pgId));
if(!prog) return;
printDocumento(buildPodaDocProgramacao(prog));
}
function openPodaDocDataModal(){
  const body = `
    <div class="field"><label>Data <span class="req">*</span></label><input type="date" name="data" required value="${todayISO()}"></div>
    <div class="field-hint">Gera um documento de campo com todas as equipes de poda programadas nesta data.</div>`;
  openModal({
    title:'Documento de campo PODA — por data', bodyHtml:body, submitLabel:'Gerar e imprimir',
    onSubmit:(fd)=>{
      const data = fd.get('data');
      if(!data){ toast('Informe a data.', 'error'); return false; }
      const list = flatPodaAtribuicoes().filter(x=> (x.atribuicao.dataProgramada||x.programacao.dataProgramacao)===data && x.atribuicao.status!=='Cancelado');
      if(!list.length){ toast('Nenhuma programação de poda nesta data.', 'error'); return false; }
      const html = `
        <div class="ps-head">
          <div><h1>G26 New · Programação de PODA</h1><div class="ps-sub">Documento de campo — ${fmtDate(data)}</div></div>
          <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(data)}</div><div class="ps-sub">${list.length} equipe(s) programada(s)</div></div>
        </div>
        ${list.map(x=> podaDocAtribuicaoHtml(x.programacao, x.atribuicao)).join('')}
        <div style="margin-top:8px;font-size:10.5px;color:#000;border-top:1px solid #444;padding-top:6px;">Assinatura do fiscal / responsável: <span class="ps-line"></span> &nbsp;&nbsp; Data: ____/____/____</div>`;
      printDocumento(html);
    }
  });
}

/* --- Poda Histórico --- */
function openPodaHistoricoModal(atribId){
  const r = podaAtribGlobal(Number(atribId));
  if(!r) return;
  const events = [...(r.atribuicao.historico||[])].sort((a,b)=>b.ts-a.ts);
  if(!events.length){
    openModal({ title:'Histórico', bodyHtml:'<div style="padding:24px;color:var(--muted-2);font-size:12.5px;">Sem eventos registrados.</div>', submitLabel:'Fechar', onSubmit:()=>true, wide:true });
    return;
  }
  const html = `<div class="timeline">${events.map(h=>{
    let dotColor='var(--muted)', title='';
    if(h.tipo==='criacao'){ dotColor='var(--blue)'; title='Programação criada'; }
    else if(h.tipo==='status'){ dotColor=STATUS_COLOR[h.para]||'var(--muted)'; title=`Status alterado: ${h.de} → ${h.para}`; }
    else if(h.tipo==='reprogramacao'){ dotColor='var(--purple)'; title=`Reprogramada: ${fmtDate(h.de)} → ${fmtDate(h.para)}`; }
    else { title=h.tipo||'Evento'; }
    return `<div class="tl-item" style="--dot-c:${dotColor}"><div class="tl-title">${title}</div><div class="tl-meta">${fmtDateTime(h.ts)} · <strong style="color:var(--muted);">${autor(h)}</strong></div>${h.motivo? `<div class="tl-motivo"><strong>Motivo:</strong> ${esc(h.motivo)}${h.obs? ' — '+esc(h.obs):''}</div>`:''}</div>`;
  }).join('')}</div>`;
  openModal({ title:'Histórico — '+podaProgLabel(r.programacao), bodyHtml:html, submitLabel:'Fechar', onSubmit:()=>true, wide:true });
}

/* --- openPodaProgramacaoModal --- */
function openPodaProgramacaoModal(id){
  if(!requerEscrita()) return;
  const pg = id ? findPodaProg(id) : null;
  let atribs = pg ? pg.atribuicoes.map(a=>({ equipeId:String(a.equipeId), atividades: a.atividades.map(x=>({atividadeId:String(x.atividadeId), quantidadePrevista:x.quantidadePrevista??''})) })) : [{ equipeId:'', atividades:[{atividadeId:'',quantidadePrevista:''}] }];
  let anexos = pg ? (pg.anexos||[]).map(a=>({...a})) : [];
  let anexosEnviando = false;
  let localAddr = pg?.local||'';
  let localLat = pg?.localLat??null;
  let localLng = pg?.localLng??null;

  function atribBlockHtml(a,i){
    const searchId = `poda-act-search-${i}`;
    return `<div class="atrib-block" data-idx="${i}">
      <div class="atrib-head">
        <select class="atrib-equipe" data-idx="${i}"><option value="">Selecione a equipe…</option>${equipesVisiveis().filter(e=>e.ativo!==false).map(e=>`<option value="${e.id}" ${String(a.equipeId)===String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' · '+esc(e.encarregado):''}</option>`).join('')}</select>
        ${atribs.length>1? `<button type="button" class="icon-btn atrib-remove" data-idx="${i}">${icon('trash',14)}</button>`:''}
      </div>
      <div class="atrib-meta-live" data-idx="${i}"></div>
      <div class="field" style="margin-bottom:8px;">
        <label for="${searchId}">${icon('search',14)} Buscar atividade (código ou descrição)</label>
        <input type="search" id="${searchId}" placeholder="Filtrar atividades…" style="width:100%;">
      </div>
      <div class="atrib-activities">${a.atividades.map((at,j)=>activityRowHtml(a,i,at,j)).join('')}</div>
      <button type="button" class="btn btn-sm btn-ghost atrib-add-activity" data-idx="${i}">${icon('plus',13)} Adicionar atividade</button>
    </div>`;
  }
  function activityRowHtml(a,i,at,j){
    return `<div class="activity-row" data-idx="${i}" data-jdx="${j}">
      <select class="act-select" data-idx="${i}" data-jdx="${j}"><option value="">Atividade…</option>${atividadesOrdenadas().map(x=>`<option value="${x.id}" ${String(at.atividadeId)===String(x.id)?'selected':''}>${isFavorita(x.id)?'★ ':''}${esc(x.codigo)} · ${esc(x.descricao)}</option>`).join('')}</select>
      <input type="number" step="0.01" min="0" class="act-qty" data-idx="${i}" data-jdx="${j}" placeholder="Qtd." value="${at.quantidadePrevista??''}">
      ${a.atividades.length>1? `<button type="button" class="icon-btn act-remove" data-idx="${i}" data-jdx="${j}">${icon('close',13)}</button>`:''}
    </div>`;
  }
  function renderAtribsHtml(){ return atribs.map((a,i)=>atribBlockHtml(a,i)).join(''); }

  const bodyHtml = `
    <div class="field-row">
      <div class="field"><label>OSI (Referência) <span class="req">*</span></label><input type="text" name="osi" value="${esc(pg?.osi||'')}" required placeholder="Ex.: OSI-12345"></div>
      <div class="field"><label>Subestação</label><input type="text" name="subestacao" value="${esc(pg?.subestacao||'')}" placeholder="Nome da subestação"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Qtd. Anomalia</label><input type="number" step="1" min="0" name="qtdAnomalia" value="${pg?.qtdAnomalia||''}" placeholder="0"></div>
      <div class="field"><label>Tipo Rede</label><select name="tipoRede"><option value="">Selecione…</option>${TIPO_REDE_OPCOES.map(v=>`<option ${pg?.tipoRede===v?'selected':''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>OSI (numérico)</label><input type="number" step="1" min="0" name="asi" value="${pg?.asi||''}" placeholder="0"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Chave</label><input type="text" name="chave" value="${esc(pg?.chave||'')}" placeholder="Código da chave"></div>
      <div class="field"><label>ID-SIPROG</label><input type="number" step="1" min="0" name="idSiprog" value="${pg?.idSiprog||''}" placeholder="0"></div>
      <div class="field"><label>OSE</label><input type="number" step="1" min="0" name="ose" value="${pg?.ose||''}" placeholder="0"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Data início <span class="req">*</span></label><input type="date" name="dataProgramacao" required value="${pg?.dataProgramacao||todayISO()}"></div>
      <div class="field"><label>Data fim (opcional)</label><input type="date" name="dataFim" value="${pg?.dataProgramacao||''}"><div class="field-hint">Se preenchido, cria uma programação para cada dia no intervalo. Deixe vazio para criar apenas 1.</div></div>
      <div class="field"><label>Status Documentação</label><select name="statusDocumentacao"><option value="">Selecione…</option>${STATUS_DOC_OPCOES.map(v=>`<option ${pg?.statusDocumentacao===v?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Observações</label><textarea name="observacoes" rows="2" placeholder="Observações da programação de poda">${esc(pg?.observacoes||'')}</textarea></div>
    <div class="field"><label>Local / endereço de execução</label>
      <input type="text" name="local" id="poda-local" required value="${esc(pg?.local||'')}" placeholder="Digite o endereço...">
      <div class="field-hint">Enquanto digita, geramos o link do Google Maps. Marque o ponto exato no mapa interativo.</div>
      <div id="poda-local-tools"></div>
      <div id="poda-map-wrap" style="display:none;margin-top:8px;">
        <div id="poda-local-map" style="height:460px;width:100%;border-radius:10px;overflow:hidden;border:1px solid var(--border-soft);"></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-primary" id="poda-map-confirm">Confirmar local no mapa</button>
          <button type="button" class="btn btn-sm btn-ghost" id="poda-map-cancel">Fechar mapa</button>
        </div>
      </div>
    </div>
    <div class="field"><label>Anexos</label>
      <input type="file" id="poda-anexos-input" accept="image/*" multiple>
      <div class="field-hint">Imagens para a equipe visualizar (croqui, localização, detalhe do serviço).</div>
      <div id="poda-anexos-preview">${anexosGridHtml(anexos, true)}</div>
      <div id="poda-anexos-progress" style="display:none;margin-top:8px;">
        <div id="poda-anexos-progress-text" style="font-size:11px;color:var(--muted);margin-bottom:4px;">Enviando…</div>
        <div style="height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div id="poda-anexos-progress-fill" style="height:100%;width:0%;background:var(--accent);transition:width .2s;"></div></div>
      </div>
    </div>
    <div class="field"><label>Orientações do Setor de Planejamento</label>
      <textarea name="orientacoesPlanejamento" rows="3" placeholder="Orientação de execução, restrições, pontos de atenção para a equipe...">${esc(pg?.orientacoesPlanejamento||'')}</textarea>
    </div>
    ${renderCustomFieldsInputs('programacoes', pg)}
    <div class="field"><label>Equipes e atividades <span class="req">*</span></label>
      <div id="atribs-container">${renderAtribsHtml()}</div>
      <button type="button" class="btn btn-sm" id="add-atrib-btn" style="margin-top:6px;align-self:flex-start;">${icon('plus',13)} Adicionar equipe</button>
    </div>`;

  openModal({
    title: pg? 'Editar programação de poda' : 'Nova programação de poda', bodyHtml, extraWide: true, submitLabel: pg? 'Salvar alterações':'Programar',
    onMount:(root)=>{
      function refreshContainer(){
        document.getElementById('atribs-container').innerHTML = renderAtribsHtml(); bindDynamic();
      }
      function bindDynamic(){
        root.querySelectorAll('.atrib-equipe').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].equipeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.atrib-remove').forEach(b=>b.addEventListener('click', e=>{ atribs.splice(Number(e.currentTarget.dataset.idx),1); refreshContainer(); }));
        root.querySelectorAll('.atrib-add-activity').forEach(b=>b.addEventListener('click', e=>{ atribs[Number(e.currentTarget.dataset.idx)].atividades.push({atividadeId:'',quantidadePrevista:''}); refreshContainer(); }));
        root.querySelectorAll('.act-select').forEach(s=>s.addEventListener('change', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].atividadeId = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-qty').forEach(s=>s.addEventListener('input', e=>{ atribs[e.target.dataset.idx].atividades[e.target.dataset.jdx].quantidadePrevista = e.target.value; atualizarMetaIndicadores(); }));
        root.querySelectorAll('.act-remove').forEach(b=>b.addEventListener('click', e=>{ const i=Number(e.currentTarget.dataset.idx), j=Number(e.currentTarget.dataset.jdx); atribs[i].atividades.splice(j,1); refreshContainer(); }));
        root.querySelectorAll('input[type="search"][id^="poda-act-search-"]').forEach(input=>{
          const idx = input.id.replace('poda-act-search-','');
          input.addEventListener('input', ()=>{
            const term = input.value.toLowerCase();
            root.querySelectorAll(`.act-select[data-idx="${idx}"]`).forEach(sel=>{
              const selected = sel.value;
              Array.from(sel.options).forEach(opt=>{
                if(opt.value==='') return;
                opt.style.display = opt.textContent.toLowerCase().includes(term) ? '' : 'none';
              });
              if(selected && !Array.from(sel.options).find(o=>o.value===selected && o.style.display!=='none')) sel.value = '';
            });
          });
        });
        atualizarMetaIndicadores();
      }
      function atualizarMetaIndicadores(){
        root.querySelectorAll('.atrib-meta-live').forEach(el=>{
          const i = Number(el.dataset.idx);
          const a = atribs[i];
          const eq = a && a.equipeId? findEquipe(a.equipeId) : null;
          const meta = metaDiaria(eq);
          const total = (a?.atividades||[]).reduce((s,at)=>{
            const atDef = at.atividadeId? findAtividade(at.atividadeId) : null;
            return s + (parseFloat(at.quantidadePrevista)||0) * (atDef?.valorUnitario||0);
          },0);
          if(!eq){ el.innerHTML=''; return; }
          if(!meta){
            el.innerHTML = `<div class="atrib-meta-wrap"><span style="font-size:11px;color:var(--muted);">Programação total: <strong>${fmtMoney(total)}</strong> (meta diária não definida para esta equipe)</span></div>`;
            return;
          }
          const pct = Math.round(total/meta*100);
          const cor = pct>=100? 'var(--green)' : pct>=50? 'var(--accent)' : 'var(--red)';
          el.innerHTML = `<div class="atrib-meta-wrap">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <strong style="font-size:11px;letter-spacing:.02em;">PROGRAMAÇÃO EM <span style="color:${cor};">${pct}%</span> DA META DA EQUIPE</strong>
              <span style="font-size:11px;color:var(--muted);">${fmtMoney(total)} de ${fmtMoney(meta)}</span>
            </div>
            <div class="atrib-meta-bar"><div style="width:${Math.min(100,pct)}%;background:${cor};"></div></div>
          </div>`;
        });
      }
      bindDynamic();
      document.getElementById('add-atrib-btn').addEventListener('click', ()=>{ atribs.push({equipeId:'',atividades:[{atividadeId:'',quantidadePrevista:''}]}); refreshContainer(); });

      const anexosPreview = root.querySelector('#poda-anexos-preview');
      const anexosInput = root.querySelector('#poda-anexos-input');
      const anexosProgress = root.querySelector('#poda-anexos-progress');
      const anexosProgressText = root.querySelector('#poda-anexos-progress-text');
      const anexosProgressFill = root.querySelector('#poda-anexos-progress-fill');
      function paintAnexos(){
        anexosPreview.innerHTML = anexosGridHtml(anexos, true);
        anexosPreview.querySelectorAll('.anexo-remove').forEach(b=>b.addEventListener('click', ()=>{
          anexos.splice(Number(b.dataset.i),1); paintAnexos();
        }));
      }
      anexosInput.addEventListener('change', async ()=>{
        const files = Array.from(anexosInput.files||[]);
        if(!files.length) return;
        const sobra = Math.max(0, 8 - anexos.length);
        const fila = files.slice(0, sobra);
        if(files.length > sobra) toast('Máximo de 8 anexos.', 'error');
        if(!fila.length){ anexosInput.value=''; return; }
        anexosInput.disabled = true;
        anexosEnviando = true;
        const total = fila.length;
        let feitos = 0;
        const atualizar = ()=>{
          anexosProgressFill.style.width = Math.round(feitos/total*100)+'%';
          anexosProgressText.textContent = total>1? `Enviando ${Math.min(feitos+1,total)} de ${total}…` : 'Enviando…';
        };
        anexosProgress.style.display = 'block';
        paintAnexos();
        atualizar();
        await Promise.all(fila.map(async (f)=>{
          let url = '';
          try{
            const blob = await comprimirImagem(f);
            url = await uploadToImgbb(blob);
          }catch(e){ toast('Falha ao enviar '+esc(f.name)+' ('+e.message+').', 'error'); }
          if(url) anexos.push({ nome: f.name||('anexo-'+Date.now()), url, ts: Date.now() });
          feitos++; atualizar(); paintAnexos();
        }));
        anexosEnviando = false;
        anexosProgress.style.display = 'none';
        anexosInput.disabled = false; anexosInput.value='';
        paintAnexos();
      });
      paintAnexos();

      const localInput = root.querySelector('#poda-local');
      const localTools = root.querySelector('#poda-local-tools');
      const mapWrap = root.querySelector('#poda-map-wrap');
      let leafletMap = null;
      function paintLocalTools(){
        if(!localAddr){ localTools.innerHTML=''; return; }
        localTools.innerHTML = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <a href="${esc(mapsLinkByAddress(localAddr))}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;color:var(--blue);font-weight:600;font-size:12.5px;">${icon('pin',13)} Abrir no Google Maps</a>
          <button type="button" class="btn btn-sm" id="poda-open-map" style="font-size:12px;">${icon('pin',13)} Marcar no mapa</button>
        </div>`;
        const openMapBtn = localTools.querySelector('#poda-open-map');
        if(openMapBtn) openMapBtn.addEventListener('click', ()=> showLeafletMap());
      }
      async function showLeafletMap(){
        mapWrap.style.display = 'block';
        try{
          const L = await loadLeaflet();
          const center = localLat!=null && localLng!=null ? [localLat, localLng] : [-17.85, -49.25];
          if(leafletMap){ leafletMap.remove(); leafletMap=null; }
          leafletMap = L.map('poda-local-map').setView(center, localLat!=null? 16 : 12);
          L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Esri' }).addTo(leafletMap);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, opacity:0.5 }).addTo(leafletMap);
          let marker = localLat!=null && localLng!=null ? L.marker(center).addTo(leafletMap) : null;
          leafletMap.on('click', (e)=>{
            if(marker) leafletMap.removeLayer(marker);
            marker = L.marker(e.latlng).addTo(leafletMap);
          });
          setTimeout(()=> leafletMap.invalidateSize(), 200);
          root.querySelector('#poda-map-confirm').onclick = async ()=>{
            if(!marker){ toast('Clique no mapa para marcar um ponto.', 'error'); return; }
            const ll = marker.getLatLng();
            localLat = ll.lat; localLng = ll.lng;
            const rev = await geoapifyReverse(localLat, localLng);
            if(rev){ localAddr = rev; localInput.value = rev; }
            mapWrap.style.display = 'none';
            paintLocalTools();
            toast('Local confirmado no mapa.');
          };
          root.querySelector('#poda-map-cancel').onclick = ()=>{ mapWrap.style.display = 'none'; };
        }catch(e){ toast('Falha ao carregar o mapa: '+e.message, 'error'); mapWrap.style.display='none'; }
      }
      let localDeb = null;
      localInput.addEventListener('input', ()=>{
        localAddr = localInput.value.trim();
        clearTimeout(localDeb);
        localDeb = setTimeout(paintLocalTools, 500);
      });
      paintLocalTools();
    },
    onSubmit:(fd)=>{
      if(anexosEnviando){ toast('Aguarde o envio das imagens.', 'error'); return false; }
      const osi = fd.get('osi').trim();
      if(!osi){ toast('Informe a OSI (Referência).', 'error'); return false; }
      const dataProgramacao = fd.get('dataProgramacao');
      if(!dataProgramacao){ toast('Informe a data de programação.', 'error'); return false; }
      if(!atribs.length || atribs.some(a=>!a.equipeId)){ toast('Selecione a equipe em todos os blocos.', 'error'); return false; }
      for(const a of atribs){ if(!a.atividades.length || a.atividades.some(x=>!x.atividadeId)){ toast('Selecione a atividade em todas as linhas.', 'error'); return false; } }
      const observacoes = String(fd.get('observacoes')||'').trim();
      const orientacoesPlanejamento = String(fd.get('orientacoesPlanejamento')||'').trim();
      const local = String(fd.get('local')||'').trim()||localAddr||'';
      if(!local){ toast('Informe o local da programação.', 'error'); return false; }
      const custom = {};
      (DB.customFields.programacoes||[]).forEach(f=>{ const v=fd.get('cf_'+f.id); if(v!=null) custom[f.id]=v; });
      const base = {
        osi, subestacao: fd.get('subestacao').trim(), qtdAnomalia: Number(fd.get('qtdAnomalia'))||0,
        tipoRede: fd.get('tipoRede'), chave: fd.get('chave').trim(), asi: Number(fd.get('asi'))||0,
        dataProgramacao, statusDocumentacao: fd.get('statusDocumentacao'),
        idSiprog: Number(fd.get('idSiprog'))||0, ose: Number(fd.get('ose'))||0,
        observacoes, orientacoesPlanejamento, custom,
        local, localLat: local? localLat : null, localLng: local? localLng : null, anexos: anexos.map(a=>({...a})),
        atividades: atribs.map(a=>({
          equipeId: Number(a.equipeId),
          atividades: a.atividades.map(x=>({atividadeId:Number(x.atividadeId), quantidadePrevista: x.quantidadePrevista?parseFloat(x.quantidadePrevista):null, quantidadeExecutada:null}))
        }))
      };
      const dataFim = fd.get('dataFim');
      const datas = (dataFim && dataFim !== dataProgramacao) ? gerarDatasIntervalo(dataProgramacao, dataFim).slice(0,31) : [dataProgramacao];
      if(pg){
        Object.assign(pg, base);
        pg.atribuicoes = base.atividades.map((a,i)=>{
          const existing = pg.atribuicoes.find(x=>x.equipeId===a.equipeId);
          if(existing){ existing.atividades = a.atividades; return existing; }
          return { id: nextId(), equipeId:a.equipeId, dataProgramada:dataProgramacao, status:'Programado', atividades:a.atividades, historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Atribuição criada'}] };
        });
        pg.atribuicoes.forEach(at=>{ at.dataProgramada = dataProgramacao; });
        registrarEvento('edicao','programacao',pg.id,podaProgLabel(pg), (pg.atribuicoes||[]).length+' equipe(s), '+pg.atribuicoes.reduce((s,a)=>s+(a.atividades?.length||0),0)+' atividade(s)');
        toast('Programação de poda atualizada.');
      } else {
        if(datas.length > 1){
          let count = 0;
          for(const dt of datas){
            const novo = { id: nextId(), gid: null, ...base, dataProgramacao: dt,
              status: 'Programado',
              atribuicoes: base.atividades.map(a=>({ id: nextId(), equipeId:a.equipeId, dataProgramada:dt, status:'Programado', atividades:a.atividades.map(x=>({...x})), historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Programação criada'}] }))
            };
            DB.podaProgramacoes.push(novo);
            count++;
          }
          toast(count+' programações de poda criadas no intervalo.');
          registrarEvento('criacao','programacao',DB.podaProgramacoes[DB.podaProgramacoes.length-1].id,podaProgLabel(DB.podaProgramacoes[DB.podaProgramacoes.length-1]), count+' programação(ões) de poda');
        } else {
          const novo = { id: nextId(), gid: null, ...base,
            status: 'Programado',
            atribuicoes: base.atividades.map(a=>({ id: nextId(), equipeId:a.equipeId, dataProgramada:dataProgramacao, status:'Programado', atividades:a.atividades, historico:[{...currentAutor(), ts:Date.now(),tipo:'criacao',de:null,para:'Programado',motivo:'Programação criada'}] }))
          };
          DB.podaProgramacoes.push(novo);
          toast('Programação de poda criada.');
          registrarEvento('criacao','programacao',novo.id,podaProgLabel(novo), novo.atribuicoes.length+' equipe(s), '+novo.atribuicoes.reduce((s,a)=>s+a.atividades.length,0)+' atividade(s)');
        }
      }
      saveData(); renderContent(); renderBanner();
    }
  });
}
/* --- renderPodaRdo (placeholder) --- */
function renderPodaRdo(){
  const el = document.getElementById('content');
  let registros = flatPodaAtribuicoes().filter(rdoTemExecucao);
  registros.sort((a,b)=> String(b.atribuicao.dataProgramada||'').localeCompare(String(a.atribuicao.dataProgramada||'')));

  const stats = (()=>{
    const total = registros.length;
    const concluidos = registros.filter(x=>x.atribuicao.status==='Concluído').length;
    const totalExec = registros.reduce((s,x)=> s+rdoResumo(x).exec, 0);
    const mediaPct = total? Math.round(registros.reduce((s,x)=> s+rdoResumo(x).pct,0)/total) : 0;
    const imped = registros.filter(x=> rdoImpedimentos(x.atribuicao).length>0).length;
    return `
      <div class="grid-stats">
        <div class="stat-card"><div class="lbl">Registros de execução</div><div class="val">${total}</div></div>
        <div class="stat-card" style="--accent-c:var(--green);"><div class="lbl">Concluídas</div><div class="val">${concluidos}</div></div>
        <div class="stat-card" style="--accent-c:var(--blue);"><div class="lbl">Qtd. executada</div><div class="val">${fmtNum(totalExec)}</div></div>
        <div class="stat-card" style="--accent-c:var(--accent);"><div class="lbl">Conclusão média</div><div class="val">${mediaPct}<small>%</small></div></div>
        <div class="stat-card" style="--accent-c:var(--red);"><div class="lbl">Com impedimentos</div><div class="val">${imped}</div></div>
      </div>`;
  })();

  const equipes = [...new Set(registros.map(x=>x.atribuicao.equipeId))].map(id=> findEquipe(id)).filter(Boolean);

  const filters = `
    <div class="panel" style="padding:14px 16px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <input type="search" id="poda-rdo-f-busca" placeholder="Buscar por OSI, equipe, data, status..." style="flex:1;">
        <button class="btn btn-sm" id="poda-rdo-f-busca-aplicar">${icon('search',13)} Buscar</button>
      </div>
      <div class="filters">
        <label style="font-weight:600;">Equipe</label>
        <select id="poda-rdo-f-equipe"><option value="">Todas</option>${equipes.map(e=>`<option value="${e.id}">${esc(equipeLabel(e))}</option>`).join('')}</select>
        <label style="font-weight:600;">Status</label>
        <select id="poda-rdo-f-status"><option value="">Todos</option>${STATUS_PODA.map(s=>`<option>${s}</option>`).join('')}</select>
        <label style="font-weight:600;">De</label>
        <input type="date" id="poda-rdo-f-de">
        <label style="font-weight:600;">Até</label>
        <input type="date" id="poda-rdo-f-ate">
        <button class="btn btn-sm" id="poda-rdo-f-aplicar">${icon('grid',13)} Filtrar</button>
        <button class="btn btn-sm btn-ghost" id="poda-rdo-f-limpar">Limpar</button>
      </div>
    </div>`;

  const tabela = `
    <div class="panel" style="padding:0;overflow:hidden;">
      <div class="panel-head" style="padding:14px 16px;">
        <div><h3>Execuções de PODA</h3><div class="admin-field-meta">Dados de execução de poda registrados pelas equipes.</div></div>
        <div class="filters" style="gap:6px;">
          <button class="btn btn-sm" id="poda-rdo-export">${icon('download',13)} Excel</button>
          <button class="btn btn-sm btn-ghost" id="poda-rdo-print">${icon('print',13)} Imprimir</button>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1200px;">
          <thead>
            <tr>
              <th style="width:30px;">#</th>
              <th>Programação</th>
              <th>Equipe</th>
              <th style="text-align:center;">Data</th>
              <th style="text-align:center;">Status</th>
              <th style="text-align:center;">Horários</th>
              <th style="text-align:center;">Clima</th>
              <th style="text-align:center;">Impedimentos</th>
              <th style="text-align:center;">Prev.</th>
              <th style="text-align:center;">Exec.</th>
              <th style="text-align:center;width:110px;">Progresso</th>
              <th style="text-align:center;">Confirmação</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${registros.map((x,i)=>{
              const eq = findEquipe(x.atribuicao.equipeId);
              const res = rdoResumo(x);
              const imped = rdoImpedimentos(x.atribuicao);
              const horarios = [x.atribuicao.rdoHorarioChegada, x.atribuicao.rdoHorarioSaidaObra].filter(Boolean).join(' → ')||'—';
              return `
                <tr data-poda-prog="${x.programacao.id}" data-poda-atrib="${x.atribuicao.id}" style="cursor:pointer;" title="Ver detalhes">
                  <td style="text-align:center;color:var(--muted-2);">${i+1}</td>
                  <td><strong>${podaProgLabel(x.programacao)}</strong><div class="admin-field-meta">OSI ${esc(x.programacao.osi||'—')} · ${esc(x.programacao.subestacao||'—')}</div></td>
                  <td>${esc(equipeLabel(eq))}<div class="admin-field-meta">${esc(eq?.supervisor||'')}</div></td>
                  <td style="text-align:center;" class="mono">${fmtDate(x.atribuicao.dataProgramada)}</td>
                  <td style="text-align:center;">${rdoStatusBadge(x.atribuicao.status)}</td>
                  <td style="text-align:center;" class="mono">${esc(horarios)}</td>
                  <td style="text-align:center;">${esc(x.atribuicao.rdoCondicoes||'—')}</td>
                  <td style="text-align:center;">${imped.length? `<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);">${imped.length}</span>` : '—'}</td>
                  <td style="text-align:center;" class="mono">${fmtNum(res.prev)}</td>
                  <td style="text-align:center;" class="mono"><strong>${fmtNum(res.exec)}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="flex:1;height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${Math.min(100,res.pct)}%;background:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};border-radius:3px;"></div></div>
                      <span class="mono" style="font-size:11px;min-width:34px;text-align:right;">${res.pct}%</span>
                    </div>
                  </td>
                  <td style="text-align:center;" class="mono"><span style="font-size:11px;">${rdoConfData(x)}</span></td>
                  <td style="text-align:center;">${icon('search',13)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  if(!registros.length){
    el.innerHTML = `<div class="section-gap">${stats}<div class="panel"><div class="empty-state">${icon('check',36)}<h3 style="margin-bottom:6px;">Nenhuma execução de poda registrada</h3><p>Quando as equipes responderem o RDO de poda, os dados de execução aparecerão aqui.</p></div></div></div>`;
    return;
  }

  el.innerHTML = `<div class="section-gap">${stats}${filters}${tabela}</div>`;

  const fEq = document.getElementById('poda-rdo-f-equipe');
  const fSt = document.getElementById('poda-rdo-f-status');
  const fDe = document.getElementById('poda-rdo-f-de');
  const fAte = document.getElementById('poda-rdo-f-ate');
  const fBusca = document.getElementById('poda-rdo-f-busca');
  const norm = s=> String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const aplicar = ()=>{
    const q = norm(fBusca.value.trim());
    registros.forEach(x=>{
      const eq = findEquipe(x.atribuicao.equipeId);
      const okEq = !fEq.value || String(x.atribuicao.equipeId)===String(fEq.value);
      const okSt = !fSt.value || x.atribuicao.status===fSt.value;
      const data = x.atribuicao.dataProgramada||'';
      const okDe = !fDe.value || data >= fDe.value;
      const okAte = !fAte.value || data <= fAte.value;
      const hay = norm([
        podaProgLabel(x.programacao), x.programacao.osi, x.programacao.subestacao,
        equipeLabel(eq), eq?.supervisor, data, x.atribuicao.status,
        rdoImpedimentos(x.atribuicao).join(' '),
        String(x.programacao.id), String(x.atribuicao.id)
      ].join(' '));
      const okBusca = !q || hay.indexOf(q)!==-1;
      const tr = document.querySelector(`tr[data-poda-prog="${x.programacao.id}"][data-poda-atrib="${x.atribuicao.id}"]`);
      if(tr) tr.style.display = (okEq&&okSt&&okDe&&okAte&&okBusca)? '' : 'none';
    });
  };
  fBusca.addEventListener('input', aplicar);
  document.getElementById('poda-rdo-f-busca-aplicar').addEventListener('click', aplicar);
  document.getElementById('poda-rdo-f-aplicar').addEventListener('click', aplicar);
  document.getElementById('poda-rdo-f-limpar').addEventListener('click', ()=>{
    fEq.value=''; fSt.value=''; fDe.value=''; fAte.value=''; fBusca.value=''; aplicar();
  });

  document.querySelectorAll('tr[data-poda-prog]').forEach(tr=>{
    tr.addEventListener('click', ()=> openPodaRDOModal(Number(tr.dataset.podaProg), Number(tr.dataset.podaAtrib)));
  });

  document.getElementById('poda-rdo-export').addEventListener('click', ()=> exportRDOTipo(registros,'poda'));
  document.getElementById('poda-rdo-print').addEventListener('click', ()=> printRDOReportTipo(registros,'poda'));
}

function openPodaRDOModal(progId, attribId){
  const x = flatPodaAtribuicoes().find(y=> y.programacao.id===progId && y.atribuicao.id===attribId);
  if(!x) return;
  const eq = findEquipe(x.atribuicao.equipeId);
  const rdo = x.atribuicao.rdoRespostas||{};
  const res = rdoResumo(x);
  const imped = rdoImpedimentos(x.atribuicao);
  const horarios = RDO_HORARIOS.map(h=> `
    <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
    <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');

  const body = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div>
        <h4 style="margin-bottom:8px;">Programação ${podaProgLabel(x.programacao)}</h4>
        <p class="admin-field-meta" style="margin:2px 0;">OSI: ${esc(x.programacao.osi||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Subestação: ${esc(x.programacao.subestacao||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Tipo Rede: ${esc(x.programacao.tipoRede||'—')} · Chave: ${esc(x.programacao.chave||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Data: ${fmtDate(x.atribuicao.dataProgramada)}</p>
        <div style="margin-top:8px;">${rdoStatusBadge(x.atribuicao.status)}</div>
      </div>
      <div>
        <h4 style="margin-bottom:8px;">Equipe</h4>
        <p class="admin-field-meta" style="margin:2px 0;"><strong>${esc(equipeLabel(eq))}</strong></p>
        <p class="admin-field-meta" style="margin:2px 0;">Supervisor: ${esc(eq?.supervisor||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Encarregado: ${esc(eq?.encarregado||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Motorista: ${esc(eq?.motorista||'—')}</p>
      </div>
    </div>
    ${(x.programacao.anexos&&x.programacao.anexos.length)? `<div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Anexos do programador</h4>
      ${anexosDisplayHtml(x.programacao.anexos)}
    </div>`:''}
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Horários do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">${horarios}</table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">KM do Veículo</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_KM.map(h=> `
          <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
          <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('')}
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Condições do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_QUESTIONS.map(q=>`
          <tr><td style="font-weight:600;padding:3px 12px 3px 0;">${q.label}</td>
          <td style="padding:3px 10px;">${String(rdo[q.id]||'')||'—'}</td></tr>`).join('')}
      </table>
      ${imped.length? `<div style="margin-top:10px;">${imped.map(i=>`<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);margin-right:4px;">${esc(i)}</span>`).join('')}</div>`:''}
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Atividades e quantidades executadas</h4>
      <div style="display:flex;gap:14px;margin-bottom:12px;">
        <span class="badge-prefix">Prev. ${fmtNum(res.prev)}</span>
        <span class="badge-prefix alt">Exec. ${fmtNum(res.exec)}</span>
        <span class="badge-prefix" style="color:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};">${res.pct}%</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr><th style="text-align:left;padding:4px 6px;">#</th><th style="text-align:left;">Código</th><th style="text-align:left;">Descrição</th><th style="text-align:center;">Un.</th><th style="text-align:center;">Prev.</th><th style="text-align:center;">Exec.</th><th style="text-align:center;">%</th><th style="text-align:center;">Fotos</th></tr></thead>
        <tbody>
          ${(x.atribuicao.atividades||[]).map((a,idx)=>{
            const at = findAtividade(a.atividadeId);
            const p = parseFloat(a.quantidadePrevista)||0;
            const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
            const pct = p? Math.round((e||0)/p*100) : 0;
            const fotos = String(a.fotos||'').split(';;').filter(Boolean);
            return `<tr style="border-top:1px solid var(--border-soft);">
              <td style="padding:4px 6px;color:var(--muted-2);">${idx+1}</td>
              <td class="mono" style="padding:4px 6px;">${esc(at?.codigo||'?')}</td>
              <td style="padding:4px 6px;">${esc(at?.descricao||'')}</td>
              <td style="text-align:center;">${esc(at?.unidade||'')}</td>
              <td style="text-align:center;" class="mono">${p? fmtNum(p):'—'}</td>
              <td style="text-align:center;" class="mono"><strong>${e!=null? fmtNum(e):'—'}</strong></td>
              <td style="text-align:center;color:${pct>=100?'var(--green)':pct>=50?'var(--accent)':'var(--red)'};font-weight:700;">${p? pct+'%':'—'}</td>
              <td style="text-align:center;">${fotos.length? `<div class="rdo-fotos" style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap;">${fotos.map(u=>`<img class="rdo-foto" src="${esc(u)}" alt="foto" title="Ampliar" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;">`).join('')}</div>`:'<span style="color:var(--muted-2);">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Observação da execução</h4>
      <p style="font-size:13px;">${esc(x.atribuicao.observacao)||'—'}</p>
    </div>
    <div class="admin-field-meta">Confirmado pela equipe em <strong>${rdoConfData(x)}</strong></div>`;

  openModal({ title:'RDO Poda — Detalhes da execução', bodyHtml: body, submitLabel:'Fechar', wide:true, footerBtns:[
    { label: icon('edit',14)+' Editar registro', cls:'btn', onClick: ()=> editRdoModal(x, podaProgLabel) },
    { label: icon('print',14)+' Gerar PDF', cls:'btn', onClick: ()=> printRDOTipoCompleto(x,'poda') }
  ] });
}
function renderOcNds(){
  const el = document.getElementById('content');
  if(!DB.equipes.length){
    el.innerHTML = emptyState('Cadastre equipes primeiro', 'É necessário ter equipes cadastradas para despachar OC/NDS.');
    return;
  }
  const list = ocndsVisiveis().slice().sort((a,b)=> String(b.data||'').localeCompare(String(a.data||'')));

  const stats = (()=>{
    const total = list.length;
    const despachadas = list.filter(x=>x.status==='Despachada').length;
    const baixadas = list.filter(x=>x.status==='Baixada').length;
    const concluidas = list.filter(x=>x.status==='Concluída').length;
    const oc = list.filter(x=>x.tipo==='OC').length;
    const nds = list.filter(x=>x.tipo==='NDS').length;
    return `
      <div class="grid-stats">
        <div class="stat-card"><div class="lbl">Total</div><div class="val">${total}</div></div>
        <div class="stat-card" style="--accent-c:var(--blue);"><div class="lbl">Despachadas</div><div class="val">${despachadas}</div></div>
        <div class="stat-card" style="--accent-c:var(--accent);"><div class="lbl">Baixadas</div><div class="val">${baixadas}</div></div>
        <div class="stat-card" style="--accent-c:var(--green);"><div class="lbl">Concluídas</div><div class="val">${concluidas}</div></div>
        <div class="stat-card"><div class="lbl">OC</div><div class="val">${oc}</div></div>
        <div class="stat-card"><div class="lbl">NDS</div><div class="val">${nds}</div></div>
      </div>`;
  })();

  const tabela = `
    <div class="panel" style="padding:0;overflow:hidden;">
      <div class="panel-head" style="padding:14px 16px;">
        <div><h3>Ocorrências OC / NDS</h3><div class="admin-field-meta">Despacho de ocorrências para equipes de campo.</div></div>
        <div class="filters" style="gap:6px;">
          <button class="btn btn-sm btn-primary" id="ocnds-novo">${icon('plus',13)} Nova ocorrência</button>
        </div>
      </div>
      ${!list.length ? `<div style="padding:40px;text-align:center;"><div class="empty-state">${icon('siren',36)}<h3 style="margin-bottom:6px;">Nenhuma ocorrência cadastrada</h3><p>Clique em "Nova ocorrência" para criar a primeira OC ou NDS.</p></div></div>` : `
      <div style="overflow-x:auto;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1050px;">
          <thead>
            <tr>
              <th style="width:30px;">#</th>
              <th>ID</th>
              <th>Tipo</th>
              <th>Setor</th>
              <th>Coordenação</th>
              <th style="text-align:center;">Data</th>
              <th>Equipe</th>
              <th>Detalhes</th>
              <th style="text-align:center;">Status</th>
              <th style="width:120px;"></th>
            </tr>
          </thead>
          <tbody>
            ${list.map((x,i)=>{
              const eq = findEquipe(x.equipeId);
              const detalhes = x.tipo==='OC'
                ? [x.ptp&&'PTP: '+x.ptp, x.si&&'SI: '+x.si, x.ose&&'OSE: '+x.ose].filter(Boolean).join(' · ')||'—'
                : [x.ocorrencia&&'Ocorrência: '+x.ocorrencia].filter(Boolean).join('')||'—';
              const badge = x.tipo==='OC'
                ? `<span class="badge" style="color:var(--blue);background:rgba(78,140,235,.14);">OC</span>`
                : `<span class="badge" style="color:var(--accent);background:rgba(224,164,88,.14);">NDS</span>`;
              const stColor = STATUS_OC_NDS_COLOR[x.status]||'var(--muted)';
              const stBg = bgFromVar(stColor);
              return `
                <tr data-ocnds-id="${x.id}" style="cursor:pointer;" title="Ver detalhes">
                  <td style="text-align:center;color:var(--muted-2);">${i+1}</td>
                  <td class="mono">${esc(x.gid||'G26-'+String(x.id).padStart(7,'0'))}</td>
                  <td>${badge}</td>
                  <td style="font-size:12px;">${esc(x.setor||'—')}</td>
                  <td style="font-size:12px;">${esc(x.coordenacao||'—')}</td>
                  <td style="text-align:center;" class="mono">${fmtDate(x.data)}</td>
                  <td><span class="badge-prefix">${eqtlLabel(eq)}</span><div class="admin-field-meta">${esc(eq?.supervisor||'')}</div></td>
                  <td style="font-size:12px;color:var(--muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(detalhes)}</td>
                  <td style="text-align:center;"><span class="badge" style="color:${stColor};background:${stBg};"><span class="badge-dot"></span>${esc(x.status)}</span></td>
                  <td style="text-align:center;">
                    <div class="row-actions">
                      <button class="icon-btn" title="Encaminhar WhatsApp" data-ocnds-whats="${x.id}">${icon('whatsapp',14)}</button>
                      <button class="icon-btn" title="Editar" data-ocnds-edit="${x.id}">${icon('edit',14)}</button>
                      <button class="icon-btn" title="Excluir" data-ocnds-del="${x.id}">${icon('trash',14)}</button>
                    </div>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
    </div>`;

  el.innerHTML = `<div class="section-gap">${stats}${tabela}</div>`;

  document.getElementById('ocnds-novo').addEventListener('click', ()=> openOcNdsModal());

  el.querySelectorAll('tr[data-ocnds-id]').forEach(tr=>{
    tr.addEventListener('click', (e)=>{
      if(e.target.closest('[data-ocnds-whats]') || e.target.closest('[data-ocnds-edit]') || e.target.closest('[data-ocnds-del]')) return;
      openOcNdsDetalhe(Number(tr.dataset.ocndsId));
    });
  });

  el.querySelectorAll('[data-ocnds-whats]').forEach(b=> b.addEventListener('click', (e)=>{
    e.stopPropagation();
    encaminharWhatsOcNds(Number(b.dataset.ocndsWhats));
  }));

  el.querySelectorAll('[data-ocnds-edit]').forEach(b=> b.addEventListener('click', (e)=>{
    e.stopPropagation();
    openOcNdsModal(Number(b.dataset.ocndsEdit));
  }));

  el.querySelectorAll('[data-ocnds-del]').forEach(b=> b.addEventListener('click', (e)=>{
    e.stopPropagation();
    deletarOcNds(Number(b.dataset.ocndsDel));
  }));
}

function openOcNdsModal(id){
  if(!requerEscrita()) return;
  const item = id ? (DB.ocnds||[]).find(x=>x.id===Number(id)) : null;

  const userSetor = CURRENT_USER?.setor || '';
  const userCoord = CURRENT_USER?.coordenacao || '';
  const isRestricted = usuarioRestrito();

  const body = `
    <div class="field-row">
      <div class="field"><label>Setor <span class="req">*</span></label>
        <select name="setor" id="ocnds-setor" required ${isRestricted?'disabled':''}>
          <option value="">Selecione…</option>
          <option value="OBRAS" ${(item?.setor||userSetor)==='OBRAS'?'selected':''}>OBRAS</option>
          <option value="MANUTENÇÃO" ${(item?.setor||userSetor)==='MANUTENÇÃO'?'selected':''}>MANUTENÇÃO</option>
        </select>
      </div>
      <div class="field"><label>Coordenação <span class="req">*</span></label>
        <select name="coordenacao" id="ocnds-coord" required ${isRestricted?'disabled':''}>
          <option value="">Selecione…</option>
          <option value="RIO VERDE" ${(item?.coordenacao||userCoord)==='RIO VERDE'?'selected':''}>RIO VERDE</option>
          <option value="QUIRINOPOLIS" ${(item?.coordenacao||userCoord)==='QUIRINOPOLIS'?'selected':''}>QUIRINÓPOLIS</option>
        </select>
      </div>
    </div>

    <div class="field"><label>Tipo <span class="req">*</span></label>
      <select name="tipo" id="ocnds-tipo" required>
        <option value="OC" ${item?.tipo==='OC'?'selected':''}>OC (Ocorrência)</option>
        <option value="NDS" ${item?.tipo==='NDS'?'selected':''}>NDS (Nota de Serviço)</option>
      </select>
    </div>

    <div id="ocnds-campos-oc" style="display:${(!item || item.tipo==='OC')?'block':'none'};">
      <div class="field-row">
        <div class="field"><label>PTP</label><input type="text" name="ptp" value="${esc(item?.ptp||'')}" placeholder="Número do PTP"></div>
        <div class="field"><label>SI</label><input type="text" name="si" value="${esc(item?.si||'')}" placeholder="Número do SI"></div>
      </div>
      <div class="field"><label>OSE</label><input type="text" name="ose" value="${esc(item?.ose||'')}" placeholder="Número da OSE"></div>
    </div>

    <div id="ocnds-campos-nds" style="display:${item?.tipo==='NDS'?'block':'none'};">
      <div class="field"><label>Ocorrência <span class="req">*</span></label><input type="text" name="ocorrencia" value="${esc(item?.ocorrencia||'')}" placeholder="Número da ocorrência"></div>
    </div>

    <div class="field"><label>Data <span class="req">*</span></label><input type="date" name="data" required value="${item?.data||todayISO()}"></div>

    <div class="field"><label>Equipe(s) <span class="req">*</span></label>
      <div id="ocnds-equipe-container">
        ${renderOcNdsEquipeSelects(item)}
      </div>
      <button type="button" class="btn btn-sm btn-ghost" id="ocnds-add-equipe" style="margin-top:6px;">${icon('plus',13)} Adicionar equipe</button>
    </div>

    <div class="field"><label>Observações</label><textarea name="observacoes" rows="3" placeholder="Observações gerais...">${esc(item?.observacoes||'')}</textarea></div>

    <div class="field"><label>Anexos do escritório</label>
      <input type="file" id="ocnds-anexos-input" accept="image/*" multiple>
      <div class="field-hint">💡 Imagens para a equipe visualizar em campo (croqui, localização, detalhe do serviço). Máximo 4 anexos.</div>
      <div id="ocnds-anexos-preview">${anexosGridHtml(item?.anexos, true)}</div>
      <div id="ocnds-anexos-progress" style="display:none;margin-top:8px;">
        <div id="ocnds-anexos-progress-text" style="font-size:11px;color:var(--muted);margin-bottom:4px;">Enviando…</div>
        <div style="height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div id="ocnds-anexos-progress-fill" style="height:100%;width:0%;background:var(--accent);transition:width .2s;"></div></div>
      </div>
    </div>
  `;

  openModal({
    title: item ? 'Editar ocorrência' : 'Nova ocorrência OC/NDS',
    bodyHtml: body,
    wide: true,
    submitLabel: item ? 'Salvar alterações' : 'Despachar',
    onMount: (root) => {
      const tipoSelect = root.querySelector('#ocnds-tipo');
      const camposOC = root.querySelector('#ocnds-campos-oc');
      const camposNDS = root.querySelector('#ocnds-campos-nds');
      tipoSelect.addEventListener('change', ()=>{
        if(tipoSelect.value==='OC'){
          camposOC.style.display='block';
          camposNDS.style.display='none';
        } else {
          camposOC.style.display='none';
          camposNDS.style.display='block';
        }
      });
      root.querySelector('#ocnds-add-equipe').addEventListener('click', ()=>{
        const container = root.querySelector('#ocnds-equipe-container');
        const idx = container.querySelectorAll('.ocnds-equipe-row').length;
        const div = document.createElement('div');
        div.className = 'ocnds-equipe-row field-row';
        div.style.marginBottom = '8px';
        div.innerHTML = `
          <div class="field" style="flex:1;">
            <select name="equipeId_${idx}" class="ocnds-equipe-select">
              <option value="">Selecione a equipe…</option>
              ${equipesVisiveis().map(e=>`<option value="${e.id}">${equipeLabel(e)}${e.encarregado? ' · '+esc(e.encarregado):''}</option>`).join('')}
            </select>
          </div>
          <button type="button" class="icon-btn" onclick="this.closest('.ocnds-equipe-row').remove()">${icon('trash',14)}</button>
        `;
        container.appendChild(div);
      });
      let ocndsAnexosEnviando = false;
      const anexosList = item ? (item.anexos||[]).map(a=>({...a})) : [];
      window._ocndsAnexos = anexosList;
      const ocndsPreview = root.querySelector('#ocnds-anexos-preview');
      const ocndsInput = root.querySelector('#ocnds-anexos-input');
      const ocndsProgress = root.querySelector('#ocnds-anexos-progress');
      const ocndsProgressText = root.querySelector('#ocnds-anexos-progress-text');
      const ocndsProgressFill = root.querySelector('#ocnds-anexos-progress-fill');
      function paintOcndsAnexos(){
        ocndsPreview.innerHTML = anexosGridHtml(anexosList, true);
        ocndsPreview.querySelectorAll('.anexo-remove').forEach(b=>b.addEventListener('click', ()=>{
          anexosList.splice(Number(b.dataset.i),1); paintOcndsAnexos();
        }));
      }
      ocndsInput.addEventListener('change', async ()=>{
        const files = Array.from(ocndsInput.files||[]);
        if(!files.length) return;
        const sobra = Math.max(0, 4 - anexosList.length);
        const fila = files.slice(0, sobra);
        if(files.length > sobra) toast('Máximo de 4 anexos por ocorrência.', 'error');
        if(!fila.length){ ocndsInput.value=''; return; }
        ocndsInput.disabled = true;
        ocndsAnexosEnviando = true;
        const total = fila.length;
        let feitos = 0;
        const atualizar = ()=>{
          ocndsProgressFill.style.width = Math.round(feitos/total*100)+'%';
          ocndsProgressText.textContent = total>1? `Enviando ${Math.min(feitos+1,total)} de ${total}…` : 'Enviando…';
        };
        ocndsProgress.style.display = 'block';
        paintOcndsAnexos();
        for(const f of fila){
          try{
            const blob = await comprimirImagem(f);
            const url = await uploadToImgbb(blob);
            anexosList.push({url, nome: f.name});
          }catch(e){ console.error('Falha upload anexo OC/NDS:', e); toast('Falha ao enviar "'+f.name+'": '+e.message, 'error'); }
          feitos++; atualizar(); paintOcndsAnexos();
        }
        ocndsAnexosEnviando = false;
        ocndsInput.disabled = false;
        ocndsInput.value = '';
        ocndsProgress.style.display = 'none';
        window._ocndsAnexos = anexosList;
      });
      paintOcndsAnexos();
    },
    onSubmit: (fd) => {
      const tipo = fd.get('tipo');
      const data = fd.get('data');
      const observacoes = fd.get('observacoes').trim();
      const setor = isRestricted ? userSetor : fd.get('setor');
      const coordenacao = isRestricted ? userCoord : fd.get('coordenacao');

      if(!setor || !coordenacao){ toast('Informe o setor e a coordenação.', 'error'); return false; }
      if(!data){ toast('Informe a data.', 'error'); return false; }

      if(tipo==='OC'){
        const ocorr = fd.get('ocorrencia');
      } else {
        const ocorr = fd.get('ocorrencia');
        if(!ocorr || !ocorr.trim()){ toast('Informe o número da ocorrência.', 'error'); return false; }
      }

      const equipeRows = document.querySelectorAll('.ocnds-equipe-select');
      const equipeIds = [];
      equipeRows.forEach(sel=>{
        if(sel.value) equipeIds.push(Number(sel.value));
      });
      if(!equipeIds.length){ toast('Selecione ao menos uma equipe.', 'error'); return false; }

      if(item){
        item.tipo = tipo;
        item.setor = setor;
        item.coordenacao = coordenacao;
        item.ptp = fd.get('ptp').trim();
        item.si = fd.get('si').trim();
        item.ose = fd.get('ose').trim();
        item.ocorrencia = fd.get('ocorrencia')?.trim()||'';
        item.data = data;
        item.observacoes = observacoes;
        item.equipeId = equipeIds[0];
        item.equipeIds = equipeIds;
        item.anexos = (window._ocndsAnexos||[]).slice();
        item.historico = item.historico||[];
        item.historico.push({...currentAutor(), ts:Date.now(), tipo:'edicao', de:null, para:item.status, motivo:'Ocorrência editada'});
        toast('Ocorrência atualizada.');
        registrarEvento('edicao','ocnds',item.id,item.gid||'OC/NDS #'+item.id,'Editada');
      } else {
        for(const eqId of equipeIds){
          const novo = {
            id: nextId(),
            gid: novoGid(),
            tipo,
            setor,
            coordenacao,
            ptp: fd.get('ptp').trim(),
            si: fd.get('si').trim(),
            ose: fd.get('ose').trim(),
            ocorrencia: fd.get('ocorrencia')?.trim()||'',
            data,
            equipeId: eqId,
            observacoes,
            anexos: (window._ocndsAnexos||[]).slice(),
            status: 'Despachada',
            numeroOC: '',
            atividades: [],
            rdoRespostas: {},
            historico:[{...currentAutor(), ts:Date.now(), tipo:'criacao', de:null, para:'Despachada', motivo:'Ocorrência despachada para equipe'}]
          };
          DB.ocnds = DB.ocnds||[];
          DB.ocnds.push(novo);
          registrarEvento('criacao','ocnds',novo.id,novo.gid,'OC/NDS '+tipo+' · Equipe '+equipeLabel(findEquipe(eqId)));
        }
        toast(equipeIds.length>1? equipeIds.length+' ocorrências despachadas.' : 'Ocorrência despachada.');
      }

      saveData(); renderContent();
    }
  });
}

function renderOcNdsEquipeSelects(item){
  const equipes = item ? [item.equipeId] : [''];
  return equipes.map((eqId, i)=>`
    <div class="ocnds-equipe-row field-row" style="margin-bottom:8px;">
      <div class="field" style="flex:1;">
        <select name="equipeId_${i}" class="ocnds-equipe-select">
          <option value="">Selecione a equipe…</option>
          ${equipesVisiveis().map(e=>`<option value="${e.id}" ${String(eqId)===String(e.id)?'selected':''}>${equipeLabel(e)}${e.encarregado? ' · '+esc(e.encarregado):''}</option>`).join('')}
        </select>
      </div>
      ${(!item || equipes.length>1)? `<button type="button" class="icon-btn" onclick="this.closest('.ocnds-equipe-row').remove()">${icon('trash',14)}</button>` : ''}
    </div>
  `).join('');
}

function openOcNdsDetalhe(id){
  const x = (DB.ocnds||[]).find(y=>y.id===Number(id));
  if(!x) return;
  const eq = findEquipe(x.equipeId);
  const stColor = STATUS_OC_NDS_COLOR[x.status]||'var(--muted)';
  const isOC = x.tipo==='OC';

  const detalhesHtml = isOC ? `
    <div class="dtl-grid">
      <div class="dtl-tile"><div class="dtl-tile-lbl">Setor</div><div class="dtl-tile-val">${esc(x.setor||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Coordenação</div><div class="dtl-tile-val">${esc(x.coordenacao||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Tipo</div><div class="dtl-tile-val"><span class="badge" style="color:var(--blue);background:rgba(78,140,235,.14);">OC</span></div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">PTP</div><div class="dtl-tile-val mono">${esc(x.ptp||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">SI</div><div class="dtl-tile-val mono">${esc(x.si||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">OSE</div><div class="dtl-tile-val mono">${esc(x.ose||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Nº OC (equipe)</div><div class="dtl-tile-val mono">${esc(x.numeroOC||'Aguardando…')}</div></div>
    </div>` : `
    <div class="dtl-grid">
      <div class="dtl-tile"><div class="dtl-tile-lbl">Setor</div><div class="dtl-tile-val">${esc(x.setor||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Coordenação</div><div class="dtl-tile-val">${esc(x.coordenacao||'—')}</div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Tipo</div><div class="dtl-tile-val"><span class="badge" style="color:var(--accent);background:rgba(224,164,88,.14);">NDS</span></div></div>
      <div class="dtl-tile"><div class="dtl-tile-lbl">Ocorrência</div><div class="dtl-tile-val mono">${esc(x.ocorrencia||'—')}</div></div>
    </div>`;

  const historicoHtml = (x.historico||[]).length ? `
    <div class="dtl-section">
      <div class="dtl-section-head"><h4>Histórico</h4><span class="mono">${x.historico.length} evento(s)</span></div>
      <div style="padding:12px;display:flex;flex-direction:column;gap:8px;">
        ${x.historico.slice().reverse().map(h=>`
          <div style="display:flex;gap:10px;align-items:flex-start;font-size:12px;">
            <div style="width:8px;height:8px;border-radius:50%;background:${STATUS_OC_NDS_COLOR[h.para]||'var(--muted)'};flex-shrink:0;margin-top:4px;"></div>
            <div>
              <div><strong>${esc(h.usuarioNome||'Sistema')}</strong> · ${fmtDateTime(h.ts)}</div>
              <div style="color:var(--muted);">${esc(h.motivo||h.tipo||'')}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>` : '';

  const body = `
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="dtl-header">
        <div style="min-width:0;">
          <div class="dtl-code">${esc(x.gid||'G26-'+String(x.id).padStart(7,'0'))}</div>
          <div class="dtl-title">Ocorrência ${esc(x.tipo)}</div>
          <div class="dtl-meta">
            <span>${icon('calendar',12)} ${fmtDate(x.data)}</span>
            <span>${icon('users',12)} ${esc(equipeLabel(eq))}</span>
          </div>
        </div>
        <div><span class="badge" style="color:${stColor};background:${bgFromVar(stColor)};font-size:13px;padding:6px 14px;"><span class="badge-dot"></span>${esc(x.status)}</span></div>
      </div>

      <div class="dtl-tile" style="grid-column:1/-1;"><div class="dtl-tile-lbl">Equipe</div><div class="dtl-tile-val"><span class="badge-prefix">${esc(equipeLabel(eq))}</span><div class="admin-field-meta" style="margin-top:4px;">Supervisor: ${esc(eq?.supervisor||'—')} · Encarregado: ${esc(eq?.encarregado||'—')}</div></div></div>

      ${detalhesHtml}

      ${x.observacoes? `<div class="dtl-section"><div class="dtl-section-head"><h4>Observações</h4></div><div style="padding:12px;white-space:pre-wrap;">${esc(x.observacoes)}</div></div>` : ''}

      ${anexosDisplayHtml(x.anexos)}

      ${x.observacaoEquipe? `<div class="dtl-section"><div class="dtl-section-head"><h4>Observação da equipe</h4></div><div style="padding:12px;white-space:pre-wrap;">${esc(x.observacaoEquipe)}</div></div>` : ''}

      ${(x.atividades||[]).some(a=>a.fotos)? `
      <div class="dtl-section">
        <div class="dtl-section-head"><h4>Fotos das atividades</h4><span class="mono">${(x.atividades||[]).reduce((n,a)=>n+(a.fotos?a.fotos.split(';;').filter(Boolean).length:0),0)} foto(s)</span></div>
        <div style="padding:12px;display:flex;gap:8px;flex-wrap:wrap;">
          ${(()=>{
            const todasFotos = (x.atividades||[]).flatMap(a=>String(a.fotos||'').split(';;').filter(Boolean));
            return todasFotos.map((url,fi)=>`<div class="dtl-exec-foto" data-fotos='${esc(JSON.stringify(todasFotos))}' data-idx="${fi}" style="width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--border);cursor:zoom-in;flex-shrink:0;"><img src="${esc(url)}" alt="Foto ${fi+1}" style="width:100%;height:100%;object-fit:cover;"></div>`).join('');
          })()}
        </div>
      </div>` : ''}

      ${(x.rdoRespostas&&Object.keys(x.rdoRespostas).length)? `
      <div class="dtl-section">
        <div class="dtl-section-head"><h4>Questionário RDO respondido</h4></div>
        <div style="padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${Object.entries(x.rdoRespostas).map(([k,v])=>`<div class="dtl-tile"><div class="dtl-tile-lbl">${esc(k)}</div><div class="dtl-tile-val" style="font-size:13px;">${esc(String(v))}</div></div>`).join('')}
        </div>
      </div>` : ''}

      ${historicoHtml}

      ${x.status!=='Concluída'? `
      <div class="dtl-actions">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="dtl-actions-lbl">Alterar status:</span>
          ${STATUS_OC_NDS.filter(s=>s!==x.status).map(s=>`<button type="button" class="btn btn-sm" data-ocnds-set-status="${x.id}|${s}">→ ${s}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm" data-ocnds-edit-detail="${x.id}">${icon('edit',13)} Editar</button>
          <button type="button" class="btn btn-sm" data-ocnds-hist-detail="${x.id}">${icon('history',13)} Histórico</button>
        </div>
      </div>` : `<div class="dtl-actions"><div style="font-size:13px;color:var(--green);font-weight:600;">${icon('check',14)} Ocorrência concluída e registrada no RDO.</div></div>`}
    </div>`;

  openModal({
    title: 'Detalhe da ocorrência',
    bodyHtml: body,
    wide: true,
    submitLabel: 'Fechar',
    onSubmit: ()=>{},
    onMount: (root) => {
      root.querySelectorAll('[data-ocnds-set-status]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const [itemId, novoStatus] = btn.dataset.ocndsSetStatus.split('|');
          alterarStatusOcNds(Number(itemId), novoStatus);
        });
      });
      root.querySelectorAll('[data-ocnds-edit-detail]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          openOcNdsModal(Number(btn.dataset.ocndsEditDetail));
        });
      });
      root.querySelectorAll('.dtl-exec-foto').forEach(div=>{
        div.addEventListener('click', ()=>{
          try{ openLightbox(JSON.parse(div.dataset.fotos), Number(div.dataset.idx)); }catch(e){}
        });
      });
    }
  });
}

function alterarStatusOcNds(id, novoStatus){
  if(!requerEscrita()) return;
  const x = (DB.ocnds||[]).find(y=>y.id===Number(id));
  if(!x) return;
  const antigo = x.status;
  x.status = novoStatus;
  x.historico = x.historico||[];
  x.historico.push({...currentAutor(), ts:Date.now(), tipo:'status', de:antigo, para:novoStatus, motivo:`Status alterado de "${antigo}" para "${novoStatus}"`});
  registrarEvento('status','ocnds',x.id,x.gid||'OC/NDS #'+x.id, antigo+' → '+novoStatus);
  saveData(); renderContent();
  toast('Status alterado para "'+novoStatus+'".');
  openOcNdsDetalhe(id);
}

function deletarOcNds(id){
  if(!requerEscrita()) return;
  const x = (DB.ocnds||[]).find(y=>y.id===Number(id));
  if(!x) return;
  if(x.status==='Concluída'){ toast('Não é possível excluir uma ocorrência concluída.', 'error'); return; }
  if(!confirm('Excluir esta ocorrência?')) return;
  DB.ocnds = (DB.ocnds||[]).filter(y=>y.id!==id);
  registrarEvento('exclusao','ocnds',id,x.gid||'OC/NDS #'+id,'Excluída');
  saveData(); renderContent();
  toast('Ocorrência excluída.');
}

function encaminharWhatsOcNds(id){
  const x = (DB.ocnds||[]).find(y=>y.id===Number(id));
  if(!x) return;
  const eq = findEquipe(x.equipeId);
  if(!eq || !eq.whatsapp){ toast('Equipe sem WhatsApp cadastrado.', 'error'); return; }
  const link = equipePageUrlOcNds(x.id);
  const detalhes = x.tipo==='OC'
    ? `PTP: ${x.ptp||'—'} | SI: ${x.si||'—'} | OSE: ${x.ose||'—'}`
    : `Ocorrência: ${x.ocorrencia||'—'}`;
  const texto = `🔔 *OC/NDS ${x.tipo} — ${x.gid||'G26-'+String(x.id).padStart(7,'0')}*\n\nSetor: ${x.setor||'—'}\nCoordenação: ${x.coordenacao||'—'}\nStatus: ${x.status}\nData: ${fmtDate(x.data)}\n${detalhes}\n\nAcesse os detalhes e preencha as informações:\n${link}`;
  window.open(waLink(eq.whatsapp, texto), '_blank');
}

function equipePageUrlOcNds(id){
  let base = location.href.split(/[?#]/)[0];
  base = base.replace(/[\\/]index\.html$/i, '');
  if(base && !base.endsWith('/')) base += '/';
  return base + 'team.html?ocnds=' + id;
}

function ocndsVisiveis(){
  return (DB.ocnds||[]).filter(x=> !usuarioRestrito() || mesmoDominio(x));
}

function flatOcNds(){
  return ocndsVisiveis().map(x=>({
    ocnds: x,
    equipe: findEquipe(x.equipeId),
    status: x.status,
    isRdo: x.status==='Concluída'
  }));
}
function renderMedição(){
  renderModuloEmDesenvolvimento('Medição');
}
function renderMediçãoProjetos(){
  renderModuloEmDesenvolvimento('Medição – Projetos');
}
function renderMediçãoOC(){
  renderModuloEmDesenvolvimento('Medição – OC');
}
function renderMediçãoNDSOSE(){
  renderModuloEmDesenvolvimento('Medição – NDS/OSE');
}
function renderMediçãoPoda(){
  renderModuloEmDesenvolvimento('Medição – PODA');
}
function renderModuloEmDesenvolvimento(titulo){
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="panel" style="max-width:720px;margin:24px auto;">
      <div style="display:flex;align-items:center;gap:14px;padding:28px;">
        <div style="flex-shrink:0;width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;color:var(--accent);background:rgba(224,164,88,.12);">${icon('layers',26)}</div>
        <div>
          <h3 style="margin:0 0 6px;">${titulo}</h3>
          <div style="font-size:13px;line-height:1.7;color:var(--muted);">Módulo de atividade não programada ou de programação comercial em desenvolvimento...</div>
        </div>
      </div>
    </div>`;
}

/* =========================================================
   SEED
========================================================= */
function seedIfEmpty(){
  if(DB.equipes.length || DB.atividades.length || DB.projetos.length) return;
  DB.usuarios = DB.usuarios||[];
  DB.usuarios.push({id:nextId(), nome:'Mestre', login:'1', senha:'1', role:'administrador', nivel:'total', ativo:true});
  const eq1 = {id:nextId(), eqtl:'Equipe Alfa', prtn:'', setor:'MANUTENÇÃO', coordenacao:'RIO VERDE', supervisor:'Marcos Lima', encarregado:'José Ferreira', motorista:'Paulo Souza', metaDiaria:5000, eletricistas:['Carlos Alves','Renato Dias'], ativo:true, custom:{}};
  const eq2 = {id:nextId(), eqtl:'', prtn:'Equipe Bravo', setor:'MANUTENÇÃO', coordenacao:'RIO VERDE', supervisor:'Ana Ribeiro', encarregado:'Bruno Castro', motorista:'Diego Nunes', metaDiaria:3000, eletricistas:['Felipe Rocha'], ativo:true, custom:{}};
  DB.equipes.push(eq1, eq2);
  const a1 = {id:nextId(), codigo:'MAN-014', descricao:'Substituição de poste de concreto', unidade:'un', valorUnitario:850, custom:{}};
  const a2 = {id:nextId(), codigo:'MAN-022', descricao:'Poda de árvore próxima à rede', unidade:'un', valorUnitario:180, custom:{}};
  const a3 = {id:nextId(), codigo:'CON-005', descricao:'Instalação de rede de baixa tensão', unidade:'m', valorUnitario:42.5, custom:{}};
  DB.atividades.push(a1,a2,a3);
  const p1 = {id:nextId(), codigo:'PRJ-2026-01', nome:'Manutenção preventiva - Setor Leste', descricao:'Ronda de manutenção preventiva na rede do setor leste.', dataInicio:todayISO(), dataFim:'', dataRecebimentoCarteira:shiftISO(todayISO(), -10), dataVencimento:shiftISO(todayISO(), 60), dataViabilizacao:'', setor:'MANUTENÇÃO', coordenacao:'RIO VERDE', cidade:'Rio Verde', status:'Em Andamento', valorOrcado:60000, ciclo:'CICLO-01/2026', planoFisico:[{atividadeId:a1.id, quantidade:6},{atividadeId:a2.id, quantidade:12},{atividadeId:a3.id, quantidade:150}], custom:{}};
  DB.projetos.push(p1);
  const prog1 = { id:nextId(), projetoId:p1.id, dataProgramada:todayISO(), ciclo:'CICLO-01/2026', observacoes:'', custom:{},
    atribuicoes:[
      { id:nextId(), equipeId:eq1.id, dataProgramada:todayISO(), status:'Programado', atividades:[{atividadeId:a1.id, quantidadePrevista:3, quantidadeExecutada:null}], historico:[{...currentAutor(), usuarioNome:'Sistema', usuarioLogin:'', ts:Date.now(), tipo:'criacao', de:null, para:'Programado', motivo:'Programação criada (exemplo)'}] },
      { id:nextId(), equipeId:eq2.id, dataProgramada:todayISO(), status:'Programado', atividades:[{atividadeId:a2.id, quantidadePrevista:8, quantidadeExecutada:null},{atividadeId:a3.id, quantidadePrevista:120, quantidadeExecutada:null}], historico:[{...currentAutor(), usuarioNome:'Sistema', usuarioLogin:'', ts:Date.now(), tipo:'criacao', de:null, para:'Programado', motivo:'Programação criada (exemplo)'}] }
    ]};
  DB.programacoes.push(prog1);
  migrarGids();
  saveData();
}

/* =========================================================
   AUTENTICAÇÃO / LOGIN
========================================================= */
function garantirMaster(){
  DB.usuarios = DB.usuarios||[];
  if(!DB.usuarios.some(u=> String(u.login)==='1' && String(u.senha)==='1')){
  DB.usuarios.push({id:nextId(), nome:'Mestre', login:'1', senha:'1', role:'administrador', nivel:'total', ativo:true, permissoes:{}});
    saveData();
  }
}
function ehMestre(){ return !!(CURRENT_USER && String(CURRENT_USER.login)==='1'); }
function usuarioRestrito(){ return !!(CURRENT_USER && ((CURRENT_USER.setor||'').trim() || (CURRENT_USER.coordenacao||'').trim())); }
function mesmoDominio(x){
  if(!usuarioRestrito()) return true;
  const us=String(CURRENT_USER.setor||'').trim(), uc=String(CURRENT_USER.coordenacao||'').trim();
  const xs=String((x&&x.setor)||'').trim(), xc=String((x&&x.coordenacao)||'').trim();
  if(us && xs!==us) return false;
  if(uc && xc!==uc) return false;
  return true;
}
function projetoVisivel(p){ return mesmoDominio(p); }
function projetosVisiveis(){ return DB.projetos.filter(projetoVisivel); }
function programacoesVisiveis(){ const vis = projetosVisiveis().map(p=>p.id); return DB.programacoes.filter(pg=> vis.includes(pg.projetoId)); }
function progVisivelPorId(id){ const pg=DB.programacoes.find(p=>p.id===Number(id)); return !!pg && programacoesVisiveis().some(v=>v.id===pg.id); }
function equipesVisiveis(){ return DB.equipes.filter(e=> mesmoDominio(e)); }
function equipesDoProjeto(pr){
  if(!pr || !pr.setor || !pr.coordenacao) return equipesVisiveis();
  return equipesVisiveis().filter(e=> !e.setor || !e.coordenacao || (e.setor===pr.setor && e.coordenacao===pr.coordenacao));
}
function novoGid(){ return 'G26-' + String(Math.floor(1000000 + Math.random()*9000000)); }
function progGid(pg){ return (pg && pg.gid) || (pg? 'G26-'+String(pg.id).padStart(7,'0') : ''); }

/* =========================================================
   MONITORAMENTO — auditoria (passado) + presença (presente)
========================================================= */
const MON_TIPOS = {
  login:{l:'Login',c:'var(--blue)'},
  logout:{l:'Logout',c:'var(--muted)'},
  criacao:{l:'Criação',c:'var(--green)'},
  edicao:{l:'Edição',c:'var(--accent)'},
  exclusao:{l:'Exclusão',c:'var(--red)'},
  status:{l:'Status',c:'var(--purple)'},
  reprogramacao:{l:'Reprogramação',c:'var(--red)'},
  rdo:{l:'RDO',c:'var(--teal)'},
  compartilhamento:{l:'Compartilhamento',c:'var(--green)'},
  config:{l:'Configuração',c:'var(--muted)'}
};
const MON_ITEMTIPOS = {
  programacao:'Programação', atribuicao:'Equipe/atividade', equipe:'Equipe', projeto:'Projeto', atividade:'Atividade', usuario:'Usuário', sistema:'Sistema'
};
let monPresenca = {};
let monPresList = [];
let monHeartbeat = null;
function registrarEvento(tipo, itemTipo, itemId, itemRotulo, detalhe){
  if(!CURRENT_USER || !tipo) return;
  DB.auditoria = Array.isArray(DB.auditoria)? DB.auditoria : [];
  const ev = {
    id: nextId(), ts: Date.now(), user: CURRENT_USER.login, nome: CURRENT_USER.nome,
    tipo, itemTipo, itemId: itemId!=null? itemId : null,
    itemRotulo: String(itemRotulo||'').slice(0,120),
    detalhe: String(detalhe||'').slice(0,400),
    bytes: Math.round(JSON.stringify(DB).length/1024)
  };
  DB.auditoria.push(ev);
  if(!audCarregado) audPendentes.push(ev);
  if(DB.auditoria.length > 4000) DB.auditoria = DB.auditoria.slice(-4000);
  agendarAuditoriaSave();
}
let audSaveTimer = null;
let audCarregado = false;
let audPendentes = [];
function agendarAuditoriaSave(){
  clearTimeout(audSaveTimer);
  audSaveTimer = setTimeout(()=>{
    if(!audCarregado){ agendarAuditoriaSave(); return; }
    try{ AUD_REF.set(DB.auditoria||[]); }catch(e){}
  }, 1500);
}
/* Auditoria em nó próprio (fora do blob principal) para não regravar
   nem redistribuir todos os dados a cada evento. Migra o legado sozinho. */
AUD_REF.once('value', ()=>{ audCarregado=true; }, ()=>{ audCarregado=true; });
AUD_REF.on('value', snap=>{
  let remota = snap.exists()? (snap.val()||[]) : [];
  const local = Array.isArray(DB.auditoria)? DB.auditoria : [];
  if(audPendentes.length){
    const ids = new Set(remota.map(e=>String(e.id)));
    const faltantes = audPendentes.filter(e=>!ids.has(String(e.id)));
    audPendentes = [];
    if(faltantes.length){
      remota = remota.concat(faltantes);
      try{ AUD_REF.set(remota); }catch(e){}
    }
  }
  const maiorLocal = (legacyAuditoria && legacyAuditoria.length>local.length)? legacyAuditoria : local;
  if(maiorLocal.length > remota.length){
    try{ AUD_REF.set(maiorLocal); }catch(e){}
    DB.auditoria = maiorLocal;
    return;
  }
  legacyAuditoria = null;
  if(remota.length) DB.auditoria = remota;
  else delete DB.auditoria;
});
function fmtRelTempo(ts){
  if(!ts) return '—';
  const s = Math.max(0, Math.round((Date.now()-ts)/1000));
  if(s<60) return s+'s';
  if(s<3600) return Math.floor(s/60)+'min';
  if(s<86400) return Math.floor(s/3600)+'h';
  return Math.floor(s/86400)+'d';
}
function monViewLabel(v){ return (NAV_ITEMS.find(i=>i.id===v)?.label)||v||'—'; }
function monKey(login){ return String(login||'anon').replace(/[.#$\[\]]/g,'_'); }
function fmtTs(ts){ const d=new Date(ts); return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function fmtBytes(b){ if(b==null) return '—'; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(2)+' MB'; }
function monOnline(p){ return p && p.ts && (Date.now()-p.ts) < 45000; }
function monEventBadge(tipo){ const t=MON_TIPOS[tipo]||{l:tipo,c:'var(--muted)'}; return `<span class="mon-badge" style="color:${t.c};border-color:${t.c};">${t.l}</span>`; }
function monItemLabel(tipo,id){
  id = Number(id);
  if(tipo==='programacao'){ const p=DB.programacoes.find(x=>x.id===id); return p? progGid(p):'Programação #'+id; }
  if(tipo==='equipe'){ const e=findEquipe(id); return e? (e.eqtl||e.prtn||'Equipe'):'Equipe #'+id; }
  if(tipo==='atividade'){ const a=findAtividade(id); return a? a.codigo+' · '+a.descricao:'Atividade #'+id; }
  if(tipo==='projeto'){ const p=findProjeto(id); return p? p.codigo+' · '+p.nome:'Projeto #'+id; }
  if(tipo==='usuario'){ const u=(DB.usuarios||[]).find(x=>x.id===id); return u? u.nome+' ('+u.login+')':'Usuário #'+id; }
  if(tipo==='atribuicao'){
    const pg=progDaAtribuicao(id); const at=findAtribuicaoGlobal(id);
    return (pg? progGid(pg)+' · ':'')+(at? equipeLabel(findEquipe(at.equipeId)):'Atribuição #'+id);
  }
  return String(id);
}
let adminMonTab = 'aovivo';
function monCards(){
  const onlineUsers = monPresList.filter(p=> !String(p.login||'').startsWith('equipe-') && monOnline(p));
  const onlineTeams = monPresList.filter(p=> String(p.login||'').startsWith('equipe-') && monOnline(p));
  const hoje = todayISO();
  const acoesHoje = (DB.auditoria||[]).filter(e=> e.ts && new Date(e.ts).toISOString().slice(0,10)===hoje).length;
  const bytes = JSON.stringify(DB).length;
  return `
    <div class="mon-cards">
      <div class="mon-card"><div class="mon-card-v">${onlineUsers.length}</div><div class="mon-card-l">usuários online</div></div>
      <div class="mon-card"><div class="mon-card-v">${onlineTeams.length}</div><div class="mon-card-l">equipes online (página da equipe)</div></div>
      <div class="mon-card"><div class="mon-card-v">${acoesHoje}</div><div class="mon-card-l">ações registradas hoje</div></div>
      <div class="mon-card"><div class="mon-card-v">${(DB.auditoria||[]).length}</div><div class="mon-card-l">total de registros de auditoria</div></div>
      <div class="mon-card"><div class="mon-card-v">${fmtBytes(bytes)}</div><div class="mon-card-l">tamanho atual do banco</div></div>
    </div>`;
}
function monPanelHtml(){
  return `
  <div class="panel mon-panel">
    <div class="panel-head">
      <div><h3>${icon('pulse',15)} Central de Monitoramento</h3><div class="admin-field-meta">Comunicação em tempo real: ações, tráfego, consumo e quem está online agora. O feed atualiza automaticamente a cada alteração no banco.</div></div>
      <span class="mon-live"><span class="mon-live-dot"></span> AO VIVO</span>
    </div>
    ${monCards()}
    <div class="mon-tabs">
      <button class="mon-tab ${adminMonTab==='aovivo'?'active':''}" data-montab="aovivo">${icon('clock',13)} Ao vivo</button>
      <button class="mon-tab ${adminMonTab==='usuarios'?'active':''}" data-montab="usuarios">${icon('users',13)} Usuários online</button>
      <button class="mon-tab ${adminMonTab==='consumo'?'active':''}" data-montab="consumo">${icon('database',13)} Consumo e tráfego</button>
      <button class="mon-tab ${adminMonTab==='rastrear'?'active':''}" data-montab="rastrear">${icon('search',13)} Rastrear item</button>
    </div>
    <div id="mon-body"></div>
  </div>`;
}
function monBodyHtml(){
  if(adminMonTab==='aovivo') return monAoVivoHtml();
  if(adminMonTab==='usuarios') return monUsuariosHtml();
  if(adminMonTab==='consumo') return monConsumoHtml();
  return monRastrearHtml();
}
function monAoVivoHtml(){
  const evs = [...(DB.auditoria||[])].sort((a,b)=>b.ts-a.ts).slice(0,40);
  if(!evs.length) return `<div class="mon-empty">Nenhum evento registrado ainda. As ações passam a aparecer aqui em tempo real.</div>`;
  return `<div class="mon-feed">${evs.map(e=>`
    <div class="mon-ev" data-rastrear-tipo="${e.itemTipo||''}" data-rastrear-id="${e.itemId??''}" ${e.itemId!=null?'style="cursor:pointer;"':''}>
      <span class="mon-ev-time">${fmtTs(e.ts)}</span>
      ${monEventBadge(e.tipo)}
      <span class="mon-ev-who">${esc(e.nome||e.user||'?')}</span>
      <span class="mon-ev-item">${esc(monItemLabel(e.itemTipo,e.itemId))}</span>
      <span class="mon-ev-det">${esc(e.detalhe||'')}</span>
    </div>`).join('')}</div>`;
}
function monUsuariosHtml(){
  const rows = monPresList.slice(0,30);
  if(!rows.length) return `<div class="mon-empty">Ninguém está conectado no momento.</div>`;
  return `<table class="mon-table"><thead><tr><th>Usuário</th><th>Papel</th><th>Onde está</th><th>Situação</th></tr></thead><tbody>${rows.map(p=>{
    const online = monOnline(p);
    const isTeam = String(p.login||'').startsWith('equipe-');
    const view = isTeam? 'Página da equipe' : monViewLabel(p.view);
    return `<tr>
      <td><span class="mon-online-dot ${online?'on':''}"></span> ${esc(p.nome||p.login||p.key)}${isTeam? ' <span class="mon-badge" style="color:var(--teal);border-color:var(--teal);">equipe</span>':''}</td>
      <td>${esc(p.role||'—')}</td>
      <td>${esc(isTeam? 'Página da equipe' : view)}</td>
      <td>${online? '<span class="mon-online-txt">Online agora</span>':'visto há '+fmtRelTempo(p.ts)}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}
function monConsumoHtml(){
  const evs = DB.auditoria||[];
  const porUsuario = {};
  evs.forEach(e=>{
    porUsuario[e.login||'?'] = porUsuario[e.login||'?']||{nome:e.nome||e.login||'?', n:0, bytes:0, ts:0};
    porUsuario[e.login||'?'].n++;
    porUsuario[e.login||'?'].bytes += e.bytes||0;
    if((e.ts||0)>porUsuario[e.login||'?'].ts) porUsuario[e.login||'?'].ts=e.ts;
  });
  const porTipo = {};
  evs.forEach(e=>{ porTipo[e.tipo]= (porTipo[e.tipo]||0)+1; });
  const usersSorted = Object.keys(porUsuario).sort((a,b)=>porUsuario[b].bytes-porUsuario[a].bytes);
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div>
        <h4 style="margin:0 0 10px;font-size:13px;">Tráfego estimado por usuário (últimas ações)</h4>
        <table class="mon-table"><thead><tr><th>Usuário</th><th>Ações</th><th>Dados gravados</th><th>Última ação</th></tr></thead><tbody>${usersSorted.slice(0,15).map(u=>`<tr><td>${esc(porUsuario[u].nome)}</td><td>${porUsuario[u].n}</td><td>${fmtBytes(porUsuario[u].bytes)}</td><td>${fmtRelTempo(porUsuario[u].ts)}</td></tr>`).join('')||'<tr><td colspan="4">Sem registros.</td></tr>'}</tbody></table>
      </div>
      <div>
        <h4 style="margin:0 0 10px;font-size:13px;">Atividades por tipo de ação</h4>
        <div class="mon-feed">${Object.keys(porTipo).map(t=>`<div class="mon-ev">${monEventBadge(t)}<span class="mon-ev-item">${porTipo[t]} evento(s)</span><span class="mon-ev-det">${esc(MON_TIPOS[t]?.l||t)}</span></div>`).join('')||'<div class="mon-empty">Sem registros.</div>'}</div>
      </div>
    </div>`;
}
function monRastrearHtml(){
  const opt = t=>`<option value="${t}">${MON_ITEMTIPOS[t]}</option>`;
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <div class="field" style="flex:1;min-width:220px;"><label>Buscar item</label><input type="text" id="mon-rastrear-q" placeholder="Código, nome, GID, equipe, projeto, usuário…"></div>
      <div class="field" style="min-width:170px;"><label>Tipo</label><select id="mon-rastrear-tipo"><option value="">Todos os tipos</option>${opt('programacao')}${opt('atribuicao')}${opt('equipe')}${opt('projeto')}${opt('atividade')}${opt('usuario')}</select></div>
    </div>
    <div id="mon-rastrear-res" style="margin-top:14px;"></div>`;
}
function monRastrearBusca(q, tipo){
  q = (q||'').toLowerCase().trim();
  const res = [];
  if((!tipo||tipo==='programacao')) programacoesVisiveis().forEach(p=>{ const pr=findProjeto(p.projetoId); const hay=(progGid(p)+' '+(pr?.nome||'')+' '+(pr?.codigo||'')).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'programacao',id:p.id,lbl:progGid(p)+' · '+(pr?.codigo||'')+' '+(pr?.nome||'')}); });
  if(!tipo||tipo==='atribuicao') flatAtribuicoes().forEach(x=>{ const at=x.atribuicao; const pg=progDaAtribuicao(at.id); const eq=findEquipe(at.equipeId); const hay=(progGid(pg)+' '+equipeLabel(eq)+' '+at.status).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'atribuicao',id:at.id,lbl:progGid(pg)+' · '+equipeLabel(eq)+' · '+at.status}); });
  if(!tipo||tipo==='equipe') equipesVisiveis().forEach(e=>{ const hay=(e.eqtl+' '+e.prtn+' '+e.supervisor+' '+e.encarregado).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'equipe',id:e.id,lbl:(e.eqtl||e.prtn||'Equipe')+(e.setor? ' · '+e.setor:'')}); });
  if(!tipo||tipo==='projeto') projetosVisiveis().forEach(p=>{ const hay=(p.codigo+' '+p.nome+' '+p.ciclo).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'projeto',id:p.id,lbl:p.codigo+' · '+p.nome+' · '+p.ciclo}); });
  if(!tipo||tipo==='atividade') (DB.atividades||[]).forEach(a=>{ const hay=(a.codigo+' '+a.descricao).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'atividade',id:a.id,lbl:a.codigo+' · '+a.descricao}); });
  if(!tipo||tipo==='usuario') (DB.usuarios||[]).forEach(u=>{ const hay=(u.nome+' '+u.login).toLowerCase(); if(!q||hay.includes(q)) res.push({tipo:'usuario',id:u.id,lbl:u.nome+' ('+u.login+')'}); });
  res.sort((a,b)=>a.id-b.id);
  return res.slice(0,50);
}
function monRastrearRender(){
  const q = document.getElementById('mon-rastrear-q')?.value||'';
  const tipo = document.getElementById('mon-rastrear-tipo')?.value||'';
  const res = monRastrearBusca(q, tipo);
  const wrap = document.getElementById('mon-rastrear-res');
  if(!wrap) return;
  wrap.innerHTML = res.length? `<div class="mon-feed">${res.map(r=>`<div class="mon-ev" data-rastrear-tipo="${r.tipo}" data-rastrear-id="${r.id}" style="cursor:pointer;"><span class="mon-badge" style="color:var(--accent);border-color:var(--accent);">${MON_ITEMTIPOS[r.tipo]||r.tipo}</span><span class="mon-ev-item">${esc(r.lbl)}</span><span class="mon-ev-det">Clique para ver passado e presente</span></div>`).join('')}</div>` : `<div class="mon-empty">${q? 'Nenhum item encontrado com "'+esc(q)+'".':'Digite algo para buscar um item.'}</div>`;
  wrap.querySelectorAll('[data-rastrear-tipo]').forEach(el=>el.addEventListener('click', ()=>rastrearItem(el.dataset.rastrearTipo, el.dataset.rastrearId)));
}
function bindMonPanel(){
  document.querySelectorAll('.mon-tab').forEach(b=>b.addEventListener('click', ()=>{ adminMonTab=b.dataset.montab; renderAdmin(); }));
  const body = document.getElementById('mon-body');
  if(body) body.innerHTML = monBodyHtml();
  body && body.querySelectorAll('[data-rastrear-tipo]').forEach(el=>el.addEventListener('click', ()=>rastrearItem(el.dataset.rastrearTipo, el.dataset.rastrearId)));
  const bq = document.getElementById('mon-rastrear-q');
  const bt = document.getElementById('mon-rastrear-tipo');
  if(bq) bq.addEventListener('input', monRastrearRender);
  if(bt) bt.addEventListener('change', monRastrearRender);
  if(bq) monRastrearRender();
}
function rastrearItem(itemTipo, itemId){
  itemId = Number(itemId);
  const rows = [];
  const push = (tipo, ts, quem, det, tag)=>{
    rows.push({ts:Number(ts)||Date.now(), tipo, quem, det, tag});
  };
  const histTipo = t=> t==='status'?'status' : t==='reprogramacao'?'reprogramacao' : t==='rdo_edicao'?'rdo' : t==='criacao'?'criacao' : 'edicao';
  const histDet = h=>{
    if(h.tipo==='status') return (h.de||'?')+' → '+(h.para||'?')+(h.motivo? ' · '+h.motivo:'');
    if(h.tipo==='reprogramacao') return fmtDate(h.de)+' → '+fmtDate(h.para)+(h.motivo? ' · '+h.motivo:'');
    if(h.tipo==='rdo_edicao') return 'Registro RDO editado'+(h.motivo? ' · '+h.motivo:'');
    return h.para||h.motivo||'';
  };
  const eqLbl = e=> equipeLabel(e)||'Equipe';
  let present = '';
  if(itemTipo==='programacao'){
    const p = DB.programacoes.find(x=>x.id===itemId);
    if(p){
      const pr = findProjeto(p.projetoId);
      present = `GID ${progGid(p)} · ${esc(pr?.codigo||'')} ${esc(pr?.nome||'Projeto removido')} · Ciclo ${esc(p.ciclo||'—')} · ${(p.atribuicoes||[]).length} equipe(s) · ${(p.atribuicoes||[]).map(a=>esc(a.status)).join(' / ')||'—'}`;
      (p.atribuicoes||[]).forEach(a=>{ (a.historico||[]).forEach(h=>push(histTipo(h.tipo), h.ts, h.nome||h.login||'?', eqLbl(findEquipe(a.equipeId))+' · '+histDet(h), 'atribuicao')); });
    }
  } else if(itemTipo==='atribuicao'){
    const at = findAtribuicaoGlobal(itemId);
    const pg = progDaAtribuicao(itemId);
    if(at){
      const qty = (at.atividades||[]).reduce((s,a)=>s+(Number(a.quantidadeExecutada)||0),0);
      present = `Equipe ${esc(eqLbl(findEquipe(at.equipeId)))} · Status ${esc(at.status)} · Programada ${fmtDate(at.dataProgramada)} · Executado ${qty} un · ${(at.atividades||[]).length} atividade(s)`;
      (at.historico||[]).forEach(h=>push(histTipo(h.tipo), h.ts, h.nome||h.login||'?', (pg? progGid(pg)+' · ':'')+histDet(h), ''));
    }
  } else if(itemTipo==='equipe'){
    const e = findEquipe(itemId);
    if(e){
      present = `${esc(e.eqtl||'')} ${esc(e.prtn||'')} · ${e.ativo?'Ativa':'Inativa'} · ${esc([e.setor,e.coordenacao].filter(Boolean).join(' / ')||'—')} · Supervisor: ${esc(e.supervisor||'—')} · Encarregado: ${esc(e.encarregado||'—')} · WhatsApp: ${esc(e.whatsapp||'—')}`;
      flatAtribuicoes().filter(x=>x.atribuicao.equipeId===itemId).forEach(x=>{ const pg=progDaAtribuicao(x.atribuicao.id); (x.atribuicao.historico||[]).forEach(h=>push(histTipo(h.tipo), h.ts, h.nome||h.login||'?', (pg? progGid(pg)+' · ':'')+histDet(h), 'atribuicao')); });
    }
  } else if(itemTipo==='atividade'){
    const a = findAtividade(itemId);
    if(a) present = `${esc(a.codigo)} · ${esc(a.descricao)} · Unidade ${esc(a.unidade||'—')} · Valor unitário ${fmtMoney(a.valorUnitario)}${isFavorita(a.id)? ' · Favorita':''}`;
  } else if(itemTipo==='projeto'){
    const p = findProjeto(itemId);
    if(p) present = `${esc(p.codigo)} · ${esc(p.nome)} · ${esc(p.status)} · ${esc([p.setor,p.coordenacao].filter(Boolean).join(' / ')||'—')} · ${esc(p.cidade||'—')} · Ciclo ${esc(p.ciclo||'—')} · Orçado ${fmtMoney(p.valorOrcado)} · Início ${fmtDate(p.dataInicio)} · Fim ${fmtDate(p.dataFim)}`;
  } else if(itemTipo==='usuario'){
    const u = (DB.usuarios||[]).find(x=>x.id===itemId);
    if(u) present = `${esc(u.nome)} · ${esc(u.login)} · ${esc(roleLabel(u.role))} · ${esc(nivelLabel(u.nivel))}${u.setor||u.coordenacao? ' · '+esc([u.setor,u.coordenacao].filter(Boolean).join(' / ')):''} · ${u.ativo?'Ativo':'Inativo'}`;
  }
  (DB.auditoria||[]).forEach(e=>{
    if(String(e.itemTipo)===itemTipo && String(e.itemId)===String(itemId)){
      push(e.tipo, e.ts, e.nome||e.user||'?', monItemLabel(e.itemTipo,e.itemId)+(e.detalhe? ' · '+e.detalhe:''), '');
    }
  });
  rows.sort((a,b)=>a.ts-b.ts);
  const body = `
    <div style="margin-bottom:14px;padding:12px;border-radius:10px;background:var(--bg-soft);font-size:13px;line-height:1.55;">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;"><span class="mon-badge" style="color:var(--accent);border-color:var(--accent);">${MON_ITEMTIPOS[itemTipo]||itemTipo}</span><strong style="font-size:14px;color:var(--dark);">${esc(monItemLabel(itemTipo,itemId))}</strong></div>
      <div class="admin-field-meta">${present||'Item não encontrado ou removido do banco.'}</div>
    </div>
    <h4 style="margin:0 0 10px;font-size:13px;">Linha do tempo — passado e presente (${rows.length} registro(s))</h4>
    <div class="mon-feed">${rows.length? rows.map(r=>`<div class="mon-ev">
      <span class="mon-ev-time">${fmtTs(r.ts)}</span>
      ${monEventBadge(r.tipo)}
      <span class="mon-ev-who">${esc(r.quem)}</span>
      ${r.tag? `<span class="mon-badge" style="color:var(--muted);border-color:var(--border);">${esc(r.tag)}</span>`:''}
      <span class="mon-ev-det">${esc(r.det)}</span>
    </div>`).join('') : '<div class="mon-empty">Nenhum registro de auditoria ou histórico encontrado para este item.</div>'}</div>`;
  openModal({ title:'Rastrear item — '+MON_ITEMTIPOS[itemTipo], bodyHtml:body, submitLabel:'Fechar', onSubmit:()=>true, wide:true });
}
function registrarPresenca(){
  if(!CURRENT_USER) return;
  try{
    const key = monKey(CURRENT_USER.login);
    const info = { login: String(CURRENT_USER.login), nome: CURRENT_USER.nome, role: CURRENT_USER.role, view: currentView, ts: Date.now() };
    PRES_REF.child(key).set(info);
    PRES_REF.child(key).onDisconnect().remove();
  }catch(e){}
}
function iniciarPresenca(){
  registrarPresenca();
  clearInterval(monHeartbeat);
  monHeartbeat = setInterval(registrarPresenca, 15000);
}
function pararPresenca(){
  clearInterval(monHeartbeat); monHeartbeat=null;
  if(CURRENT_USER){
    try{ PRES_REF.child(monKey(CURRENT_USER.login)).remove(); }catch(e){}
  }
}
function atualizarPresencaView(){
  if(!CURRENT_USER) return;
  try{ PRES_REF.child(monKey(CURRENT_USER.login)).update({ view: currentView, ts: Date.now() }); }catch(e){}
}
let monLastSig = '';
(function watchPresenca(){
  PRES_REF.on('value', snap=>{
    const raw = snap.val()||{};
    const arr = Object.keys(raw).map(k=>({ key:k, ...raw[k] }));
    arr.sort((a,b)=> (b.ts||0)-(a.ts||0));
    monPresenca = raw;
    monPresList = arr;
    const sig = arr.map(p=> p.login+'|'+p.view+'|'+(monOnline(p)?'on':'off')).join(',');
    if(sig!==monLastSig){ monLastSig=sig; if(CURRENT_USER && currentView==='admin') renderContent(); }
  });
})();
/* --- ACIDENTE ALERT (blocking modal + sound) --- */
const ALARM_URL = 'https://www.dropbox.com/scl/fi/pabmfo1nimawmo4tmh1qz/SOM-DE-ALERTA-VERMELHO-ALARME-DE-PERIGO-Efeito-Sonoro-HQ-DOWNLOAD-M4A_128K.m4a?rlkey=65edgvg3rpfrf47xsrp6qzvw2&st=1jo7z52n&dl=1';
let acidenteAtivo = null;
let alarmAudio = null;
function initAlarmAudio(){
  if(!alarmAudio){
    alarmAudio = new Audio(ALARM_URL);
    alarmAudio.loop = true;
    alarmAudio.volume = 1.0;
  }
}
function playAlarm(){
  initAlarmAudio();
  alarmAudio.play().catch(()=>{});
}
function stopAlarm(){
  if(alarmAudio){ alarmAudio.pause(); alarmAudio.currentTime=0; }
}
function renderAcidenteModal(acid){
  const acidente = acidenteAtivo;
  if(!acidente) return;
  const eqLabel = acidente.equipeLabel || '—';
  const progGid = acidente.progGid || '—';
  const local = acidente.local || '—';
  const temGps = acidente.localLat!=null && acidente.localLng!=null;
  const mapsLink = temGps ? mapsLinkByCoords(acidente.localLat, acidente.localLng) : mapsLinkByAddress(local);
  const gpsMeta = temGps
    ? [acidente.gpsPrecisao!=null? 'Precisão ±'+acidente.gpsPrecisao+' m' : '', acidente.gpsTs? 'Capturado às '+fmtDateTime(acidente.gpsTs).split(' ')[1] : ''].filter(Boolean).join(' · ')
    : (acidente.gpsErro || '');
  const localProgramado = acidente.localProgramado || '';
  const qr = qrCodeUrl(mapsLink, 140);
  const projNome = acidente.projetoNome || '—';
  const projCod = acidente.projetoCodigo || '—';
  const motivo = acidente.motivo || '—';
  const ts = fmtDateTime(acidente.ts);
  // Buscar dados completos da equipe no DB
  const eq = DB?.equipes?.find(e=> String(e.id)===String(acidente.equipeId));
  const supervisor = eq?.supervisor || '—';
  const encarregado = eq?.encarregado || '—';
  const motorista = eq?.motorista || '—';
  const eletricistas = (eq?.eletricistas||[]).filter(Boolean).join(', ') || '—';
  const setor = acidente.setor || eq?.setor || '—';
  const coordenacao = acidente.coordenacao || eq?.coordenacao || '—';
  return `
  <div style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;" id="acidente-overlay">
    <div style="width:100%;max-width:820px;background:#fff;border:4px solid #dc2626;border-radius:16px;overflow:hidden;animation:pulseRed 1.2s infinite, pulseRing 2s infinite;">
      <style>
        @keyframes pulseRed{0%,100%{box-shadow:0 0 0 0 #dc2626aa, 0 0 0 0 #dc262666, 0 0 0 0 #dc262633;}50%{box-shadow:0 0 40px 20px #dc2626aa, 0 0 80px 40px #dc262666, 0 0 120px 60px #dc262633;}}
        @keyframes pulseRing{0%{transform:scale(1);}50%{transform:scale(1.02);}100%{transform:scale(1);}}
      </style>
      <div style="background:linear-gradient(135deg,#dc2626 0%,#991b1b 100%);color:#fff;padding:18px 22px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:3px solid #7f1d1d;">
        <div style="display:flex;align-items:center;gap:12px;"><span style="font-size:32px;">${icon('alert',32)}</span><div><div style="font-size:22px;font-weight:800;letter-spacing:.02em;">ALERTA DE ACIDENTE</div><div style="font-size:13px;opacity:.95;">Recebido em ${ts}</div></div></div>
        <div style="font-size:12px;background:rgba(255,255,255,.15);padding:6px 14px;border-radius:999px;white-space:nowrap;font-weight:700;">ATIVO</div>
      </div>
      <div style="padding:24px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:18px;">
          <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:4px;font-weight:700;">EQUIPE</div>
            <div style="font-size:18px;font-weight:800;color:#000;line-height:1.3;">${esc(eqLabel)}</div>
          </div>
          <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:4px;font-weight:700;">PROGRAMAÇÃO</div>
            <div style="font-size:18px;font-weight:800;color:#000;line-height:1.3;">${esc(progGid)}</div>
          </div>
          <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;grid-column:1/-1;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:4px;font-weight:700;">PROJETO</div>
            <div style="font-size:16px;font-weight:800;color:#000;">${esc(projNome)} <span style="font-weight:400;color:#444;">(${esc(projCod)})</span></div>
          </div>
          <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:4px;font-weight:700;">SETOR / COORDENAÇÃO</div>
            <div style="font-size:14px;font-weight:700;color:#000;">${esc(setor)} / ${esc(coordenacao)}</div>
          </div>
          <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;grid-column:1/-1;">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:4px;font-weight:700;">LOCALIZAÇÃO DA EQUIPE (GPS)</div>
            <div style="font-size:14px;color:#000;margin-bottom:${gpsMeta? '4px':'8px'};line-height:1.4;">${esc(local)}</div>
            ${gpsMeta? `<div style="font-size:11px;color:#991b1b;margin-bottom:8px;">${temGps? icon('pin',11)+' '+esc(gpsMeta) : '⚠ '+esc(gpsMeta)}</div>`:''}
            ${localProgramado && localProgramado!==local? `<div style="font-size:11px;color:#666;margin-bottom:8px;">Local programado: ${esc(localProgramado)}</div>`:''}
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <a href="${esc(mapsLink)}" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#dc2626;color:#fff;padding:10px 16px;border-radius:8px;font-weight:800;font-size:13px;text-decoration:none;box-shadow:0 4px 12px #dc262666;">${icon('pin',14)} Abrir no Google Maps</a>
              <img src="${esc(qr)}" alt="QR Code localização" style="width:96px;height:96px;border:2px solid #fecaca;border-radius:6px;box-shadow:0 2px 8px #0001;">
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:18px;">
          <div style="border:1px solid #fecaca;background:#fffaf9;border-radius:8px;padding:12px;">
            <div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#991b1b;margin-bottom:2px;">SUPERVISOR</div>
            <div style="font-size:13.5px;font-weight:700;color:#000;">${esc(supervisor)}</div>
          </div>
          <div style="border:1px solid #fecaca;background:#fffaf9;border-radius:8px;padding:12px;">
            <div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#991b1b;margin-bottom:2px;">ENCARREGADO</div>
            <div style="font-size:13.5px;font-weight:700;color:#000;">${esc(encarregado)}</div>
          </div>
          <div style="border:1px solid #fecaca;background:#fffaf9;border-radius:8px;padding:12px;">
            <div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#991b1b;margin-bottom:2px;">MOTORISTA</div>
            <div style="font-size:13.5px;font-weight:700;color:#000;">${esc(motorista)}</div>
          </div>
          <div style="border:1px solid #fecaca;background:#fffaf9;border-radius:8px;padding:12px;grid-column:1/-1;">
            <div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#991b1b;margin-bottom:2px;">ELETRICISTAS</div>
            <div style="font-size:13px;font-weight:600;color:#333;">${esc(eletricistas)}</div>
          </div>
        </div>
        <div style="border:2px solid #fecaca;background:#fef2f2;border-radius:10px;padding:16px;margin-bottom:18px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#dc2626;margin-bottom:8px;font-weight:700;">DESCRIÇÃO DO ACIDENTE</div>
          <div style="font-size:15px;color:#000;white-space:pre-wrap;line-height:1.6;font-weight:500;">${esc(motivo)}</div>
        </div>
        <div style="display:flex;gap:14px;justify-content:flex-end;">
          <button type="button" id="acidente-reportado" class="btn btn-primary" style="font-size:17px;padding:16px 36px;font-weight:800;box-shadow:0 6px 20px #dc262680;">${icon('check',17)} REPORTADO — Repassarei as informações adiante</button>
        </div>
      </div>
    </div>
  </div>`;
}
function confirmarAcidente(acidenteKey){
  stopAlarm();
  const overlay = document.getElementById('acidente-overlay');
  if(overlay) overlay.remove();
  try{
    ACCIDENT_REF.child(acidenteKey).update({ status: 'confirmado', confirmadoPor: CURRENT_USER? CURRENT_USER.nome:'Desconhecido', confirmadoTs: Date.now() });
  }catch(e){}
  acidenteAtivo = null;
  toast('Acidente confirmado e repassado adiante.');
}
(function watchAcidentes(){
  ACCIDENT_REF.orderByChild('status').equalTo('ativo').on('value', snap=>{
    const data = snap.val()||{};
    const entries = Object.entries(data);
    if(!entries.length){
      if(acidenteAtivo){
        stopAlarm();
        const overlay = document.getElementById('acidente-overlay');
        if(overlay) overlay.remove();
        acidenteAtivo = null;
      }
      return;
    }
    entries.sort((a,b)=> (b[1].ts||0)-(a[1].ts||0));
    const [key, acidente] = entries[0];
    if(acidenteAtivo && acidenteAtivo.key===key) return;
    acidenteAtivo = { key, ...acidente };
    playAlarm();
    const root = document.getElementById('modal-root');
    root.insertAdjacentHTML('beforeend', renderAcidenteModal(acidente));
    document.getElementById('acidente-reportado').addEventListener('click', ()=> confirmarAcidente(key));
  });
})();
function showLoginScreen(){
  document.getElementById('login-screen').classList.remove('hidden');
  const u = document.getElementById('login-user');
  const p = document.getElementById('login-pass');
  const st = document.getElementById('login-status');
  st.style.color = 'var(--muted)';
  st.textContent = '';
  try{
    const saved = JSON.parse(localStorage.getItem('g26_login_saved')||'null');
    if(saved && saved.login){
      u.value = saved.login;
      p.value = saved.senha||'';
      document.getElementById('login-remember').checked = true;
    }
  }catch(e){ localStorage.removeItem('g26_login_saved'); }
  if(u.value==='') u.focus(); else p.focus();
  const navUser = document.getElementById('nav-user'); if(navUser) navUser.textContent = CURRENT_USER? 'Conectado: '+CURRENT_USER.nome : 'Dados sincronizados na nuvem (Firebase)';
}
function tryLogin(){
  const login = document.getElementById('login-user').value.trim();
  const senha = document.getElementById('login-pass').value;
  const remember = document.getElementById('login-remember').checked;
  const u = (DB.usuarios||[]).find(x=> x.ativo!==false && String(x.login)===login && String(x.senha)===senha);
  const st = document.getElementById('login-status');
  if(!u){ st.textContent = 'Usuário ou senha inválidos.'; st.style.color='var(--red)'; return; }
  if(remember){
    try{ localStorage.setItem('g26_login_saved', JSON.stringify({login, senha})); }catch(e){}
  } else {
    try{ localStorage.removeItem('g26_login_saved'); }catch(e){}
  }
  CURRENT_USER = u;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('login-pass').value='';
  atualizarStatusSync();
  registrarEvento('login','usuario',u.id,u.nome,'Entrou no sistema');
  iniciarPresenca();
  progFilters.ciclo = cicloPadrao();
  setView('dashboard');
  checkPendingConfirmations();
  aplicarPendente();
  toast('Bem-vindo, '+u.nome+'!');
}
function logout(){
  registrarEvento('logout','usuario',CURRENT_USER? CURRENT_USER.id:null, CURRENT_USER? CURRENT_USER.nome:'', 'Saiu do sistema');
  pararPresenca();
  CURRENT_USER = null;
  atualizarStatusSync();
  showLoginScreen();
}
document.getElementById('login-btn').addEventListener('click', tryLogin);
document.getElementById('login-user').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('login-pass').focus(); });
document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') tryLogin(); });
const EYE_OPEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
const EYE_CLOSED = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><path d="M1 1l22 22"></path></svg>';
document.getElementById('pwd-eye').addEventListener('click', ()=>{
  const input = document.getElementById('login-pass');
  const show = input.type==='password';
  input.type = show? 'text' : 'password';
  const btn = document.getElementById('pwd-eye');
  btn.innerHTML = show? EYE_CLOSED : EYE_OPEN;
  btn.title = show? 'Ocultar senha' : 'Mostrar senha';
});
document.getElementById('btn-logout')?.addEventListener('click', logout);

/* =========================================================
   INIT — carrega dados do Firebase Realtime Database
========================================================= */
let booted = false;
const _bootPending = (()=>{ try{ const p = JSON.parse(localStorage.getItem('g26_admin_pending')||'null'); return (p && p.snapshot)? JSON.parse(p.snapshot) : null; }catch(e){ return null; } })();
const _cachedData = _bootPending || loadAdminCache();
if(_cachedData){
  DB = mergeData(_cachedData);
  if(!booted){
    booted = true;
    progFilters.ciclo = cicloPadrao();
    showLoginScreen();
  }
}
DB_REF.on('value', snap=>{
  servidorSincronizado = true;
  lastServerJson = snap.exists()? snap.val() : null;
  atualizarStatusSync();
  const exists = snap.exists();
  if(exists && typeof snap.val()==='string' && snap.val()===lastWrittenJson) return;
  if(salvando) return;
  let serverData = null;
  try{ serverData = exists? JSON.parse(snap.val()) : null; }catch(err){ console.error('Falha ao ler dados do Firebase', err); }
  const serverRev = serverData? (serverData.rev||0) : 0;
  const localRev = DB.rev||0;
  if(serverData && serverRev > localRev){
    try{ localStorage.removeItem('g26_admin_pending'); }catch(e){}
    try{
      DB = mergeData(serverData);
      saveAdminCache(DB, true);
    }catch(err){ console.error('Falha ao ler dados do Firebase', err); }
    if(booted && CURRENT_USER){
      toast('Banco atualizado por outro aparelho. Dados recarregados.', 'error');
      renderBanner(); renderContent(); checkPendingConfirmations();
    }
    return;
  }
  if(!exists || !serverData){
    if(DB.rev && (DB.atividades.length || DB.equipes.length || DB.projetos.length || DB.programacoes.length) && CURRENT_USER && navigator.onLine && !salvando){
      flushSave();
    }
    if(!booted){
      booted = true;
      if(!exists) seedIfEmpty();
      garantirMaster();
      progFilters.ciclo = cicloPadrao();
      showLoginScreen();
    }else if(CURRENT_USER){
      renderBanner(); renderContent(); checkPendingConfirmations();
    }
    return;
  }
  try{
    if(exists){
      DB = mergeData(JSON.parse(snap.val()));
      saveAdminCache(DB, true);
    }
  }catch(err){ console.error('Falha ao ler dados do Firebase', err); }
  try{
    const p = JSON.parse(localStorage.getItem('g26_admin_pending')||'null');
    if(p && p.server === null) localStorage.removeItem('g26_admin_pending');
  }catch(e){}
  if(!booted){
    booted = true;
    if(!exists) seedIfEmpty();
    garantirMaster();
    progFilters.ciclo = cicloPadrao();
    showLoginScreen();
  }else if(CURRENT_USER){
    renderBanner();
    renderContent();
    checkPendingConfirmations();
  }
});
setTimeout(()=>{
  if(!booted){
    booted = true;
    garantirMaster();
    progFilters.ciclo = cicloPadrao();
    showLoginScreen();
    toast('Sem conexão com o Firebase. Os dados serão carregados assim que a conexão for restabelecida.', 'error');
  }
}, 8000);

window.addEventListener('online', ()=> aplicarPendente());
window.addEventListener('offline', ()=> atualizarStatusSync());
setInterval(()=>{ if(CURRENT_USER && (temPendente() || !servidorSincronizado)) aplicarPendente(); }, 15000);

/* =========================================================
   RDO - Relatório de Execução das Equipes
   ========================================================= */
function rdoTemExecucao(x){
  const at = x.atribuicao;
  const rdo = at.rdoRespostas||{};
  const temRespostas = Object.values(rdo).some(v=> v && String(v).trim()!=='');
  const temHorarios = RDO_HORARIOS.some(h=> at[h.k]);
  const temKm = RDO_KM.some(h=> at[h.k]);
  const temExec = (at.atividades||[]).some(a=> a.quantidadeExecutada!=null && String(a.quantidadeExecutada).trim()!=='');
  const temCond = ['rdoCondicoes','rdoImpedimento','rdoFaltaMaterial','rdoProjetoIncoerente','rdoEquipeIncompleta','rdoFaltaVeiculo','rdoImpedimentoAcesso','rdoLicencaAmbiental','rdoAutorizacaoEmbargo','rdoDesligamento'].some(k=> at[k]);
  return temRespostas || temHorarios || temKm || temExec || temCond || at.status==='Concluído';
}
function rdoResumo(x){
  const at = x.atribuicao;
  let prev=0, exec=0;
  (at.atividades||[]).forEach(a=>{
    const p = parseFloat(a.quantidadePrevista)||0;
    const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
    prev+=p;
    if(e!=null && !isNaN(e)) exec+=e;
  });
  const pct = prev>0? Math.round(exec/prev*100) : (at.status==='Concluído'? 100 : 0);
  return { prev, exec, pct };
}
function rdoImpedimentos(at){
  const itens=[];
  const map = [
    ['rdoImpedimento','Impedimento de execução'],
    ['rdoFaltaMaterial','Falta de material'],
    ['rdoProjetoIncoerente','Projeto incoerente'],
    ['rdoEquipeIncompleta','Equipe incompleta'],
    ['rdoFaltaVeiculo','Falta de veículo'],
    ['rdoImpedimentoAcesso','Impedimento de acesso'],
    ['rdoLicencaAmbiental','Licença ambiental'],
    ['rdoAutorizacaoEmbargo','Autorização/embargo']
  ];
  map.forEach(([k,l])=>{ if(at[k]==='Sim') itens.push(l); });
  if(at.rdoDesligamento==='Não') itens.push('Desligamento não programado');
  return itens;
}
function rdoConfData(x){
  const hist = (x.atribuicao.historico||[]).filter(h=>h.tipo==='equipe');
  const h = hist[hist.length-1];
  return h ? fmtDateTime(h.ts) : '—';
}
function rdoStatusBadge(status){
  const s = status||'Programado';
  const cor = { 'Programado':'var(--blue)','Em Execução':'var(--accent)','Concluído':'var(--green)','Reprogramado':'var(--purple)','Cancelado':'var(--red)' }[s]||'var(--muted)';
  const bg = { 'Programado':'rgba(78,140,235,.14)','Em Execução':'rgba(224,164,88,.14)','Concluído':'rgba(34,139,34,.14)','Reprogramado':'rgba(142,110,235,.14)','Cancelado':'rgba(224,97,91,.14)' }[s]||'rgba(128,128,128,.14)';
  return `<span class="badge" style="color:${cor};background:${bg};">${esc(s)}</span>`;
}

function renderRdoProjetos(){
  const el = document.getElementById('content');
  let registros = flatAtribuicoes().filter(rdoTemExecucao);

  registros.sort((a,b)=> String(b.atribuicao.dataProgramada||'').localeCompare(String(a.atribuicao.dataProgramada||'')));

  const stats = (()=>{
    const total = registros.length;
    const concluidos = registros.filter(x=>x.atribuicao.status==='Concluído').length;
    const totalExec = registros.reduce((s,x)=> s+rdoResumo(x).exec, 0);
    const mediaPct = total? Math.round(registros.reduce((s,x)=> s+rdoResumo(x).pct,0)/total) : 0;
    const imped = registros.filter(x=> rdoImpedimentos(x.atribuicao).length>0).length;
    return `
      <div class="grid-stats">
        <div class="stat-card"><div class="lbl">Registros de execução</div><div class="val">${total}</div></div>
        <div class="stat-card" style="--accent-c:var(--green);"><div class="lbl">Concluídas</div><div class="val">${concluidos}</div></div>
        <div class="stat-card" style="--accent-c:var(--blue);"><div class="lbl">Qtd. executada</div><div class="val">${fmtNum(totalExec)}</div></div>
        <div class="stat-card" style="--accent-c:var(--accent);"><div class="lbl">Conclusão média</div><div class="val">${mediaPct}<small>%</small></div></div>
        <div class="stat-card" style="--accent-c:var(--red);"><div class="lbl">Com impedimentos</div><div class="val">${imped}</div></div>
      </div>`;
  })();

  const projetos = [...new Set(registros.map(x=>x.programacao.projetoId))].map(id=> findProjeto(id)).filter(Boolean);
  const equipes = [...new Set(registros.map(x=>x.atribuicao.equipeId))].map(id=> findEquipe(id)).filter(Boolean);

  const filters = `
    <div class="panel" style="padding:14px 16px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
        <input type="search" id="rdo-f-busca" placeholder="Buscar por projeto, equipe, supervisor, data, status, GID ou ID da programação..." style="flex:1;">
        <button class="btn btn-sm" id="rdo-f-busca-aplicar">${icon('search',13)} Buscar</button>
      </div>
      <div class="filters">
        <label style="font-weight:600;">Projeto</label>
        <select id="rdo-f-projeto"><option value="">Todos</option>${projetos.map(p=>`<option value="${p.id}">${esc(p.codigo)} · ${esc(p.nome)}</option>`).join('')}</select>
        <label style="font-weight:600;">Equipe</label>
        <select id="rdo-f-equipe"><option value="">Todas</option>${equipes.map(e=>`<option value="${e.id}">${esc(equipeLabel(e))}</option>`).join('')}</select>
        <label style="font-weight:600;">Status</label>
        <select id="rdo-f-status"><option value="">Todos</option>${STATUS_PROG.map(s=>`<option>${s}</option>`).join('')}</select>
        <label style="font-weight:600;">De</label>
        <input type="date" id="rdo-f-de">
        <label style="font-weight:600;">Até</label>
        <input type="date" id="rdo-f-ate">
        <button class="btn btn-sm" id="rdo-f-aplicar">${icon('grid',13)} Filtrar</button>
        <button class="btn btn-sm btn-ghost" id="rdo-f-limpar">Limpar</button>
      </div>
    </div>`;

  const tabela = `
    <div class="panel" style="padding:0;overflow:hidden;">
      <div class="panel-head" style="padding:14px 16px;">
        <div><h3>Execuções das equipes</h3><div class="admin-field-meta">Todos os dados de execução e projetos executados em campo.</div></div>
        <div class="filters" style="gap:6px;">
          <button class="btn btn-sm" id="rdo-export">${icon('download',13)} Excel</button>
          <button class="btn btn-sm btn-ghost" id="rdo-print">${icon('print',13)} Imprimir</button>
        </div>
      </div>
      <div style="overflow-x:auto;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1200px;">
          <thead>
            <tr>
              <th style="width:30px;">#</th>
              <th>Projeto</th>
              <th>Equipe</th>
              <th style="text-align:center;">Data</th>
              <th style="text-align:center;">Status</th>
              <th style="text-align:center;">Horários</th>
              <th style="text-align:center;">Clima</th>
              <th style="text-align:center;">Impedimentos</th>
              <th style="text-align:center;">Prev.</th>
              <th style="text-align:center;">Exec.</th>
              <th style="text-align:center;width:110px;">Progresso</th>
              <th style="text-align:center;">Confirmação</th>
              <th style="width:40px;"></th>
            </tr>
          </thead>
          <tbody>
            ${registros.map((x,i)=>{
              const pr = findProjeto(x.programacao.projetoId);
              const eq = findEquipe(x.atribuicao.equipeId);
              const res = rdoResumo(x);
              const imped = rdoImpedimentos(x.atribuicao);
              const horarios = [x.atribuicao.rdoHorarioChegada, x.atribuicao.rdoHorarioSaidaObra].filter(Boolean).join(' → ')||'—';
              return `
                <tr data-prog="${x.programacao.id}" data-atrib="${x.atribuicao.id}" style="cursor:pointer;" title="Ver detalhes">
                  <td style="text-align:center;color:var(--muted-2);">${i+1}</td>
                  <td><strong>${esc(pr?.nome||'—')}</strong><div class="admin-field-meta">${esc(pr?.codigo||'')} · Ciclo ${esc(x.programacao.ciclo||'—')}</div></td>
                  <td>${esc(equipeLabel(eq))}<div class="admin-field-meta">${esc(eq?.supervisor||'')}</div></td>
                  <td style="text-align:center;" class="mono">${fmtDate(x.atribuicao.dataProgramada)}</td>
                  <td style="text-align:center;">${rdoStatusBadge(x.atribuicao.status)}</td>
                  <td style="text-align:center;" class="mono">${esc(horarios)}</td>
                  <td style="text-align:center;">${esc(x.atribuicao.rdoCondicoes||'—')}</td>
                  <td style="text-align:center;">${imped.length? `<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);">${imped.length}</span>` : '—'}</td>
                  <td style="text-align:center;" class="mono">${fmtNum(res.prev)}</td>
                  <td style="text-align:center;" class="mono"><strong>${fmtNum(res.exec)}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="flex:1;height:6px;background:var(--panel-2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${Math.min(100,res.pct)}%;background:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};border-radius:3px;"></div></div>
                      <span class="mono" style="font-size:11px;min-width:34px;text-align:right;">${res.pct}%</span>
                    </div>
                  </td>
                  <td style="text-align:center;" class="mono"><span style="font-size:11px;">${rdoConfData(x)}</span></td>
                  <td style="text-align:center;">${icon('search',13)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  const vazio = `
    <div class="panel"><div class="empty-state">${icon('check',36)}<h3 style="margin-bottom:6px;">Nenhuma execução registrada</h3><p>Quando as equipes responderem o RDO na página da programação, os dados de execução aparecerão aqui.</p><button class="btn btn-primary" id="rdo-back-dash" style="margin-top:16px;">Voltar ao Painel</button></div></div>`;

  if(!registros.length){
    el.innerHTML = `<div class="section-gap">${stats}${vazio}</div>`;
    const b = document.getElementById('rdo-back-dash');
    if(b) b.addEventListener('click', ()=> setView('dashboard'));
    return;
  }

  el.innerHTML = `<div class="section-gap">${stats}${filters}${tabela}</div>`;

  const fProj = document.getElementById('rdo-f-projeto');
  const fEq = document.getElementById('rdo-f-equipe');
  const fSt = document.getElementById('rdo-f-status');
  const fDe = document.getElementById('rdo-f-de');
  const fAte = document.getElementById('rdo-f-ate');
  const fBusca = document.getElementById('rdo-f-busca');
  const norm = s=> String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const aplicar = ()=>{
    const q = norm(fBusca.value.trim());
    registros.forEach(x=>{
      const pr = findProjeto(x.programacao.projetoId);
      const eq = findEquipe(x.atribuicao.equipeId);
      const okProj = !fProj.value || String(x.programacao.projetoId)===String(fProj.value);
      const okEq = !fEq.value || String(x.atribuicao.equipeId)===String(fEq.value);
      const okSt = !fSt.value || x.atribuicao.status===fSt.value;
      const data = x.atribuicao.dataProgramada||'';
      const okDe = !fDe.value || data >= fDe.value;
      const okAte = !fAte.value || data <= fAte.value;
      const hay = norm([
        pr?.nome, pr?.codigo, pr?.setor, pr?.coordenacao,
        equipeLabel(eq), eq?.supervisor, eq?.encarregado, eq?.motorista, (eq?.eletricistas||[]).join(' '),
        data, x.atribuicao.status,
        x.atribuicao.rdoHorarioChegada, x.atribuicao.rdoHorarioSaidaObra, x.atribuicao.rdoCondicoes,
        rdoImpedimentos(x.atribuicao).join(' '),
        progGid(x.programacao), String(x.programacao.id), String(x.atribuicao.id)
      ].join(' '));
      const okBusca = !q || hay.indexOf(q)!==-1;
      const tr = document.querySelector(`tr[data-prog="${x.programacao.id}"][data-atrib="${x.atribuicao.id}"]`);
      if(tr) tr.style.display = (okProj&&okEq&&okSt&&okDe&&okAte&&okBusca)? '' : 'none';
    });
  };
  fBusca.addEventListener('input', aplicar);
  document.getElementById('rdo-f-busca-aplicar').addEventListener('click', aplicar);
  document.getElementById('rdo-f-aplicar').addEventListener('click', aplicar);
  document.getElementById('rdo-f-limpar').addEventListener('click', ()=>{
    fProj.value=''; fEq.value=''; fSt.value=''; fDe.value=''; fAte.value=''; fBusca.value='';
    aplicar();
  });

  document.querySelectorAll('tr[data-prog]').forEach(tr=>{
    tr.addEventListener('click', ()=> openRDOModal(Number(tr.dataset.prog), Number(tr.dataset.atrib)));
  });

  document.getElementById('rdo-export').addEventListener('click', ()=> exportRDOExcel(registros));
  document.getElementById('rdo-print').addEventListener('click', ()=> printRDOReport(registros));
}

function renderRdoOcNds(){
  const el = document.getElementById('content');
  const ocndsConcluidas = ocndsVisiveis().filter(x=>x.status==='Concluída').sort((a,b)=> String(b.data||'').localeCompare(String(a.data||'')));

  if(!ocndsConcluidas.length){
    el.innerHTML = `<div class="section-gap"><div class="panel"><div class="empty-state">${icon('check',36)}<h3 style="margin-bottom:6px;">Nenhuma ocorrência OC/NDS concluída</h3><p>Quando as equipes concluiram uma ocorrência OC/NDS, os dados aparecerão aqui.</p><button class="btn btn-primary" id="rdo-oc-back" style="margin-top:16px;">Voltar ao Painel</button></div></div></div>`;
    const b = document.getElementById('rdo-oc-back');
    if(b) b.addEventListener('click', ()=> setView('dashboard'));
    return;
  }

  el.innerHTML = `
    <div class="section-gap">
      <div class="panel" style="padding:0;overflow:hidden;">
        <div class="panel-head" style="padding:14px 16px;">
          <div><h3>Ocorrências OC/NDS Concluídas</h3><div class="admin-field-meta">${ocndsConcluidas.length} ocorrência(s) concluída(s) e registrada(s) no RDO.</div></div>
        </div>
        <div style="overflow-x:auto;">
          <table class="data-table" style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:1050px;">
            <thead>
              <tr>
                <th style="width:30px;">#</th>
                <th>ID</th>
                <th>Tipo</th>
                <th>Setor</th>
                <th>Coord.</th>
                <th>Detalhes</th>
                <th>Equipe</th>
                <th style="text-align:center;">Data</th>
                <th style="text-align:center;">Status</th>
                <th style="width:40px;"></th>
              </tr>
            </thead>
            <tbody>
              ${ocndsConcluidas.map((x,i)=>{
                const eq = findEquipe(x.equipeId);
                const badge = x.tipo==='OC'
                  ? `<span class="badge" style="color:var(--blue);background:rgba(78,140,235,.14);">OC</span>`
                  : `<span class="badge" style="color:var(--accent);background:rgba(224,164,88,.14);">NDS</span>`;
                const detalhes = x.tipo==='OC'
                  ? [x.ptp&&'PTP: '+x.ptp, x.si&&'SI: '+x.si, x.ose&&'OSE: '+x.ose, x.numeroOC&&'OC: '+x.numeroOC].filter(Boolean).join(' · ')||'—'
                  : [x.ocorrencia&&'Ocorrência: '+x.ocorrencia].filter(Boolean).join('')||'—';
                return `
                  <tr data-ocnds-rdo="${x.id}" style="cursor:pointer;" title="Ver detalhes">
                    <td style="text-align:center;color:var(--muted-2);">${i+1}</td>
                    <td class="mono">${esc(x.gid||'G26-'+String(x.id).padStart(7,'0'))}</td>
                    <td>${badge}</td>
                    <td style="font-size:12px;">${esc(x.setor||'—')}</td>
                    <td style="font-size:12px;">${esc(x.coordenacao||'—')}</td>
                    <td style="font-size:12px;color:var(--muted);">${esc(detalhes)}</td>
                    <td>${esc(equipeLabel(eq))}<div class="admin-field-meta">${esc(eq?.supervisor||'')}</div></td>
                    <td style="text-align:center;" class="mono">${fmtDate(x.data)}</td>
                    <td style="text-align:center;"><span class="badge" style="color:var(--green);background:rgba(34,139,34,.14);"><span class="badge-dot"></span>Concluída</span></td>
                    <td style="text-align:center;">${icon('search',13)}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  el.querySelectorAll('tr[data-ocnds-rdo]').forEach(tr=>{
    tr.addEventListener('click', ()=> openOcNdsDetalhe(Number(tr.dataset.ocndsRdo)));
  });
}

function openRDOModal(progId, attribId){
  const x = flatAtribuicoes().find(y=> y.programacao.id===progId && y.atribuicao.id===attribId);
  if(!x) return;
  const pr = findProjeto(x.programacao.projetoId);
  const eq = findEquipe(x.atribuicao.equipeId);
  const rdo = x.atribuicao.rdoRespostas||{};
  const res = rdoResumo(x);
  const imped = rdoImpedimentos(x.atribuicao);
  const horarios = RDO_HORARIOS.map(h=> `
    <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
    <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');

  const body = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div>
        <h4 style="margin-bottom:8px;">Programação ${progGid(x.programacao)}</h4>
        <p class="admin-field-meta" style="margin:2px 0;">${esc(pr?.nome||'—')} <strong>(${esc(pr?.codigo||'—')})</strong></p>
        <p class="admin-field-meta" style="margin:2px 0;">Setor ${esc(pr?.setor||'—')} · Coordenação ${esc(pr?.coordenacao||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Ciclo ${esc(x.programacao.ciclo||'—')} · Data ${fmtDate(x.atribuicao.dataProgramada)}</p>
        <div style="margin-top:8px;">${rdoStatusBadge(x.atribuicao.status)}</div>
      </div>
      <div>
        <h4 style="margin-bottom:8px;">Equipe</h4>
        <p class="admin-field-meta" style="margin:2px 0;"><strong>${esc(equipeLabel(eq))}</strong></p>
        <p class="admin-field-meta" style="margin:2px 0;">Supervisor: ${esc(eq?.supervisor||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Encarregado: ${esc(eq?.encarregado||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Motorista: ${esc(eq?.motorista||'—')}</p>
        <p class="admin-field-meta" style="margin:2px 0;">Eletricistas: ${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</p>
      </div>
    </div>
    ${(x.programacao.anexos&&x.programacao.anexos.length)? `<div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Anexos do programador</h4>
      ${anexosDisplayHtml(x.programacao.anexos)}
    </div>`:''}
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Horários do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">${horarios}</table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">KM do Veículo</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_KM.map(h=> `
          <tr><td style="font-weight:600;padding:5px 12px 5px 0;white-space:nowrap;">${h.label}</td>
          <td style="padding:5px 10px;border:1px solid var(--border);border-radius:4px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('')}
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Condições do RDO</h4>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        ${RDO_QUESTIONS.map(q=>`
          <tr><td style="font-weight:600;padding:3px 12px 3px 0;">${q.label}</td>
          <td style="padding:3px 10px;">${String(rdo[q.id]||'')||'—'}</td></tr>`).join('')}
      </table>
      ${imped.length? `<div style="margin-top:10px;">${imped.map(i=>`<span class="badge" style="color:var(--red);background:rgba(224,97,91,.12);margin-right:4px;">${esc(i)}</span>`).join('')}</div>`:''}
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Atividades e quantidades executadas</h4>
      <div style="display:flex;gap:14px;margin-bottom:12px;">
        <span class="badge-prefix">Prev. ${fmtNum(res.prev)}</span>
        <span class="badge-prefix alt">Exec. ${fmtNum(res.exec)}</span>
        <span class="badge-prefix" style="color:${res.pct>=100?'var(--green)':res.pct>=50?'var(--accent)':'var(--red)'};">${res.pct}%</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr><th style="text-align:left;padding:4px 6px;">#</th><th style="text-align:left;">Código</th><th style="text-align:left;">Descrição</th><th style="text-align:center;">Un.</th><th style="text-align:center;">Prev.</th><th style="text-align:center;">Exec.</th><th style="text-align:center;">%</th><th style="text-align:center;">Fotos</th></tr></thead>
        <tbody>
          ${(x.atribuicao.atividades||[]).map((a,idx)=>{
            const at = findAtividade(a.atividadeId);
            const p = parseFloat(a.quantidadePrevista)||0;
            const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
            const pct = p? Math.round((e||0)/p*100) : 0;
            const fotos = String(a.fotos||'').split(';;').filter(Boolean);
            return `<tr style="border-top:1px solid var(--border-soft);">
              <td style="padding:4px 6px;color:var(--muted-2);">${idx+1}</td>
              <td class="mono" style="padding:4px 6px;">${esc(at?.codigo||'?')}</td>
              <td style="padding:4px 6px;">${esc(at?.descricao||'')}</td>
              <td style="text-align:center;">${esc(at?.unidade||'')}</td>
              <td style="text-align:center;" class="mono">${p? fmtNum(p):'—'}</td>
              <td style="text-align:center;" class="mono"><strong>${e!=null? fmtNum(e):'—'}</strong></td>
              <td style="text-align:center;color:${pct>=100?'var(--green)':pct>=50?'var(--accent)':'var(--red)'};font-weight:700;">${p? pct+'%':'—'}</td>
              <td style="text-align:center;">${fotos.length? `<div class="rdo-fotos" style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap;">${fotos.map(u=>`<img class="rdo-foto" src="${esc(u)}" alt="foto" title="Ampliar" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in;">`).join('')}</div>`:'<span style="color:var(--muted-2);">—</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-bottom:20px;">
      <h4 style="margin-bottom:8px;">Observação da execução</h4>
      <p style="font-size:13px;">${esc(x.atribuicao.observacao)||'—'}</p>
    </div>
    <div class="admin-field-meta">Confirmado pela equipe em <strong>${rdoConfData(x)}</strong></div>`;

  openModal({ title:'RDO — Detalhes da execução', bodyHtml: body, submitLabel:'Fechar', wide:true, footerBtns:[
    { label: icon('edit',14)+' Editar registro', cls:'btn', onClick: ()=> editRdoModal(x) },
    { label: icon('print',14)+' Gerar PDF', cls:'btn', onClick: ()=> printRDOCompleto(x) }
  ] });
}

function rdoOptionsHtml(q, atual){
  const opts = q.id==='rdo_condicoes'? ['Bom','Nublado','Chuvoso','Impraticável'] : ['Não','Sim'];
  return `<option value="">—</option>${opts.map(o=>`<option ${String(atual||'').trim()===o? 'selected':''}>${o}</option>`).join('')}`;
}
function editRdoModal(x, gidOf){
  if(!requerEscrita()) return;
  const gidLabel = gidOf || (p=>progGid(p));
  const at = x.atribuicao;
  const horarios = RDO_HORARIOS.map(h=>`<div class="field" style="flex:1;"><label>${h.label}</label><input type="time" name="${h.k}" value="${at[h.k]||''}"></div>`).join('');
  const kmFields = RDO_KM.map(h=>`<div class="field" style="flex:1;"><label>${h.label}</label><input type="number" name="${h.k}" value="${at[h.k]||''}" placeholder="0"></div>`).join('');
  const condicoes = RDO_QUESTIONS.map(q=>`<div class="field"><label>${q.label}</label><select name="${q.id}">${rdoOptionsHtml(q, at.rdoRespostas?.[q.id])}</select></div>`).join('');
  const ativs = (at.atividades||[]).map((a,idx)=>{
    const atDef = findAtividade(a.atividadeId);
    return `<div class="field" style="display:flex;gap:8px;align-items:center;"><span style="flex:1;font-size:12px;"><strong>${esc(atDef?.codigo||'?')}</strong> · ${esc(atDef?.descricao||'')}</span><input type="number" step="0.01" min="0" name="exec_${idx}" value="${a.quantidadeExecutada!=null? a.quantidadeExecutada:''}" style="max-width:110px;" placeholder="Exec."></div>`;
  }).join('') || '<p class="admin-field-meta">Sem atividades neste registro.</p>';
  const body = `
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:12px;">Editando o registro RDO de <strong>${esc(equipeLabel(findEquipe(at.equipeId)))}</strong> — ${esc(gidLabel(x.programacao))}</div>
    <div class="field"><label>Motivo da edição <span class="req">*</span></label><input type="text" name="motivo" required maxlength="200" placeholder="Por que você está editando este registro RDO?"></div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-soft);">
      <h4 style="font-size:12.5px;margin:0 0 10px;">Horários do RDO</h4>
      <div class="field-row" style="grid-template-columns:1fr 1fr;">${horarios}</div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-soft);">
      <h4 style="font-size:12.5px;margin:0 0 10px;">KM do Veículo</h4>
      <div class="field-row" style="grid-template-columns:1fr 1fr;">${kmFields}</div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-soft);">
      <h4 style="font-size:12.5px;margin:0 0 10px;">Condições do RDO</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">${condicoes}</div>
    </div>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-soft);">
      <h4 style="font-size:12.5px;margin:0 0 10px;">Quantidades executadas</h4>
      ${ativs}
    </div>
    <div class="field" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-soft);"><label>Observação da execução</label><textarea name="obs" rows="3" placeholder="Observação registrada pela equipe">${esc(at.observacao||'')}</textarea></div>`;
  openModal({
    title:'Editar registro RDO', bodyHtml: body, wide:true, submitLabel:'Salvar alterações',
    onSubmit:(fd)=>{
      const motivo = String(fd.get('motivo')||'').trim();
      if(!motivo){ toast('Informe o motivo da edição do registro.', 'error'); return false; }
      const obs = String(fd.get('obs')||'').trim();
      at.rdoRespostas = at.rdoRespostas||{};
      RDO_HORARIOS.forEach(h=>{ at[h.k] = String(fd.get(h.k)||'').trim(); });
      RDO_KM.forEach(h=>{ at[h.k] = String(fd.get(h.k)||'').trim(); });
      RDO_QUESTIONS.forEach(q=>{ at.rdoRespostas[q.id] = String(fd.get(q.id)||'').trim(); });
      at.rdoCondicoes = at.rdoRespostas.rdo_condicoes||'';
      (at.atividades||[]).forEach((a,idx)=>{
        const v = fd.get('exec_'+idx);
        a.quantidadeExecutada = (v!==null && String(v).trim()!=='')? parseFloat(v) : null;
      });
      at.observacao = obs;
      at.historico = at.historico||[];
      at.historico.push({...currentAutor(), ts:Date.now(), tipo:'rdo_edicao', de:null, para:'RDO', motivo, obs});
      registrarEvento('rdo','atribuicao',at.id, gidLabel(x.programacao)+' · '+equipeLabel(findEquipe(at.equipeId)), 'Registro RDO editado · '+motivo+(obs? ' · '+obs:''));
      saveData(); renderContent(); toast('Registro RDO atualizado.');
    }
  });
}

function printRDOCompleto(x){
  const pr = findProjeto(x.programacao.projetoId);
  const eq = findEquipe(x.atribuicao.equipeId);
  const rdo = x.atribuicao.rdoRespostas||{};
  const res = rdoResumo(x);
  const imped = rdoImpedimentos(x.atribuicao);
  const av = pr? projetoAvanco(pr) : null;
  const geradoPor = CURRENT_USER ? ((CURRENT_USER.nome||'') + (CURRENT_USER.login? ' ('+CURRENT_USER.login+')':'') || 'Sistema') : 'Sistema';
  const horarios = RDO_HORARIOS.map(h=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${h.label}</td><td style="border:1px solid #999;padding:4px 8px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');
  const kmRows = RDO_KM.map(h=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${h.label}</td><td style="border:1px solid #999;padding:4px 8px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');
  const condicoes = RDO_QUESTIONS.map(q=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${q.label}</td><td style="border:1px solid #999;padding:4px 8px;">${String(rdo[q.id]||'')||'—'}</td></tr>`).join('');
  const impedHtml = imped.length? imped.map(i=>`<span style="display:inline-block;border:1px solid #d95555;color:#b33;background:#fdecec;border-radius:4px;padding:2px 8px;margin:2px 3px 2px 0;">${esc(i)}</span>`).join('') : '—';
  const ativRows = (x.atribuicao.atividades||[]).map((a,idx)=>{
    const at = findAtividade(a.atividadeId);
    const p = parseFloat(a.quantidadePrevista)||0;
    const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
    const pct = p? Math.round((e||0)/p*100) : 0;
    const vu = at?.valorUnitario||0;
    const execVal = e!=null? e*vu : 0;
    const fotos = String(a.fotos||'').split(';;').filter(Boolean);
    const fotosHtml = fotos.length? `<div class="fotos">${fotos.map(u=>`<figure><img src="${esc(u)}" alt="Foto da execução da atividade ${idx+1}"><figcaption>Atividade ${at?.codigo||idx+1} — foto ${idx+1}</figcaption></figure>`).join('')}</div>` : '<div style="color:#999;">Sem fotos registradas.</div>';
    return `<tr>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${idx+1}</td>
      <td style="border:1px solid #999;padding:4px 8px;" class="mono">${esc(at?.codigo||'?')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(at?.descricao||'')}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${p? fmtNum(p):'—'}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;"><strong>${e!=null? fmtNum(e):'—'}</strong></td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;font-weight:700;color:${pct>=100?'#1c7d1c':pct>=50?'#b8860b':'#b33'};">${p? pct+'%':'—'}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;">${fmtMoney(execVal)}</td>
    </tr><tr><td colspan="8" style="border:1px solid #999;padding:8px;background:#fafafa;">${fotosHtml}</td></tr>`;
  }).join('') || '<tr><td colspan="8" style="border:1px solid #999;padding:4px 8px;">Sem atividades registradas.</td></tr>';
  const hist = x.atribuicao.historico||[];
  const histRows = hist.length? hist.slice().reverse().map(h=>`<tr>
      <td style="border:1px solid #999;padding:4px 8px;">${fmtDateTime(h.ts)}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.tipo||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.de||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.para||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.motivo||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.usuarioNome||'—')}${h.usuarioLogin? ' ('+esc(h.usuarioLogin)+')':''}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="border:1px solid #999;padding:4px 8px;color:#999;">Sem registros de histórico.</td></tr>';

  const w = window.open('', '_blank', 'width=1100,height=800');
  if(!w) return;
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>RDO ${progGid(x.programacao)} — ${esc(pr?.codigo||'')}</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#222;margin:24px 30px;}
    h1{font-size:18px;margin:0 0 2px;}
    h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #444;padding-bottom:3px;}
    h3{font-size:12.5px;margin:12px 0 4px;}
    .meta{color:#555;font-size:11.5px;margin:2px 0;}
    .grid{display:flex;gap:40px;flex-wrap:wrap;}
    table{border-collapse:collapse;width:100%;}
    th{background:#eee;text-align:left;padding:4px 8px;border:1px solid #999;}
    td{padding:4px 8px;border:1px solid #999;}
    .mono{font-family:Consolas,monospace;font-size:11px;}
    .fotos{display:flex;flex-wrap:wrap;gap:12px;}
    .fotos figure{margin:0;width:210px;border:1px solid #ccc;border-radius:4px;padding:6px;background:#fff;}
    .fotos img{width:100%;height:auto;border-radius:3px;}
    .fotos figcaption{font-size:10px;color:#666;margin-top:4px;}
    .assin{display:flex;gap:60px;margin-top:46px;}
    .assin div{flex:1;text-align:center;font-size:11px;color:#555;}
    .assin .linha{border-top:1px solid #333;padding-top:6px;margin-top:34px;}
    .badge-print{display:inline-block;border:1px solid #999;border-radius:4px;padding:2px 8px;font-size:11px;}
  </style></head><body>
    <h1>Relatório de RDO — Detalhes da Execução</h1>
    <p class="meta">Programação ${progGid(x.programacao)} · Ciclo ${esc(x.programacao.ciclo||'—')} · Data programada ${fmtDate(x.atribuicao.dataProgramada)}</p>
    <p class="meta">Gerado por: <strong>${esc(geradoPor)}</strong> em ${fmtDateTime(Date.now())} · Status: ${esc(x.atribuicao.status||'Programado')}</p>

    <h2>Dados gerais do projeto</h2>
    <div class="grid">
      <div>
        <p class="meta"><strong>${esc(pr?.nome||'—')}</strong> (${esc(pr?.codigo||'—')})</p>
        <p class="meta">Setor: ${esc(pr?.setor||'—')} · Coordenação: ${esc(pr?.coordenacao||'—')}</p>
        <p class="meta">Cidade: ${esc(pr?.cidade||'—')}</p>
        <p class="meta">Período: ${fmtDate(pr?.dataInicio)} → ${fmtDate(pr?.dataFim)}</p>
      </div>
      <div>
        <p class="meta">Valor orçado: <strong>${fmtMoney(pr?.valorOrcado||0)}</strong></p>
        <p class="meta">Valor executado: <strong>${fmtMoney(av?.valorExecutado||0)}</strong></p>
        <p class="meta">Avanço físico: <strong>${av? av.fisicoPct.toFixed(1)+'%' : '—'}</strong></p>
        <p class="meta">Avanço financeiro: <strong>${av? av.financeiroPct.toFixed(1)+'%' : '—'}</strong></p>
      </div>
    </div>

    <h2>Localização</h2>
    <p class="meta">Referência: <strong>${esc(pr?.cidade||'—')}</strong> · Setor ${esc(pr?.setor||'—')} · Coordenação ${esc(pr?.coordenacao||'—')}</p>

    <h2>Equipe executora</h2>
    <div class="grid">
      <div>
        <p class="meta"><strong>${esc(equipeLabel(eq))}</strong></p>
        <p class="meta">Supervisor: ${esc(eq?.supervisor||'—')}</p>
        <p class="meta">Encarregado: ${esc(eq?.encarregado||'—')}</p>
      </div>
      <div>
        <p class="meta">Motorista: ${esc(eq?.motorista||'—')}</p>
        <p class="meta">Eletricistas: ${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</p>
        <p class="meta">WhatsApp: ${esc(eq?.whatsapp||'—')}</p>
      </div>
    </div>

    <h2>Horários do RDO</h2>
    <table>${horarios}</table>

    <h2>KM do Veículo</h2>
    <table>${kmRows}</table>

    <h2>Condições do RDO</h2>
    <table>${condicoes}</table>
    <p class="meta" style="margin-top:8px;">Impedimentos: ${impedHtml}</p>

    <h2>Atividades executadas</h2>
    <p class="meta">Previsto: ${fmtNum(res.prev)} · Executado: <strong>${fmtNum(res.exec)}</strong> · Percentual: <strong>${res.pct}%</strong></p>
    <table>
      <thead><tr><th style="text-align:center;">#</th><th>Código</th><th>Descrição</th><th style="text-align:center;">Un.</th><th style="text-align:center;">Prev.</th><th style="text-align:center;">Exec.</th><th style="text-align:center;">%</th><th style="text-align:right;">Valor exec.</th></tr></thead>
      <tbody>${ativRows}</tbody>
    </table>

    <h2>Observação da execução</h2>
    <p>${esc(x.atribuicao.observacao)||'—'}</p>
    <p class="meta">Confirmado pela equipe em <strong>${rdoConfData(x)}</strong></p>

    ${(x.programacao.anexos&&x.programacao.anexos.length)? `<h2>Anexos do programador</h2>${anexosDisplayHtml(x.programacao.anexos, true)}`:''}

    <h2>Histórico do registro</h2>
    <table>
      <thead><tr><th>Data/Hora</th><th>Tipo</th><th>De</th><th>Para</th><th>Motivo</th><th>Autor</th></tr></thead>
      <tbody>${histRows}</tbody>
    </table>

    <div class="assin">
      <div>Supervisor<br><div class="linha">Assinatura e carimbo</div></div>
      <div>Encarregado<br><div class="linha">Assinatura e carimbo</div></div>
      <div>Responsável pelo projeto<br><div class="linha">Assinatura e carimbo</div></div>
    </div>
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},800);});<\/script>
  </body></html>`);
  w.document.close();
}

/* RDO PODA/OSE: mesmo padrão do RDO de projetos */
function printRDOTipoCompleto(x, tipo){
  const eq = findEquipe(x.atribuicao.equipeId);
  const rdo = x.atribuicao.rdoRespostas||{};
  const res = rdoResumo(x);
  const imped = rdoImpedimentos(x.atribuicao);
  const p = x.programacao;
  const titulo = tipo==='poda'? 'PODA' : 'OSE';
  const gidLabel = tipo==='poda'? podaProgLabel(p) : oseProgLabel(p);
  const geradoPor = CURRENT_USER ? ((CURRENT_USER.nome||'') + (CURRENT_USER.login? ' ('+CURRENT_USER.login+')':'') || 'Sistema') : 'Sistema';
  const horarios = RDO_HORARIOS.map(h=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${h.label}</td><td style="border:1px solid #999;padding:4px 8px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');
  const kmRows = RDO_KM.map(h=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${h.label}</td><td style="border:1px solid #999;padding:4px 8px;">${x.atribuicao[h.k]||'—'}</td></tr>`).join('');
  const condicoes = RDO_QUESTIONS.map(q=>`<tr><td style="border:1px solid #999;padding:4px 8px;font-weight:600;background:#f5f5f5;">${q.label}</td><td style="border:1px solid #999;padding:4px 8px;">${String(rdo[q.id]||'')||'—'}</td></tr>`).join('');
  const impedHtml = imped.length? imped.map(i=>`<span style="display:inline-block;border:1px solid #d95555;color:#b33;background:#fdecec;border-radius:4px;padding:2px 8px;margin:2px 3px 2px 0;">${esc(i)}</span>`).join('') : '—';
  const ativRows = (x.atribuicao.atividades||[]).map((a,idx)=>{
    const at = findAtividade(a.atividadeId);
    const pv = parseFloat(a.quantidadePrevista)||0;
    const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
    const pct = pv? Math.round((e||0)/pv*100) : 0;
    const vu = at?.valorUnitario||0;
    const execVal = e!=null? e*vu : 0;
    const fotos = String(a.fotos||'').split(';;').filter(Boolean);
    const fotosHtml = fotos.length? `<div class="fotos">${fotos.map(u=>`<figure><img src="${esc(u)}" alt="Foto da execução da atividade ${idx+1}"><figcaption>Atividade ${at?.codigo||idx+1} — foto ${idx+1}</figcaption></figure>`).join('')}</div>` : '<div style="color:#999;">Sem fotos registradas.</div>';
    const anomCell = tipo==='ose'? `<td style="border:1px solid #999;padding:4px 8px;text-align:center;">${esc(String(a.qtdAnomalia??'—')+' → '+String(a.qtdAnomaliaExecutada??'—'))}</td>` : '';
    const nCols = tipo==='ose'? 9 : 8;
    return `<tr>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${idx+1}</td>
      <td style="border:1px solid #999;padding:4px 8px;" class="mono">${esc(at?.codigo||'?')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(at?.descricao||'')}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;">${pv? fmtNum(pv):'—'}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;"><strong>${e!=null? fmtNum(e):'—'}</strong></td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:center;font-weight:700;color:${pct>=100?'#1c7d1c':pct>=50?'#b8860b':'#b33'};">${pv? pct+'%':'—'}</td>
      ${anomCell}
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;">${fmtMoney(execVal)}</td>
    </tr><tr><td colspan="${nCols}" style="border:1px solid #999;padding:8px;background:#fafafa;">${fotosHtml}</td></tr>`;
  }).join('') || `<tr><td colspan="${tipo==='ose'? 9:8}" style="border:1px solid #999;padding:4px 8px;">Sem atividades registradas.</td></tr>`;
  const hist = x.atribuicao.historico||[];
  const histRows = hist.length? hist.slice().reverse().map(h=>`<tr>
      <td style="border:1px solid #999;padding:4px 8px;">${fmtDateTime(h.ts)}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.tipo||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.de||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.para||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.motivo||'—')}</td>
      <td style="border:1px solid #999;padding:4px 8px;">${esc(h.usuarioNome||'—')}${h.usuarioLogin? ' ('+esc(h.usuarioLogin)+')':''}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="border:1px solid #999;padding:4px 8px;color:#999;">Sem registros de histórico.</td></tr>';

  const dadosGerais = tipo==='poda' ? `
    <h2>Dados gerais da programação</h2>
    <div class="grid">
      <div>
        <p class="meta"><strong>${esc(gidLabel)}</strong></p>
        <p class="meta">OSI: ${esc(p.osi||'—')} · Subestação: ${esc(p.subestacao||'—')}</p>
        <p class="meta">Tipo Rede: ${esc(p.tipoRede||'—')} · Chave: ${esc(p.chave||'—')}</p>
        <p class="meta">ID-SIPROG: ${esc(p.idSiprog||'—')} · OSE: ${esc(p.ose||'—')}</p>
      </div>
      <div>
        <p class="meta">Qtd Anomalia: ${esc(p.qtdAnomalia||'—')}</p>
        <p class="meta">Status Documentação: ${esc(p.statusDocumentacao||'—')}</p>
        <p class="meta">Observações: ${esc(p.observacoes||'—')}</p>
      </div>
    </div>` : `
    <h2>Dados gerais da programação</h2>
    <div class="grid">
      <div>
        <p class="meta"><strong>${esc(gidLabel)}</strong></p>
        <p class="meta">Município: ${esc(p.municipio||'—')} · Subestação: ${esc(p.subestacao||'—')}</p>
        <p class="meta">Tipo Intervenção: ${esc(p.tipoIntervencao||'—')}</p>
        <p class="meta">Observações: ${esc(p.observacoes||'—')}</p>
      </div>
    </div>`;
  const localHtml = `
    <h2>Localização</h2>
    <p class="meta">Referência: <strong>${esc(p.local||'—')}</strong>${(p.localLat&&p.localLng)? ` · <a href="https://www.google.com/maps?q=${p.localLat},${p.localLng}" target="_blank">Ver no mapa</a>`:''}</p>`;

  const w = window.open('', '_blank', 'width=1100,height=800');
  if(!w) return;
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>RDO ${titulo} ${gidLabel}</title>
  <style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#222;margin:24px 30px;}
    h1{font-size:18px;margin:0 0 2px;}
    h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #444;padding-bottom:3px;}
    h3{font-size:12.5px;margin:12px 0 4px;}
    .meta{color:#555;font-size:11.5px;margin:2px 0;}
    .grid{display:flex;gap:40px;flex-wrap:wrap;}
    table{border-collapse:collapse;width:100%;}
    th{background:#eee;text-align:left;padding:4px 8px;border:1px solid #999;}
    td{padding:4px 8px;border:1px solid #999;}
    .mono{font-family:Consolas,monospace;font-size:11px;}
    .fotos{display:flex;flex-wrap:wrap;gap:12px;}
    .fotos figure{margin:0;width:210px;border:1px solid #ccc;border-radius:4px;padding:6px;background:#fff;}
    .fotos img{width:100%;height:auto;border-radius:3px;}
    .fotos figcaption{font-size:10px;color:#666;margin-top:4px;}
    .assin{display:flex;gap:60px;margin-top:46px;}
    .assin div{flex:1;text-align:center;font-size:11px;color:#555;}
    .assin .linha{border-top:1px solid #333;padding-top:6px;margin-top:34px;}
    .badge-print{display:inline-block;border:1px solid #999;border-radius:4px;padding:2px 8px;font-size:11px;}
  </style></head><body>
    <h1>Relatório de RDO — Detalhes da Execução (${titulo})</h1>
    <p class="meta">Programação ${esc(gidLabel)} · Data programada ${fmtDate(x.atribuicao.dataProgramada)}</p>
    <p class="meta">Gerado por: <strong>${esc(geradoPor)}</strong> em ${fmtDateTime(Date.now())} · Status: ${esc(x.atribuicao.status||'Programado')}</p>

    ${dadosGerais}
    ${localHtml}

    <h2>Equipe executora</h2>
    <div class="grid">
      <div>
        <p class="meta"><strong>${esc(equipeLabel(eq))}</strong></p>
        <p class="meta">Supervisor: ${esc(eq?.supervisor||'—')}</p>
        <p class="meta">Encarregado: ${esc(eq?.encarregado||'—')}</p>
      </div>
      <div>
        <p class="meta">Motorista: ${esc(eq?.motorista||'—')}</p>
        <p class="meta">Eletricistas: ${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</p>
        <p class="meta">WhatsApp: ${esc(eq?.whatsapp||'—')}</p>
      </div>
    </div>

    <h2>Horários do RDO</h2>
    <table>${horarios}</table>

    <h2>KM do Veículo</h2>
    <table>${kmRows}</table>

    <h2>Condições do RDO</h2>
    <table>${condicoes}</table>
    <p class="meta" style="margin-top:8px;">Impedimentos: ${impedHtml}</p>

    <h2>Atividades executadas</h2>
    <p class="meta">Previsto: ${fmtNum(res.prev)} · Executado: <strong>${fmtNum(res.exec)}</strong> · Percentual: <strong>${res.pct}%</strong></p>
    <table>
      <thead><tr><th style="text-align:center;">#</th><th>Código</th><th>Descrição</th><th style="text-align:center;">Un.</th><th style="text-align:center;">Prev.</th><th style="text-align:center;">Exec.</th><th style="text-align:center;">%</th>${tipo==='ose'? '<th style="text-align:center;" title="Anomalias programadas → executadas">Anom.</th>':''}<th style="text-align:right;">Valor exec.</th></tr></thead>
      <tbody>${ativRows}</tbody>
    </table>

    <h2>Observação da execução</h2>
    <p>${esc(x.atribuicao.observacao)||'—'}</p>
    <p class="meta">Confirmado pela equipe em <strong>${rdoConfData(x)}</strong></p>

    ${(p.anexos&&p.anexos.length)? `<h2>Anexos do programador</h2>${anexosDisplayHtml(p.anexos, true)}`:''}

    <h2>Histórico do registro</h2>
    <table>
      <thead><tr><th>Data/Hora</th><th>Tipo</th><th>De</th><th>Para</th><th>Motivo</th><th>Autor</th></tr></thead>
      <tbody>${histRows}</tbody>
    </table>

    <div class="assin">
      <div>Supervisor<br><div class="linha">Assinatura e carimbo</div></div>
      <div>Encarregado<br><div class="linha">Assinatura e carimbo</div></div>
      <div>Responsável pela execução<br><div class="linha">Assinatura e carimbo</div></div>
    </div>
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},800);});<\/script>
  </body></html>`);
  w.document.close();
}

function rdoTipoLabel(tipo, p){ return tipo==='poda'? podaProgLabel(p) : oseProgLabel(p); }
function rdoTipoSub(tipo, p){
  return tipo==='poda'
    ? [p.osi? 'OSI '+p.osi : '', p.subestacao? 'SE '+p.subestacao : ''].filter(Boolean).join(' · ')
    : [p.municipio||'', p.subestacao? 'SE '+p.subestacao : ''].filter(Boolean).join(' · ');
}
function exportRDOTipo(registros, tipo){
  const linhas=[];
  registros.forEach(x=>{
    const p = x.programacao;
    const eq = findEquipe(x.atribuicao.equipeId);
    const res = rdoResumo(x);
    const imped = rdoImpedimentos(x.atribuicao).join(', ');
    const cab = {
      'Programação': rdoTipoLabel(tipo,p),
      'Detalhe': rdoTipoSub(tipo,p),
      'Data Programada': fmtDate(x.atribuicao.dataProgramada),
      'Equipe': equipeLabel(eq),
      'Supervisor': eq?.supervisor||'',
      'Status': x.atribuicao.status||'Programado',
      'Quantidade Prevista': res.prev,
      'Quantidade Executada': res.exec,
      'Percentual': res.pct+'%',
      'Condições Climáticas': x.atribuicao.rdoCondicoes||'',
      'Impedimentos': imped,
      'Observação': x.atribuicao.observacao||'',
      'Confirmação': rdoConfData(x)
    };
    RDO_HORARIOS.forEach(h=> cab[h.label]= x.atribuicao[h.k]||'');
    RDO_KM.forEach(h=> cab[h.label]= x.atribuicao[h.k]||'');
    const detalhe = (x.atribuicao.atividades||[]).map((a,idx)=>{
      const at = findAtividade(a.atividadeId);
      const pv = parseFloat(a.quantidadePrevista)||0;
      const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
      return {
        'Programação': rdoTipoLabel(tipo,p),
        'Detalhe': rdoTipoSub(tipo,p),
        'Data Programada': fmtDate(x.atribuicao.dataProgramada),
        'Equipe': equipeLabel(eq),
        'Supervisor': eq?.supervisor||'',
        'Status': x.atribuicao.status||'Programado',
        '# Atividade': idx+1,
        'Código Atividade': at?.codigo||'—',
        'Descrição Atividade': at?.descricao||'',
        'Unidade': at?.unidade||'',
        'Qtd Prevista Atividade': a.quantidadePrevista||'',
        'Qtd Executada Atividade': e!=null? e:'',
        'Percentual Atividade': pv? Math.round((e||0)/pv*100)+'%':'',
        'Anomalias Programadas': a.qtdAnomalia??'',
        'Anomalias Executadas': a.qtdAnomaliaExecutada??'',
        'Fotos Atividade': a.fotos||''
      };
    });
    if(detalhe.length) linhas.push(...detalhe); else linhas.push(cab);
  });
  const cols = linhas.length? Object.keys(linhas[0]) : ['Programação','Detalhe'];
  const escapeCsv = v=> String(v??'').replace(/"/g,'""');
  let csv = '\ufeff' + cols.join(';') + '\n';
  linhas.forEach(l=>{ csv += cols.map(c=> `"${escapeCsv(l[c])}"`).join(';') + '\n'; });
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rdo_execucoes_${tipo}_${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exportação gerada.');
}

function printRDOReportTipo(registros, tipo){
  const w = window.open('', '_blank', 'width=1100,height=800');
  if(!w) return;
  const titulo = tipo==='poda'? 'PODA' : 'OSE';
  const rows = registros.map((x,i)=>{
    const eq = findEquipe(x.atribuicao.equipeId);
    const res = rdoResumo(x);
    const imped = rdoImpedimentos(x.atribuicao).join(', ');
    const horarios = [x.atribuicao.rdoHorarioChegada, x.atribuicao.rdoHorarioSaidaObra].filter(Boolean).join(' → ')||'—';
    return `<tr>
      <td style="border:1px solid #999;padding:4px 6px;">${i+1}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(rdoTipoLabel(tipo,x.programacao))}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(rdoTipoSub(tipo,x.programacao)||'—')}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(equipeLabel(eq))}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${fmtDate(x.atribuicao.dataProgramada)}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(x.atribuicao.status||'Programado')}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(horarios)}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(x.atribuicao.rdoCondicoes||'—')}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${imped? esc(imped):'—'}</td>
      <td style="border:1px solid #999;padding:4px 6px;text-align:right;">${fmtNum(res.exec)}</td>
      <td style="border:1px solid #999;padding:4px 6px;text-align:right;">${res.pct}%</td>
    </tr>`;
  }).join('');
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>RDO ${titulo} — Execução das equipes</title></head><body style="font-family:Arial,sans-serif;font-size:12px;">
    <h2 style="margin:0 0 4px;">RDO ${titulo} — Relatório de Execução das Equipes</h2>
    <p style="margin:0 0 16px;color:#555;">Gerado em ${fmtDateTime(Date.now())} · ${registros.length} registro(s)</p>
    <table style="border-collapse:collapse;width:100%;">
      <thead><tr style="background:#eee;">
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">#</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Programação</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Detalhe</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Equipe</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Data</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Status</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Horários</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Clima</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Impedimentos</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:right;">Exec.</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:right;">%</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=function(){setTimeout(function(){window.print();},200);};<\/script>
  </body></html>`);
  w.document.close();
}

function exportRDOExcel(registros){
  const linhas=[];
  registros.forEach(x=>{
    const pr = findProjeto(x.programacao.projetoId);
    const eq = findEquipe(x.atribuicao.equipeId);
    const rdo = x.atribuicao.rdoRespostas||{};
    const res = rdoResumo(x);
    const imped = rdoImpedimentos(x.atribuicao).join(', ');
    const base = {
        'Programação': progGid(x.programacao),
      'Projeto': pr?.nome||'—',
      'Código Projeto': pr?.codigo||'',
      'Ciclo': x.programacao.ciclo||'—',
      'Data Programada': fmtDate(x.atribuicao.dataProgramada),
      'Equipe': equipeLabel(eq),
      'Supervisor': eq?.supervisor||'',
      'Status': x.atribuicao.status||'Programado',
      'Quantidade Prevista': res.prev,
      'Quantidade Executada': res.exec,
      'Percentual': res.pct+'%',
      'Condições Climáticas': x.atribuicao.rdoCondicoes||'',
      'Impedimentos': imped,
      'Observação': x.atribuicao.observacao||'',
      'Confirmação': rdoConfData(x)
    };
    RDO_HORARIOS.forEach(h=> base[h.label]= x.atribuicao[h.k]||'');
    RDO_KM.forEach(h=> base[h.label]= x.atribuicao[h.k]||'');
    const detalhe = (x.atribuicao.atividades||[]).map((a,idx)=>{
      const at = findAtividade(a.atividadeId);
      const p = parseFloat(a.quantidadePrevista)||0;
      const e = a.quantidadeExecutada==null? null : parseFloat(a.quantidadeExecutada);
      return {
      'Programação': progGid(x.programacao),
        'Projeto': pr?.nome||'—',
        'Código Projeto': pr?.codigo||'',
        'Ciclo': x.programacao.ciclo||'—',
        'Data Programada': fmtDate(x.atribuicao.dataProgramada),
        'Equipe': equipeLabel(eq),
        'Supervisor': eq?.supervisor||'',
        'Status': x.atribuicao.status||'Programado',
        '# Atividade': idx+1,
        'Código Atividade': at?.codigo||'—',
        'Descrição Atividade': at?.descricao||'',
        'Unidade': at?.unidade||'',
        'Qtd Prevista Atividade': a.quantidadePrevista||'',
        'Qtd Executada Atividade': e!=null? e:'',
        'Percentual Atividade': p? Math.round((e||0)/p*100)+'%':'',
        'Fotos Atividade': a.fotos||''
      };
    });
    if(detalhe.length){
      linhas.push(...detalhe);
    }else{
      linhas.push(base);
    }
  });
  const cols = linhas.length? Object.keys(linhas[0]) : ['Programação','Projeto'];
  const escape = v=> String(v??'').replace(/"/g,'""');
  let csv = '\ufeff' + cols.join(';') + '\n';
  linhas.forEach(l=>{ csv += cols.map(c=> `"${escape(l[c])}"`).join(';') + '\n'; });
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rdo_execucoes_${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exportação gerada.');
}

function printRDOReport(registros){
  const w = window.open('', '_blank', 'width=1100,height=800');
  if(!w) return;
  const rows = registros.map((x,i)=>{
    const pr = findProjeto(x.programacao.projetoId);
    const eq = findEquipe(x.atribuicao.equipeId);
    const res = rdoResumo(x);
    const imped = rdoImpedimentos(x.atribuicao).join(', ');
    return `<tr>
      <td style="border:1px solid #999;padding:4px 6px;">${i+1}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(pr?.nome||'—')}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${esc(equipeLabel(eq))}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${fmtDate(x.atribuicao.dataProgramada)}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${x.atribuicao.status||'Programado'}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${x.atribuicao.rdoHorarioChegada||'—'} → ${x.atribuicao.rdoHorarioSaidaObra||'—'}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${x.atribuicao.rdoCondicoes||'—'}</td>
      <td style="border:1px solid #999;padding:4px 6px;">${imped||'—'}</td>
      <td style="border:1px solid #999;padding:4px 6px;text-align:right;">${fmtNum(res.exec)}</td>
      <td style="border:1px solid #999;padding:4px 6px;text-align:right;">${res.pct}%</td>
    </tr>`;
  }).join('');
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>RDO — Execução das equipes</title></head><body style="font-family:Arial,sans-serif;font-size:12px;">
    <h2 style="margin:0 0 4px;">RDO — Relatório de Execução das Equipes</h2>
    <p style="margin:0 0 16px;color:#555;">Gerado em ${fmtDateTime(Date.now())} · ${registros.length} registro(s)</p>
    <table style="border-collapse:collapse;width:100%;">
      <thead><tr style="background:#eee;">
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">#</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Projeto</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Equipe</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Data</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Status</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Horários</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Clima</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:left;">Impedimentos</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:right;">Exec.</th>
        <th style="border:1px solid #999;padding:4px 6px;text-align:right;">%</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=function(){setTimeout(function(){window.print();},200);};<\/script>
  </body></html>`);
  w.document.close();
}
function openProgramacaoDetalheModal(id){
  if(!progVisivelPorId(id)){ toast('Você não tem permissão para acessar esta programação.', 'error'); return; }
  const pg = DB.programacoes.find(x=>x.id===Number(id));
  if(!pg){ toast('Programação não encontrada.', 'error'); return; }
  const pr = findProjeto(pg.projetoId);
  const eq = (pg.atribuicoes||[]).map(a=>findEquipe(a.equipeId)).find(Boolean);
  const atrib = (pg.atribuicoes||[])[0];
  const headTitulo = 'Programação — '+(pr?.nome||'Projeto')+' ('+(pr?.codigo||'')+')';
  const headSub = [teamGidLabel(pg),
    pr?.ciclo? 'Ciclo '+pr.ciclo : '',
    eq? equipeLabel(eq) : ''
  ].filter(Boolean).join(' — ');
  const rows = (atrib?.atividades||[]).map((a,idx)=>{
    const at = findAtividade(DB, a.atividadeId);
    return `<tr>
      <td style="text-align:center;">${idx+1}</td>
      <td class="mono" style="font-weight:700;">${esc(at?.codigo||'?')}</td>
      <td>${esc(at?.descricao||'')}</td>
      <td style="text-align:center;">${esc(at?.unidade||'')}</td>
      <td style="text-align:center;">${a.quantidadePrevista??'—'}</td>
      <td style="height:22px;"></td>
      <td></td>
    </tr>`;
  }).join('');
  const body = `
  <div class="print-sheet">
    <div class="ps-head">
      <div><h1>G26 New · Programação de Redes Elétricas</h1><div class="ps-sub">Documento de campo — visualização</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(atrib?.dataProgramada||pg.dataProgramada)}</div><div class="ps-sub">Emissão: ${fmtDateTime(Date.now())}</div></div>
    </div>
    <div class="ps-block">
      <div class="ps-block-head">
        <div>${pg.gid||'G26-'+String(pg.id).padStart(7,'0')} — ${esc(pr?.nome||'Projeto')} (${esc(pr?.codigo||'')}) — ${esc(equipeLabel(eq))} — ${fmtDate(atrib?.dataProgramada||pg.dataProgramada)}</div>
        <div class="ps-qr"></div>
      </div>
      <table class="ps-info">
        <tr><th>Supervisor</th><td>${esc(eq?.supervisor||'—')}</td><th>Encarregado</th><td>${esc(eq?.encarregado||'—')}</td></tr>
        <tr><th>Motorista</th><td>${esc(eq?.motorista||'—')}</td><th>Eletricistas</th><td>${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</td></tr>
        <tr><th>Ciclo</th><td>${esc(pg.ciclo||'—')}</td><th>Setor</th><td>${esc(pr?.setor||'—')}</td></tr>
      </table>
      ${pg.local? `<div style="margin:10px 0;"><strong>Local de execução:</strong><br>${esc(pg.local)}</div>`:''}
      <table>
        <thead><tr><th style="width:26px;">#</th><th>Código</th><th>Descrição</th><th style="width:40px;">Un.</th><th style="width:52px;">Qtd prev.</th><th style="width:64px;">Qtd exec.</th><th>Obs.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ps-check"><div><strong>Executou?</strong> &nbsp;☐ SIM &nbsp;☐ NÃO &nbsp;☐ PARCIAL</div><div><strong>Data da execução:</strong> ____/____/____</div></div>
      <div class="ps-sign"><strong>Observações do campo:</strong><div class="ps-obs"></div></div>
      <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
    </div>
  </div>`;
  openModal({
    title: headTitulo, bodyHtml: body, submitLabel: 'Fechar',
    onSubmit:()=>{ /* Apenas fechar */ }
  });
}
