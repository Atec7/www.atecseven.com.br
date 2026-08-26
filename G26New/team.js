/* =========================================================
   G26 New · Página da equipe (offline-first + sync automático)
   Permite editar APENAS as atividades/quantidades da programação,
   com observação obrigatória. Funciona offline (fila local) e
   sincroniza sozinho quando a internet volta.
   - RDO: antes de visualizar os dados da equipe, o usuário deve
     responder ao questionário Saída da Base Obrigatória (RDO).
   - Permite envio após a data, mas registra atraso visível.
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
const rtdb = firebase.initializeApp(firebaseConfig);
const database = firebase.database(rtdb);
const DB_REF = database.ref('g26_planner/data');
const PRES_REF = database.ref('g26_planner/presenca');
const ACCIDENT_REF = database.ref('g26_planner/acidentes');
let presTeamHeartbeat = null;
function registrarPresencaTeam(){
  if(!progId && !ocndsId && !podaId && !oseId) return;
  try{
    if(isOcndsMode && ocndsId && DB){
      const item = (DB.ocnds||[]).find(p=>p.id===ocndsId);
      const eq = item ? findEquipe(DB, item.equipeId) : null;
      const nome = eq ? equipeLabel(eq) : 'OC/NDS #'+ocndsId;
      const lbl = item?.gid || ('G26-'+String(ocndsId).padStart(7,'0'));
      const info = { login:'equipe-ocnds-'+ocndsId, nome, role:'equipe', view:'pagina-equipe-ocnds', prog:lbl, ts:Date.now() };
      PRES_REF.child(info.login).set(info);
      PRES_REF.child(info.login).onDisconnect().remove();
      return;
    }
    if(!teamNumericId()) return;
    let nome = 'Equipe #'+teamNumericId();
    let progLabel = '';
    if(DB){
      const pg = teamFindProg(DB);
      if(pg){
        progLabel = teamGidLabel(pg);
        const eq = findEquipe(DB, (pg.atribuicoes||[])[0]?.equipeId);
        if(eq) nome = equipeLabel(eq);
      }
    }
    const m = teamMode();
    const view = 'pagina-equipe'+(m==='poda'?'-poda':m==='ose'?'-ose':'');
    const info = { login:'equipe-'+teamKey(), nome, role:'equipe', view, prog:progLabel, ts:Date.now() };
    PRES_REF.child(info.login).set(info);
    PRES_REF.child(info.login).onDisconnect().remove();
  }catch(e){}
}
function iniciarPresencaTeam(){
  registrarPresencaTeam();
  clearInterval(presTeamHeartbeat);
  presTeamHeartbeat = setInterval(registrarPresencaTeam, 15000);
}
function pararPresencaTeam(){
  clearInterval(presTeamHeartbeat); presTeamHeartbeat=null;
  try{ if(isOcndsMode) PRES_REF.child('equipe-ocnds-'+ocndsId).remove(); else if(teamNumericId()) PRES_REF.child('equipe-'+teamKey()).remove(); }catch(e){}
}

const QUEUE_KEY = 'g26_equipe_queue';
const CACHE_KEY = 'g26_equipe_cache';

function loadQueue(){ try{ return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]'); }catch(e){ return []; } }
function saveQueue(q){ try{ localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }catch(e){} }
function loadCache(){ try{ return JSON.parse(localStorage.getItem(CACHE_KEY)||'null'); }catch(e){ return null; } }
function saveCache(db){ try{ localStorage.setItem(CACHE_KEY, JSON.stringify(db)); }catch(e){} }

/* --- helpers --- */
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtDate(iso){ if(!iso) return '—'; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function fmtDateTime(ts){ const d=new Date(ts); return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function findProjeto(db,id){ return db.projetos.find(p=>p.id===Number(id)); }
function findEquipe(db,id){ return db.equipes.find(e=>e.id===Number(id)); }
function findAtividade(db,id){ return db.atividades.find(a=>a.id===Number(id)); }
function equipeLabel(eq){ if(!eq) return '—'; const parts=[]; if(eq.eqtl) parts.push(eq.eqtl); if(eq.prtn) parts.push(eq.prtn); return parts.length? parts.join(' / ') : ('Equipe #'+eq.id); }
function eqtlLabel(eq){ return (eq && eq.eqtl)? eq.eqtl : '—'; }
function prtnLabel(eq){ return (eq && eq.prtn)? eq.prtn : '—'; }
/* --- Local / mapa (Geoapify + fallback OSM) --- */
const MAPS_KEY = 'cb9a3186df512370a0b85db130ca34d1';
function mapsLinkByAddress(addr){ return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(String(addr||'').trim()); }
function mapsLinkByCoords(lat,lng){ return 'https://www.google.com/maps/search/?api=1&query='+Number(lat)+','+Number(lng); }
function staticMapUrl(lat,lng,zoom,w,h){
  const z = zoom||16, width = w||640, height = h||360;
  return `https://maps.geoapify.com/v1/staticmap?style=osm-bright-smooth&width=${width}&height=${height}&center=lonlat:${Number(lng)},${Number(lat)}&zoom=${z}&scaleFactor=2&marker=lonlat:${Number(lng)},${Number(lat)};type:material;color:%23e02020;size:normal&apiKey=${MAPS_KEY}`;
}
function staticMapFallbackUrl(lat,lng,zoom,w,h){
  const z = zoom||16, width = w||640, height = h||360;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${Number(lat)},${Number(lng)}&zoom=${z}&size=${width}x${height}&markers=${Number(lat)},${Number(lng)},red-pushpin`;
}
function staticMapImgTag(lat,lng,zoom,w,h,alt,style){
  const geo = staticMapUrl(lat,lng,zoom,w,h);
  const fb = staticMapFallbackUrl(lat,lng,zoom,w,h);
  return `<img src="${esc(geo)}" alt="${esc(alt||'Mapa')}" style="${esc(style||'width:100%;max-width:520px;border-radius:8px;border:1px solid var(--border-soft);display:block;')}" onerror="this.onerror=null; this.src='${esc(fb)}';">`;
}
function qrCodeUrl(data, size=120){
  return 'https://api.qrserver.com/v1/create-qr-code/?size='+size+'x'+size+'&data='+encodeURIComponent(data);
}
function toast(msg, kind){
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div'); t.className='toast';
  if(kind==='error') t.style.borderLeftColor='var(--red)';
  t.textContent=msg; wrap.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='.25s'; setTimeout(()=>t.remove(),250); }, 3400);
}
function openModal({title, bodyHtml, onSubmit, submitLabel='Salvar'}){
  const existing = document.getElementById('team-modal-overlay');
  if(existing) existing.remove();
  const root = document.body;
  const modalHtml = `
    <div class="modal-overlay" id="team-modal-overlay">
      <div class="modal" style="max-width:560px;">
        <div class="modal-head"><h3>${title}</h3><button class="icon-btn" id="team-modal-close">${icon('close')}</button></div>
        <form id="team-modal-form">
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-foot"><button type="button" class="btn btn-ghost" id="team-modal-cancel">Cancelar</button><button type="submit" class="btn btn-primary">${submitLabel}</button></div>
        </form>
      </div>
    </div>`;
  root.insertAdjacentHTML('beforeend', modalHtml);
  const overlay = document.getElementById('team-modal-overlay');
  const close = ()=>{ overlay.remove(); };
  overlay.querySelector('#team-modal-close').addEventListener('click', close);
  overlay.querySelector('#team-modal-cancel').addEventListener('click', close);
  overlay.querySelector('#team-modal-form').addEventListener('submit', (e)=>{ e.preventDefault(); const ok = onSubmit(new FormData(e.target)); if(ok!==false) close(); });
}
const ICONS = {
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  alert:'<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  camera:'<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'
};

/* ── FOTOS DOS REGISTROS (IMGGB) ── */
var IMGGB_KEY = '95bb16ee776d7e20f26857cec98bd372';
var FOTOS_SEP = ';;';
var _fotos = {};        // _fotos[eqId] = [ [File,...], [File,...], ... ] (uma lista por linha de atividade)
var _fotosEnviando = false;
function icon(name,size=18){ return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||''}</svg>`; }

/* --- estado --- */
let DB = null;
const progId = Number(new URLSearchParams(location.search).get('equipe')) || null;
const ocndsId = Number(new URLSearchParams(location.search).get('ocnds')) || null;
const podaId = Number(new URLSearchParams(location.search).get('poda')) || null;
const oseId = Number(new URLSearchParams(location.search).get('ose')) || null;
let isOcndsMode = !!ocndsId;

/* Modo da página: 'prog' (projetos), 'poda', 'ose' ou 'ocnds' */
function teamMode(){ return isOcndsMode? 'ocnds' : (podaId? 'poda' : (oseId? 'ose' : 'prog')); }
function teamCollectionName(){
  const m = teamMode();
  return m==='poda'? 'podaProgramacoes' : m==='ose'? 'oseProgramacoes' : 'programacoes';
}
function teamNumericId(){ return podaId || oseId || progId; }
function teamKey(){
  const m = teamMode();
  return m==='ocnds'? ('ocnds_'+ocndsId) : m==='poda'? ('poda_'+podaId) : m==='ose'? ('ose_'+oseId) : String(progId);
}
function teamGidLabel(p){
  if(!p) return '';
  if(p.gid) return p.gid;
  const pre = { poda:'PODA-', ose:'OSE-' }[teamMode()] || 'G26-';
  return pre+String(p.id).padStart(7,'0');
}
function teamFindProg(db){
  if(isOcndsMode) return ((db||{}).ocnds||[]).find(p=>p.id===ocndsId)||null;
  return ((db||{})[teamCollectionName()]||[]).find(p=>p.id===teamNumericId())||null;
}
function teamDataRef(){
  if(!prog) return null;
  return prog.dataProgramada || prog.dataProgramacao || ((prog.atribuicoes||[])[0]||{}).dataProgramada || null;
}
let ocndsItem = null;
let prog = null;
let editors = {};
let observacao = '';
let online = navigator.onLine !== false;
let syncing = false;
let rdoCompletado = false;
let enviado = false;
const statusEl = document.getElementById('team-status');

function setStatus(txt, kind){
  if(!statusEl) return;
  statusEl.textContent = txt;
  statusEl.className = 'team-conn ' + (kind||'');
}

function diasAtrasoProgramacao(){
  const dataRef = teamDataRef();
  if(!prog || !dataRef) return 0;
  if(['Concluído','Cancelado'].includes(prog.status||'')) return 0;
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const progData = new Date(dataRef); progData.setHours(0,0,0,0);
  const diff = Math.floor((hoje - progData) / 86400000);
  return diff > 0 ? diff : 0;
}
function atrasoLabel(dias){
  if(!dias) return '';
  return `Enviado ${dias} dia${dias>1?'s':''} após a programação prevista`;
}

function dbToEditors(db){
  if(!db) return null;

  if(isOcndsMode && ocndsId){
    const item = (db.ocnds||[]).find(p=>p.id===ocndsId);
    if(!item) return null;
    ocndsItem = item;
    editors = {};
    editors[item.equipeId] = (item.atividades||[]).map(a=>({atividadeId:String(a.atividadeId||''), quantidadePrevista: a.quantidadePrevista??'', quantidadeExecutada: a.quantidadeExecutada??''}));
    if(!editors[item.equipeId] || !editors[item.equipeId].length){
      editors[item.equipeId] = [{atividadeId:'',quantidadePrevista:'',quantidadeExecutada:''}];
    }
    return item;
  }

  if(!teamNumericId()) return null;
  const pg = teamFindProg(db);
  if(!pg) return null;
  prog = pg;
  editors = {};
  (pg.atribuicoes||[]).forEach(at=>{
    editors[at.equipeId] = (at.atividades||[]).map(a=>({ atividadeId:String(a.atividadeId), quantidadePrevista: a.quantidadePrevista??'', quantidadeExecutada: a.quantidadeExecutada??'', qtdAnomalia: a.qtdAnomalia??'', qtdAnomaliaExecutada: a.qtdAnomaliaExecutada??'' }));
  });
  return pg;
}

/* --- RDO QUESTIONNAIRE --- */
const RDO_PERGUNTAS = [
  { id: 'rdo_condicoes', label: 'Condições climáticas', tipo: 'select', options: ['Bom','Nublado','Chuvoso','Impraticável'] },
  { id: 'rdo_impedimento', label: 'Impedimento de execução (Marque somente se a resposta for sim)', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_falta_material', label: 'Falta de material', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_projeto_incoerente', label: 'Projeto Incoerente', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_equipe_incompleta', label: 'Equipe incompleta', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_falta_veiculo', label: 'Falta de veículo', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_impedimento_acesso', label: 'Impedimento de acesso', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_licenca_ambiental', label: 'Licença ambiental', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_autorizacao_embargo', label: 'Autorização/embargo', tipo: 'select', options: ['Não','Sim'] },
  { id: 'rdo_desligamento', label: 'Desligamento conforme programado', tipo: 'select', options: ['Não','Sim'], padrao: 'Sim' },
];

function renderRDOForm(){
  const horarioCampos = [
    ['rdo_horario_chegada','Horário Chegada'],
    ['rdo_horario_inicio','Horário Início das atividades']
  ];
  return `
    ${anexosDoProgramadorHtml()}
    ${orientacoesPlanejamentoHtml()}
    <div class="panel section-gap" style="max-width:600px;margin:0 auto;">
      <div class="panel-head"><h3>Questionário RDO - Saída da Base</h3><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${teamGidLabel(prog)}</span></div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:var(--muted);margin-bottom:20px;">Responda às questões abaixo e informe os horários de saída da base. Os dados ficam salvos neste aparelho e são enviados quando você concluir as atividades.</p>
        ${RDO_PERGUNTAS.map((p,i)=>`
          <div style="margin-bottom:14px;">
            <label style="display:block;font-weight:600;margin-bottom:4px;">${p.label}</label>
            <select class="rdo-select" data-rdo="${p.id}" style="width:100%;padding:8px;font-size:14px;">
              ${p.options.map(v=>`<option value="${v}" ${(p.padrao? v===p.padrao : v===p.options[0])?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>`).join('')}
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
          <h4 style="margin:0 0 12px 0;font-size:13px;color:var(--dark);">KM do Veículo</h4>
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Informe a quilometragem do veículo no início e fim das atividades.</p>
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;">KM Inicial</label>
            <input type="number" class="rdo-input" data-rdo="rdo_km_inicial" inputmode="numeric" autocomplete="off" placeholder="0" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;">KM Final</label>
            <input type="number" class="rdo-input" data-rdo="rdo_km_final" inputmode="numeric" autocomplete="off" placeholder="0" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
          </div>
        </div>
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
          <h4 style="margin:0 0 12px 0;font-size:13px;color:var(--dark);">Horários de saída da base</h4>
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Digite os números — o ":" entra automaticamente. Ex.: 07 30 → 07:30.</p>
          ${horarioCampos.map(([id,label])=>`
            <div style="margin-bottom:12px;">
              <label style="display:block;margin-bottom:4px;">${label}</label>
              <input type="text" class="rdo-input rdo-hora" data-rdo="${id}" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
            </div>`).join('')}
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Os horários de <strong>finalização, saída da obra e chegada na base</strong> serão solicitados quando você concluir e enviar as atividades.</p>
          <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
            <button class="btn btn-primary" id="rdo-concluir" style="width:100%;padding:12px;font-size:16px;">Concluir RDO</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderOcNdsRDOForm(){
  const horarioCampos = [
    ['rdo_horario_chegada','Horário Chegada'],
    ['rdo_horario_inicio','Horário Início das atividades']
  ];
  const gid = ocndsItem.gid||'G26-'+String(ocndsItem.id).padStart(7,'0');
  const anexos = (ocndsItem&&ocndsItem.anexos)||[];
  const anexosHtml = anexos.length ? `
    <div class="panel section-gap" style="max-width:600px;margin:0 auto 14px;">
      <div class="panel-head"><h3>Anexos do escritório</h3><span class="badge-prefix">${anexos.length} imagem(ns)</span></div>
      <div style="padding:14px;">
        <div class="anexos-grid">${anexos.map(a=>{ const src=a.url||a.dataUrl||''; return `<div class="anexo-thumb" role="button" tabindex="0" title="${esc(a.nome||'')}"><img src="${esc(src)}" alt="${esc(a.nome||'anexo')}"><div class="anexo-meta">${esc(a.nome||'')}</div></div>`; }).join('')}</div>
      </div>
    </div>` : '';
  return `
    ${anexosHtml}
    <div class="panel section-gap" style="max-width:600px;margin:0 auto;">
      <div class="panel-head"><h3>Questionário RDO - Saída da Base</h3><span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${esc(gid)}</span></div>
      <div style="padding:24px;">
        <p style="font-size:14px;color:var(--muted);margin-bottom:20px;">Responda às questões abaixo e informe os horários de saída da base. Os dados ficam salvos neste aparelho e são enviados quando você concluir as atividades.</p>
        ${RDO_PERGUNTAS.map((p,i)=>`
          <div style="margin-bottom:14px;">
            <label style="display:block;font-weight:600;margin-bottom:4px;">${p.label}</label>
            <select class="rdo-select" data-rdo="${p.id}" style="width:100%;padding:8px;font-size:14px;">
              ${p.options.map(v=>`<option value="${v}" ${(p.padrao? v===p.padrao : v===p.options[0])?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>`).join('')}
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
          <h4 style="margin:0 0 12px 0;font-size:13px;color:var(--dark);">KM do Veículo</h4>
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Informe a quilometragem do veículo no início e fim das atividades.</p>
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;">KM Inicial</label>
            <input type="number" class="rdo-input" data-rdo="rdo_km_inicial" inputmode="numeric" autocomplete="off" placeholder="0" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;">KM Final</label>
            <input type="number" class="rdo-input" data-rdo="rdo_km_final" inputmode="numeric" autocomplete="off" placeholder="0" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
          </div>
        </div>
        <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
          <h4 style="margin:0 0 12px 0;font-size:13px;color:var(--dark);">Horários de saída da base</h4>
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Digite os números — o ":" entra automaticamente. Ex.: 07 30 → 07:30.</p>
          ${horarioCampos.map(([id,label])=>`
            <div style="margin-bottom:12px;">
              <label style="display:block;margin-bottom:4px;">${label}</label>
              <input type="text" class="rdo-input rdo-hora" data-rdo="${id}" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" style="width:100%;padding:8px;font-size:16px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;">
            </div>`).join('')}
          <p style="font-size:12px;color:var(--muted-2);margin:0 0 14px 0;">Os horários de <strong>finalização, saída da obra e chegada na base</strong> serão solicitados quando você concluir e enviar as atividades.</p>
          <div style="margin-top:24px;padding-top:24px;border-top:1px solid var(--border);">
            <button class="btn btn-primary" id="rdo-concluir" style="width:100%;padding:12px;font-size:16px;">Concluir RDO</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderOcNdsAnexosHtml(){
  const anexos = (ocndsItem&&ocndsItem.anexos)||[];
  if(!anexos.length) return '';
  return `
    <div class="panel section-gap" style="max-width:600px;margin:0 auto 14px;">
      <div class="panel-head"><h3>Anexos do escritório</h3><span class="badge-prefix">${anexos.length} imagem(ns)</span></div>
      <div style="padding:14px;">
        <div class="anexos-grid">${anexos.map(a=>{ const src=a.url||a.dataUrl||''; return `<div class="anexo-thumb" role="button" tabindex="0" title="${esc(a.nome||'')}"><img src="${esc(src)}" alt="${esc(a.nome||'anexo')}"><div class="anexo-meta">${esc(a.nome||'')}</div></div>`; }).join('')}</div>
      </div>
    </div>`;
}

function anexosDoProgramadorHtml(){
  const anexos = (prog&&prog.anexos)||[];
  if(!anexos.length) return '';
  return `
    <div class="panel section-gap" style="max-width:600px;margin:0 auto;margin-bottom:14px;">
      <div class="panel-head"><h3>Anexos do programador</h3><span class="badge-prefix">${anexos.length} imagem(ns)</span></div>
      <div style="padding:14px;">
        <div class="anexos-grid">${anexos.map(a=>{ const src=a.url||a.dataUrl||''; return `<div class="anexo-thumb" role="button" tabindex="0" title="${esc(a.nome||'')}"><img src="${esc(src)}" alt="${esc(a.nome||'anexo')}"><div class="anexo-meta">${esc(a.nome||'')}</div></div>`; }).join('')}</div>
      </div>
    </div>`;
}

function orientacoesPlanejamentoHtml(){
  const txt = (prog&&String(prog.orientacoesPlanejamento||'')).trim();
  if(!txt) return '';
  return `
    <div class="panel section-gap" style="max-width:600px;margin:0 auto;margin-bottom:14px;border-left:4px solid var(--accent);">
      <div class="panel-head"><h3>Orientações do Setor de Planejamento</h3></div>
      <div style="padding:14px;white-space:pre-wrap;font-size:14px;line-height:1.5;">${esc(txt)}</div>
    </div>`;
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
  const thumb = e.target.closest('.anexos-grid .anexo-thumb');
  if(!thumb) return;
  const grid = thumb.closest('.anexos-grid');
  const thumbs = Array.from(grid.querySelectorAll('.anexo-thumb'));
  openLightbox(thumbs.map(t=>t.querySelector('img').src), thumbs.indexOf(thumb));
});

function getRDORespostas(){
  const respostas = {};
  document.querySelectorAll('.rdo-select').forEach(s=>{ respostas[s.dataset.rdo] = s.value; });
  document.querySelectorAll('.rdo-input').forEach(s=>{ respostas[s.dataset.rdo] = s.value; });
  return respostas;
}

/* RDO pendente: respostas ficam no aparelho e só são enviadas junto com a conclusão das atividades */
function rdoKey(id){ return 'g26_equipe_rdo_'+id; }
function loadPendingRDO(id){ try{ return JSON.parse(localStorage.getItem(rdoKey(id))||'null'); }catch(e){ return null; } }
function savePendingRDO(obj){ try{ localStorage.setItem(rdoKey(obj.programacaoId), JSON.stringify(obj)); }catch(e){} }
function clearPendingRDO(id){ try{ localStorage.removeItem(rdoKey(id)); }catch(e){} }

/* Máscara numérica de horário: digita a hora, o ":" entra sozinho e depois os minutos */
function maskHora(el){
  const d = el.value.replace(/\D/g,'').slice(0,4);
  el.value = d.length>2? d.slice(0,2)+':'+d.slice(2) : d;
}
function padHora(el){
  if(!el.value) return;
  const d = el.value.replace(/\D/g,'');
  if(d.length<=2) el.value = d.padStart(2,'0')+':00';
  else if(d.length===3) el.value = d.slice(0,2)+':0'+d.slice(2);
  else el.value = d.slice(0,2)+':'+d.slice(2,4);
}
function horaValida(v){
  if(!/^\d{2}:\d{2}$/.test(v||'')) return false;
  const [h,m] = String(v).split(':').map(Number);
  return h>=0 && h<=23 && m>=0 && m<=59;
}

/* RDO já foi respondido se houver respostas salvas (no aparelho ou no servidor) */
function atualizaRDOCompletado(){
  if(!DB || !teamNumericId()) return;
  const pg = teamFindProg(DB);
  if(!pg) return;
  const rdoSalvo = (pg.atribuicoes||[]).some(at=> at.rdoRespostas && Object.keys(at.rdoRespostas||{}).length>0);
  if(rdoSalvo || loadPendingRDO(teamKey())) rdoCompletado = true;
}

function respostasRDOPreenchidas(){
  const res = getRDORespostas();
  const perguntasOk = RDO_PERGUNTAS.every(p=> res[p.id] && res[p.id] !== '');
  const horarios = ['rdo_horario_chegada','rdo_horario_inicio'];
  const horariosOk = horarios.every(id=> horaValida(res[id]));
  return perguntasOk && horariosOk;
}

/* --- render team --- */
function render(){
  const root = document.getElementById('team-body');

  /* === MODO OC/NDS === */
  if(isOcndsMode){
    if(!ocndsId){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Link inválido — faltou identificar a ocorrência.</p></div></div>`; return; }
    if(!ocndsItem){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Ocorrência não encontrada.</p><p style="font-size:12px;color:var(--muted-2);">Conecte-se ao menos uma vez para carregar os dados, ou tente novamente com internet.</p></div></div>`; return; }
    if(enviado){
      const _diasEnvioOc = (()=>{
        if(!ocndsItem || !ocndsItem.data) return 0;
        if(['Baixada','Cancelada'].includes(ocndsItem.status||'')) return 0;
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const d = new Date(ocndsItem.data); d.setHours(0,0,0,0);
        const diff = Math.floor((hoje - d) / 86400000);
        return diff > 0 ? diff : 0;
      })();
      root.innerHTML = `
        <div class="panel section-gap team-ok">
          <div class="brand-mark team-ok-logo">G2</div>
          <h3>Dados enviados e sincronizados</h3>
          <p>Obrigado, equipe! Os dados da ocorrência foram enviados ao escritório.</p>
          ${_diasEnvioOc? `<p style="margin-top:8px;padding:8px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:13px;color:#92400e;font-weight:600;">${icon('alert',14)} ${esc(atrasoLabel(_diasEnvioOc))}</p>` : ''}
          <p class="team-ok-meta">${ocndsItem.gid||'G26-'+String(ocndsItem.id).padStart(7,'0')} · ${ocndsItem.tipo} · ${fmtDate(ocndsItem.data)}</p>
        </div>`;
      setStatus('Sincronizado', 'ok');
      return;
    }

    const ocndsRdoPend = loadPendingRDO('ocnds_'+ocndsId);
    if(ocndsRdoPend || (ocndsItem.rdoRespostas && Object.keys(ocndsItem.rdoRespostas||{}).length)){
      rdoCompletado = true;
    }

    if(!rdoCompletado){
      root.innerHTML = renderOcNdsRDOForm();
      root.querySelectorAll('.rdo-hora').forEach(inp=>{
        inp.addEventListener('input', ()=>{ maskHora(inp); });
        inp.addEventListener('blur', ()=>{ padHora(inp); });
      });
      document.getElementById('rdo-concluir').addEventListener('click', ()=>{
        const respostas = getRDORespostas();
        if(!respostasRDOPreenchidas()){
          toast('Responda todas as questões do RDO e preencha os horários (HH:MM) antes de continuar.', 'error');
          return;
        }
        try{ savePendingRDO({ programacaoId: 'ocnds_'+ocndsId, ts: Date.now(), respostas: respostas }); }catch(e){}
        rdoCompletado = true;
        toast('RDO concluído. As respostas serão enviadas quando você concluir as ocorrência.');
        render();
      });
      return;
    }

    const isOC = ocndsItem.tipo === 'OC';
    const detalhesHtml = isOC ? `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
        <div class="panel" style="border-color:var(--border);padding:12px;text-align:center;"><div class="admin-field-meta">PTP</div><div style="font-size:15px;font-weight:700;margin-top:4px;">${esc(ocndsItem.ptp||'—')}</div></div>
        <div class="panel" style="border-color:var(--border);padding:12px;text-align:center;"><div class="admin-field-meta">SI</div><div style="font-size:15px;font-weight:700;margin-top:4px;">${esc(ocndsItem.si||'—')}</div></div>
        <div class="panel" style="border-color:var(--border);padding:12px;text-align:center;"><div class="admin-field-meta">OSE</div><div style="font-size:15px;font-weight:700;margin-top:4px;">${esc(ocndsItem.ose||'—')}</div></div>
      </div>` : `
      <div style="margin-bottom:16px;">
        <div class="panel" style="border-color:var(--border);padding:12px;text-align:center;"><div class="admin-field-meta">Ocorrência</div><div style="font-size:15px;font-weight:700;margin-top:4px;">${esc(ocndsItem.ocorrencia||'—')}</div></div>
      </div>`;

    const numeroOCField = isOC ? `
      <div class="field" style="margin-bottom:16px;">
        <label style="font-weight:600;">Nº da Ocorrência (OC)</label>
        <input type="text" id="ocnds-numero-oc" value="${esc(ocndsItem.numeroOC||'')}" placeholder="Informe o número da ocorrência" style="width:100%;padding:10px;font-size:16px;">
        <div class="field-hint">Preencha o número da ocorrência atribuída.</div>
      </div>` : '';

    const anexosHtml = renderOcNdsAnexosHtml();

    resetFotos();
    root.innerHTML = `
      ${anexosHtml}
      <div class="panel section-gap">
        <div class="panel-head">
          <div>
            <h3>Ocorrência ${esc(ocndsItem.tipo)} — ${ocndsItem.gid||'G26-'+String(ocndsItem.id).padStart(7,'0')}</h3>
            <div class="admin-field-meta">Atividade de livre escolha · ${fmtDate(ocndsItem.data)}</div>
          </div>
          <span class="badge" style="color:var(--blue);background:rgba(78,140,235,.12);">${esc(ocndsItem.status)}</span>
        </div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:16px;">
          <div class="team-hint">${icon('alert',14)} <div>Esta é uma ocorrência de <strong>livre escolha</strong>. ${isOC? 'Preencha o <strong>Nº da Ocorrência (OC)</strong> e registre as atividades executadas.' : 'Registre as atividades executadas.'} As alterações ficam salvas neste aparelho e são enviadas quando houver internet.</div></div>
          ${detalhesHtml}
          ${ocndsItem.observacoes? `<div style="border-left:4px solid var(--accent);padding:10px 14px;background:var(--bg-soft);border-radius:0 8px 8px 0;"><div class="admin-field-meta" style="margin-bottom:4px;">Observações do escritório:</div><div style="font-size:13px;">${esc(ocndsItem.observacoes)}</div></div>` : ''}
          ${numeroOCField}
          ${Object.keys(editors).map(eqId=>renderTeamBlock(eqId)).join('')}
          <div class="field"><label>Observação <span class="req">*</span></label><textarea id="team-obs" rows="3" placeholder="Descreva o que foi executado">${esc(observacao)}</textarea></div>
          <button class="btn btn-primary" id="team-submit" style="align-self:flex-end;">${icon('check',15)} Enviar e baixar ocorrência</button>
        </div>
      </div>`;
    document.getElementById('team-obs').addEventListener('input', e=>{ observacao = e.target.value; });
    root.querySelectorAll('.te-select').forEach(s=>s.addEventListener('change', e=>{ const [eid,idx]=e.currentTarget.dataset.tes.split('|'); editors[eid][Number(idx)].atividadeId = e.target.value; }));
    root.querySelectorAll('.te-qty').forEach(s=>s.addEventListener('input', e=>{ const [eid,idx]=e.currentTarget.dataset.teq.split('|'); editors[eid][Number(idx)].quantidadePrevista = e.target.value; }));
    root.querySelectorAll('.te-exec').forEach(s=>s.addEventListener('input', e=>{ const [eid,idx]=e.currentTarget.dataset.tee.split('|'); editors[eid][Number(idx)].quantidadeExecutada = e.target.value; }));
    root.querySelectorAll('.te-remove').forEach(b=>b.addEventListener('click', e=>{ const [eid,idx]=e.currentTarget.dataset.eqRm.split('|'); editors[eid].splice(Number(idx),1); resetFotos(); render(); }));
    root.querySelectorAll('.te-add').forEach(b=>b.addEventListener('click', e=>{ editors[e.currentTarget.dataset.eqAdd].push({atividadeId:'',quantidadePrevista:'',quantidadeExecutada:''}); resetFotos(); render(); }));
    root.querySelectorAll('.te-camera').forEach(b=>b.addEventListener('click', ()=>{ const [eid,idx]=b.dataset.tec.split('|'); openPhotoPicker(eid, Number(idx), 'camera'); }));
    root.querySelectorAll('.te-gallery').forEach(b=>b.addEventListener('click', ()=>{ const [eid,idx]=b.dataset.teg.split('|'); openPhotoPicker(eid, Number(idx), 'gallery'); }));
    root.querySelectorAll('.te-photo-hint').forEach(h=>{
      const [eid,idx] = h.dataset.ph.split('|');
      const n = fotosCount(eid, Number(idx));
      h.textContent = n? `${n} foto${n>1?'s':''} adicionada${n>1?'s':''}` : 'Obrigatório: adicione ao menos 1 foto';
      h.className = 'te-photo-hint ' + (n? 'ok':'missing');
    });
    root.querySelectorAll('input[type="search"][id^="te-search-"]').forEach(input=>{
      const eqId = input.id.replace('te-search-','');
      input.addEventListener('input', ()=>{
        const term = input.value.toLowerCase();
        root.querySelectorAll(`.te-select[data-tes^="${eqId}|"]`).forEach(sel=>{
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
    document.getElementById('team-submit').addEventListener('click', submitEditOcNds);
    return;
  }

  /* === MODO PROGRAMAÇÃO / PODA / OSE === */
  if(!teamNumericId()){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Link inválido — faltou identificar a programação.</p></div></div>`; return; }
  if(!prog){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Programação não encontrada.</p><p style="font-size:12px;color:var(--muted-2);">Conecte-se ao menos uma vez para carregar os dados, ou tente novamente com internet.</p></div></div>`; return; }

  /* Após o envio, a página mostra apenas a confirmação com a logo */
  if(enviado){
    const _diasEnvio = diasAtrasoProgramacao();
    root.innerHTML = `
      <div class="panel section-gap team-ok">
        <div class="brand-mark team-ok-logo">G2</div>
        <h3>Dados enviados e sincronizados</h3>
        <p>Obrigado, equipe! Suas atividades, quantidades executadas, fotos e o RDO foram enviados ao escritório.</p>
        ${_diasEnvio? `<p style="margin-top:8px;padding:8px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;font-size:13px;color:#92400e;font-weight:600;">${icon('alert',14)} ${esc(atrasoLabel(_diasEnvio))}</p>` : ''}
        <p class="team-ok-meta">${teamMode()==='poda'?'Programação PODA':teamMode()==='ose'?'Programação OSE':'Programação'} ${teamGidLabel(prog)} · ${fmtDate(teamDataRef())}</p>
      </div>`;
    setStatus('Sincronizado', 'ok');
    return;
  }
  
  /* Aviso de atraso — se a data já venceu, exibe banner mas permite acesso */
  const _diasAtraso = diasAtrasoProgramacao();

  /* Se RDO nao completado, mostrar questionario */
  if(!rdoCompletado){
    root.innerHTML = renderRDOForm();
    root.querySelectorAll('.rdo-hora').forEach(inp=>{
      inp.addEventListener('input', ()=>{ maskHora(inp); });
      inp.addEventListener('blur', ()=>{ padHora(inp); });
    });
    document.getElementById('rdo-concluir').addEventListener('click', ()=>{
      const respostas = getRDORespostas();
      if(!respostasRDOPreenchidas()){
        toast('Responda todas as questões do RDO e preencha os horários (HH:MM) antes de continuar.', 'error');
        return;
      }
      // Guarda localmente — só será enviado junto com a conclusão das atividades
      try{
        savePendingRDO({ programacaoId: teamKey(), ts: Date.now(), respostas: respostas });
      }catch(e){}
      rdoCompletado = true;
      toast('RDO concluído. As respostas serão enviadas quando você concluir as atividades.');
      render();
    });
    return;
  }
  
  const m = teamMode();
  const pr = findProjeto(DB, prog.projetoId);
  const headTitulo = m==='poda'? 'PODA — OSI '+(prog.osi||'—') : m==='ose'? 'OSE — '+(prog.municipio||'Município') : (pr?.nome||'Projeto');
  const headSub = [teamGidLabel(prog),
    m==='poda'? [prog.subestacao? 'SE '+prog.subestacao:'', prog.tipoRede, prog.chave? 'Chave '+prog.chave:''].filter(Boolean).join(' · ')
    : m==='ose'? [prog.subestacao? 'SE '+prog.subestacao:'', prog.tipoIntervencao].filter(Boolean).join(' · ')
    : [(pr?.codigo||''), prog.ciclo? 'Ciclo '+prog.ciclo : ''].filter(Boolean).join(' · ')
  ].filter(Boolean).join(' — ');
  resetFotos();
  root.innerHTML = `
    ${_diasAtraso? `<div class="panel" style="background:var(--amber,#f59e0b);color:#1a1206;padding:12px 16px;border-radius:10px;margin-bottom:12px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;">${icon('alert',15)} ${esc(atrasoLabel(_diasAtraso))}</div>` : ''}
    ${anexosDoProgramadorHtml()}
    ${orientacoesPlanejamentoHtml()}
    <div class="panel section-gap">
      <div class="panel-head">
        <div><h3>${esc(headTitulo)}</h3><div class="admin-field-meta">${esc(headSub)}</div></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="badge" style="color:var(--teal);background:rgba(87,199,199,.12);">${fmtDate(teamDataRef())}</span>
          <button type="button" class="btn btn-danger-solid" id="btn-informar-acidente" style="font-weight:700;">${icon('alert',14)} INFORMAR ACIDENTE</button>
        </div>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:16px;">
        <div class="team-hint">${icon('alert',14)} <div>Edite apenas as <strong>atividades e quantidades</strong> da programação. A <strong>observação é obrigatória</strong> e cada atividade exige <strong>pelo menos 1 foto</strong> (câmera ou galeria). As alterações ficam salvas neste aparelho e são enviadas automaticamente quando houver internet.</div></div>
        ${Object.keys(editors).map(eqId=>renderTeamBlock(eqId)).join('')}
        <div class="field"><label>Observação <span class="req">*</span></label><textarea id="team-obs" rows="3" placeholder="Descreva o que mudou e o motivo">${esc(observacao)}</textarea></div>
        <button class="btn btn-primary" id="team-submit" style="align-self:flex-end;">${icon('check',15)} Enviar alterações</button>
      </div>
    </div>`;
  document.getElementById('team-obs').addEventListener('input', e=>{ observacao = e.target.value; });
  root.querySelectorAll('.te-select').forEach(s=>s.addEventListener('change', e=>{ const [eid,idx]=e.currentTarget.dataset.tes.split('|'); editors[eid][Number(idx)].atividadeId = e.target.value; }));
  root.querySelectorAll('.te-qty').forEach(s=>s.addEventListener('input', e=>{ const [eid,idx]=e.currentTarget.dataset.teq.split('|'); editors[eid][Number(idx)].quantidadePrevista = e.target.value; }));
  root.querySelectorAll('.te-exec').forEach(s=>s.addEventListener('input', e=>{ const [eid,idx]=e.currentTarget.dataset.tee.split('|'); editors[eid][Number(idx)].quantidadeExecutada = e.target.value; }));
  root.querySelectorAll('.te-anom').forEach(s=>s.addEventListener('input', e=>{ const [eid,idx]=e.currentTarget.dataset.tea.split('|'); editors[eid][Number(idx)].qtdAnomaliaExecutada = e.target.value; }));
  root.querySelectorAll('.te-remove').forEach(b=>b.addEventListener('click', e=>{ const [eid,idx]=e.currentTarget.dataset.eqRm.split('|'); editors[eid].splice(Number(idx),1); resetFotos(); render(); }));
  root.querySelectorAll('.te-add').forEach(b=>b.addEventListener('click', e=>{ editors[e.currentTarget.dataset.eqAdd].push({atividadeId:'',quantidadePrevista:'',qtdAnomaliaExecutada:''}); resetFotos(); render(); }));
  root.querySelectorAll('.te-camera').forEach(b=>b.addEventListener('click', ()=>{ const [eid,idx]=b.dataset.tec.split('|'); openPhotoPicker(eid, Number(idx), 'camera'); }));
  root.querySelectorAll('.te-gallery').forEach(b=>b.addEventListener('click', ()=>{ const [eid,idx]=b.dataset.teg.split('|'); openPhotoPicker(eid, Number(idx), 'gallery'); }));
  root.querySelectorAll('.te-photo-hint').forEach(h=>{
    const [eid,idx] = h.dataset.ph.split('|');
    const n = fotosCount(eid, Number(idx));
    h.textContent = n? `${n} foto${n>1?'s':''} adicionada${n>1?'s':''}` : 'Obrigatório: adicione ao menos 1 foto';
    h.className = 'te-photo-hint ' + (n? 'ok':'missing');
  });
  root.querySelectorAll('input[type="search"][id^="te-search-"]').forEach(input=>{
    const eqId = input.id.replace('te-search-','');
    input.addEventListener('input', ()=>{
      const term = input.value.toLowerCase();
      root.querySelectorAll(`.te-select[data-tes^="${eqId}|"]`).forEach(sel=>{
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
  document.getElementById('team-submit').addEventListener('click', submitEdit);
  const btnAcidente = document.getElementById('btn-informar-acidente');
  if(btnAcidente){
    btnAcidente.addEventListener('click', ()=>{ console.log('[team] INFORMAR ACIDENTE clicked'); abrirModalAcidente(); });
  }else{
    console.warn('[team] btn-informar-acidente não encontrado no DOM');
  }
}
/* GPS da equipe: posição atual + endereço aproximado (Geoapify) */
function geoPosAtual(opts){
  return new Promise(resolve=>{
    if(!('geolocation' in navigator)){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos=>resolve({ lat:pos.coords.latitude, lng:pos.coords.longitude, precisao:pos.coords.accuracy }),
      err=>{ console.warn('[team] geolocation falhou:', err && err.message); resolve(null); },
      Object.assign({ enableHighAccuracy:true, timeout:12000, maximumAge:0 }, opts||{})
    );
  });
}
async function geoEnderecoAprox(lat,lng){
  try{
    const res = await fetch(`https://api.geoapify.com/v1/geocode/reverse?lat=${Number(lat)}&lon=${Number(lng)}&apiKey=${MAPS_KEY}&format=json&limit=1`);
    if(!res.ok) return '';
    const j = await res.json();
    const f = j && j.features && j.features[0];
    return (f && f.properties && f.properties.formatted) || '';
  }catch(e){ return ''; }
}

function abrirModalAcidente(){
  console.log('[team] abrirModalAcidente chamado');
  const eq = findEquipe(DB, (prog.atribuicoes||[])[0]?.equipeId);
  const pr = findProjeto(DB, prog.projetoId);
  const progGidLabel = teamGidLabel(prog);
  const body = `
    <div style="color:var(--red);font-weight:700;font-size:14px;margin-bottom:12px;">${icon('alert',16)} CONFIRMAR INFORMAÇÃO DE ACIDENTE</div>
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:16px;">Preencha o motivo/descrição do acidente. Isso enviará um alerta vermelho bloqueante para todas as telas do escritório (Admin) com a <strong>localização atual da equipe (GPS)</strong>, equipe e QR Code. O alarme sonoro tocará até que alguém confirme "Reportado".</div>
    <div class="field"><label>Motivo / Descrição do acidente <span class="req">*</span></label><textarea name="acidente-motivo" id="acidente-motivo" rows="4" required placeholder="Ex.: Colisão de veículo na rota, queda de poste, choque elétrico..."></textarea></div>
    <div style="margin-top:8px;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:11px;color:#991b1b;">
      <strong>Equipe:</strong> ${esc(equipeLabel(eq))}<br>
      <strong>Programação:</strong> ${esc(progGidLabel)} · ${fmtDate(teamDataRef())}<br>
      <strong>Projeto:</strong> ${esc(pr?.nome||'—')} (${esc(pr?.codigo||'—')})<br>
      <strong>Local programado:</strong> ${esc(prog.local||'—')}
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--muted-2);">Ao enviar, o aparelho captura automaticamente a localização atual da equipe pelo GPS. Mantenha o GPS ativado e autorize o acesso à localização.</div>
  `;
  openModal({
    title: 'Informar Acidente', bodyHtml: body, submitLabel: 'ENVIAR ALERTA DE ACIDENTE',
    onSubmit: async (fd)=>{
      const motivo = fd.get('acidente-motivo').trim();
      if(!motivo){ toast('Informe o motivo/descrição do acidente.', 'error'); return false; }
      try{
        toast('Capturando a localização atual da equipe…');
        const gps = await geoPosAtual();
        let localEquipe = '', lat = null, lng = null, precisao = null;
        if(gps){
          lat = gps.lat; lng = gps.lng; precisao = Math.round(gps.precisao);
          localEquipe = await geoEnderecoAprox(lat, lng);
          if(!localEquipe) localEquipe = 'GPS '+lat.toFixed(6)+', '+lng.toFixed(6);
        }else{
          toast('Não foi possível obter o GPS. O alerta será enviado sem coordenadas.', 'error');
        }
        const acidente = {
          ts: Date.now(),
          programacaoId: teamNumericId(),
          _coll: teamCollectionName(),
          progGid: progGidLabel,
          dataProgramada: teamDataRef(),
          projetoId: prog.projetoId,
          projetoNome: pr?.nome||'',
          projetoCodigo: pr?.codigo||'',
          equipeId: eq?.id,
          equipeLabel: equipeLabel(eq),
          local: localEquipe,
          localLat: lat,
          localLng: lng,
          gpsPrecisao: precisao,
          gpsTs: gps? Date.now() : null,
          gpsErro: gps? '' : 'GPS indisponível ou permissão negada',
          localProgramado: prog.local||'',
          localProgramadoLat: prog.localLat??null,
          localProgramadoLng: prog.localLng??null,
          motivo,
          status: 'ativo',
          confirmadoPor: null,
          confirmadoTs: null
        };
        console.log('[team] Enviando acidente para:', ACCIDENT_REF.toString(), acidente);
        await ACCIDENT_REF.push(acidente);
        console.log('[team] Acidente enviado com sucesso');
        toast('Alerta de acidente enviado a todas as telas do escritório!');
      }catch(e){
        console.error('[team] Erro ao enviar acidente:', e);
        console.error('[team] Error code:', e.code);
        console.error('[team] Error message:', e.message);
        toast('Erro ao enviar alerta: '+ (e.code || e.message), 'error');
        return false;
      }
    }
  });
}
function renderTeamBlock(eqId){
  const eq = findEquipe(DB, Number(eqId));
  const rows = editors[eqId];
  const searchId = `te-search-${eqId}`;
  return `<div class="panel" style="border-color:var(--border);">
    <div class="panel-head"><h4>${equipeLabel(eq)}</h4><span class="badge-prefix">${eqtlLabel(eq)}</span></div>
    <div style="padding:12px 14px;">
      <div class="field" style="margin-bottom:12px;">
        <label for="${searchId}">${icon('search',14)} Buscar atividade (código ou descrição)</label>
        <input type="search" id="${searchId}" placeholder="Filtrar atividades…" style="width:100%;">
      </div>
      ${rows.map((r,i)=>`
        <div class="team-atividade">
          <div class="activity-row">
            <select class="te-select" data-tes="${eqId}|${i}"><option value="">Atividade…</option>${DB.atividades.map(a=>`<option value="${a.id}" ${String(r.atividadeId)===String(a.id)?'selected':''}>${esc(a.codigo)} · ${esc(a.descricao)}</option>`).join('')}</select>
            <div class="qty-field"><label>Prevista</label><input type="number" step="0.01" min="0" class="te-qty" data-teq="${eqId}|${i}" placeholder="Qtd." value="${r.atividadeId ? r.quantidadePrevista : '0'}" readonly>${r.atividadeId?'':' (bloqueado)'}</div>
            <div class="qty-field"><label>Executada</label><input type="number" step="0.01" min="0" class="te-exec" data-tee="${eqId}|${i}" placeholder="Qtd." value="${r.quantidadeExecutada??''}"></div>
            ${teamMode()==='ose'? `<div class="qty-field"><label title="Quantidade de anomalias executadas">Anomalias</label><input type="number" step="1" min="0" class="te-anom" data-tea="${eqId}|${i}" placeholder="Qtd." value="${r.qtdAnomaliaExecutada??''}"></div>`:''}
            <button type="button" class="icon-btn te-remove" data-eq-rm="${eqId}|${i}" title="Remover atividade" ${r.atividadeId?'disabled':''}>${icon('close',13)}</button>
          </div>
          <div class="activity-fotos">
            <div class="te-thumbs" data-tef="${eqId}|${i}"></div>
            <div class="te-actions">
              <span class="te-photo-hint" data-ph="${eqId}|${i}"></span>
              <button type="button" class="btn btn-sm te-camera" data-tec="${eqId}|${i}">${icon('camera',13)} Câmera</button>
              <button type="button" class="btn btn-sm btn-ghost te-gallery" data-teg="${eqId}|${i}">${icon('image',13)} Galeria</button>
            </div>
          </div>
        </div>`).join('')}
      <button type="button" class="btn btn-sm te-add" data-eq-add="${eqId}">${icon('plus',13)} Adicionar atividade</button>
    </div>
  </div>`;
}

/* --- envio / fila offline --- */
/* ── FOTOS DOS REGISTROS (IMGGB) ── */
function openPhotoPicker(eqId, idx, modo){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  if(modo==='camera') inp.setAttribute('capture','environment');
  inp.style.display = 'none';
  inp.onchange = ()=>{
    if(inp.files && inp.files[0]) addFoto(eqId, idx, inp.files[0]);
    inp.remove();
  };
  document.body.appendChild(inp);
  inp.click();
}
function addFoto(eqId, idx, file){
  if(!_fotos[eqId]) _fotos[eqId] = [];
  if(!_fotos[eqId][idx]) _fotos[eqId][idx] = [];
  _fotos[eqId][idx].push(file);
  atualizarFotosUI(eqId, idx);
}
function removerFoto(eqId, idx, fIdx){
  const arr = (_fotos[eqId]||[])[idx];
  if(!arr) return;
  arr.splice(fIdx,1);
  atualizarFotosUI(eqId, idx);
}
function fotoUrl(file){ return URL.createObjectURL(file); }
function atualizarFotosUI(eqId, idx){
  const thumbs = document.querySelector('.te-thumbs[data-tef="'+eqId+'|'+idx+'"]');
  if(!thumbs) return;
  const arr = (_fotos[eqId]||[])[idx]||[];
  thumbs.innerHTML = arr.map((f,i)=>`
    <div class="te-thumb">
      <img src="${fotoUrl(f)}" alt="foto">
      <button type="button" class="icon-btn te-del-foto" data-te-df="${eqId}|${idx}|${i}" title="Remover foto">${icon('close',13)}</button>
    </div>`).join('');
  thumbs.querySelectorAll('.te-del-foto').forEach(b=>{
    b.addEventListener('click', ()=>{
      const p = b.dataset.teDf.split('|');
      removerFoto(p[0], Number(p[1]), Number(p[2]));
    });
  });
}
function resetFotos(){
  _fotos = {};
  Object.keys(editors).forEach(eqId=>{
    const existing = _fotos[eqId] || [];
    _fotos[eqId] = editors[eqId].map((_a, i)=> existing[i] || []);
  });
}
function fotosCount(eqId, idx){
  return ((_fotos[eqId]||[])[idx]||[]).length;
}
async function uploadToImGbb(file){
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('https://api.imgbb.com/1/upload?key='+IMGGB_KEY, { method:'POST', body: fd });
  const j = await res.json();
  if(!j.success) throw new Error((j.error&&j.error.message)||'Falha no upload');
  return (j.data && (j.data.url || j.data.display_url)) || '';
}

async function submitEditOcNds(){
  const obs = observacao.trim();
  if(!obs){ toast('A observação é obrigatória.', 'error'); return; }

  if(ocndsItem && ocndsItem.tipo === 'OC'){
    const numeroOC = (document.getElementById('ocnds-numero-oc')?.value||'').trim();
    if(!numeroOC){ toast('Informe o Nº da Ocorrência (OC).', 'error'); return; }
  }

  for(const eqId of Object.keys(editors)){
    const rows = editors[eqId];
    if(!rows.length){ toast('Adicione ao menos uma atividade.', 'error'); return; }
    for(let i=0;i<rows.length;i++){
      if(!fotosCount(eqId, i)){ toast('Cada atividade precisa de pelo menos 1 foto.', 'error'); return; }
    }
  }
  if(_fotosEnviando) return;
  if(navigator.onLine === false){ toast('Conecte-se à internet para enviar as fotos das atividades.', 'error'); return; }
  coletarHorariosFinais(async (horariosFinais)=>{
    _fotosEnviando = true;
    const btn = document.getElementById('team-submit');
    if(btn){ btn.disabled = true; btn.textContent = 'Enviando fotos…'; }
    try{
      const fotosUrls = {};
      for(const eqId of Object.keys(editors)){
        const arr = _fotos[eqId]||[];
        fotosUrls[eqId] = [];
        for(let i=0;i<editors[eqId].length;i++){
          const urls = [];
          for(const f of (arr[i]||[])){
            const u = await uploadToImGbb(f);
            if(u) urls.push(u);
          }
          fotosUrls[eqId].push(urls.join(FOTOS_SEP));
        }
      }
      const patch = {
        id: 'oc'+Date.now()+Math.random().toString(36).slice(2,6),
        ocndsId: ocndsId,
        ts: Date.now(),
        observacao: obs,
        numeroOC: (ocndsItem && ocndsItem.tipo === 'OC')? (document.getElementById('ocnds-numero-oc')?.value||'').trim() : '',
        atribuicoes: Object.keys(editors).map(eqId=>({
          equipeId: Number(eqId),
          atividades: editors[eqId].map((r,i)=>({
            atividadeId: Number(r.atividadeId),
            quantidadePrevista: r.quantidadePrevista? parseFloat(r.quantidadePrevista): null,
            quantidadeExecutada: (r.quantidadeExecutada===''||r.quantidadeExecutada==null)? null : parseFloat(r.quantidadeExecutada),
            fotos: fotosUrls[eqId][i]||''
          }))
        }))
      };
      const pendRDO = loadPendingRDO('ocnds_'+ocndsId);
      const respostas = Object.assign({}, (pendRDO&&pendRDO.respostas)||{}, horariosFinais||{});
      if(Object.keys(respostas).length){ patch.respostas = respostas; }
      if(pendRDO) clearPendingRDO('ocnds_'+ocndsId);
      const q = loadQueue(); q.push(patch); saveQueue(q);
      observacao = '';
      enviado = true;
      render();
      syncNowOcNds();
    }catch(err){
      console.error(err);
      toast('Erro ao enviar as fotos. Tente novamente.', 'error');
    }finally{
      _fotosEnviando = false;
      if(btn){ btn.disabled = false; btn.textContent = 'Enviar e baixar ocorrência'; }
    }
  });
}

async function syncNowOcNds(){
  if(syncing) return;
  const q = loadQueue();
  if(!q.length){ setStatus(online? 'Tudo em dia' : 'Offline — aguardando conexão', online? 'ok':'warn'); return; }
  if(navigator.onLine === false){ setStatus('Offline — aguardando internet para enviar', 'warn'); return; }
  syncing = true;
  setStatus('Enviando alterações…');
  try{
    const snap = await DB_REF.once('value');
    let db;
    if(snap.exists()){
      const v = snap.val();
      db = (typeof v==='string')? JSON.parse(v) : v;
    }else{
      db = { equipes:[], atividades:[], projetos:[], programacoes:[], ocnds:[], usuarios:[], customFields:{equipes:[],atividades:[],projetos:[],programacoes:[]}, seq:1 };
    }
    let changed = false;
    q.forEach(patch=>{
      const item = (db.ocnds||[]).find(p=>p.id===Number(patch.ocndsId));
      if(!item) return;
      item.numeroOC = patch.numeroOC || item.numeroOC;
      item.atividades = (patch.atribuicoes||[]).flatMap(pa=> pa.atividades||[]);
      item.observacaoEquipe = patch.observacao || item.observacaoEquipe || '';
      item.status = 'Baixada';
      item.historico = item.historico||[];
      item.historico.push({ usuarioNome:'Equipe', usuarioLogin:'', ts:patch.ts, tipo:'equipe', de:'Despachada', para:'Baixada', motivo:patch.observacao });
      if(patch.respostas){
        item.rdoRespostas = Object.assign({}, item.rdoRespostas||{}, patch.respostas||{});
      }
      changed = true;
    });
    if(changed){
      await DB_REF.set(JSON.stringify(db));
      DB = db; saveCache(db); dbToEditors(DB);
    }
    saveQueue([]);
    setStatus('Alterações enviadas ✓', 'ok');
    toast('Alterações enviadas ao escritório.');
  }catch(err){
    console.error('Falha ao sincronizar', err);
    setStatus('Falha ao enviar. Tentativa automática quando houver conexão.', 'warn');
  }finally{
    syncing = false;
  }
}

async function submitEdit(){
  const obs = observacao.trim();
  if(!obs){ toast('A observação é obrigatória.', 'error'); return; }
  for(const eqId of Object.keys(editors)){
    const rows = editors[eqId];
    if(!rows.length){ toast('Cada equipe precisa de ao menos uma atividade.', 'error'); return; }
    if(rows.some(r=>!r.atividadeId)){ toast('Selecione a atividade em todas as linhas.', 'error'); return; }
    for(let i=0;i<rows.length;i++){
      if(!fotosCount(eqId, i)){ toast('Cada atividade precisa de pelo menos 1 foto.', 'error'); return; }
    }
  }
  if(_fotosEnviando) return;
  if(navigator.onLine === false){ toast('Conecte-se à internet para enviar as fotos das atividades.', 'error'); return; }
  coletarHorariosFinais(async (horariosFinais)=>{
    _fotosEnviando = true;
    const btn = document.getElementById('team-submit');
    if(btn){ btn.disabled = true; btn.textContent = 'Enviando fotos…'; }
    try{
      const fotosUrls = {};
      for(const eqId of Object.keys(editors)){
        const arr = _fotos[eqId]||[];
        fotosUrls[eqId] = [];
        for(let i=0;i<editors[eqId].length;i++){
          const urls = [];
          for(const f of (arr[i]||[])){
            const u = await uploadToImGbb(f);
            if(u) urls.push(u);
          }
          fotosUrls[eqId].push(urls.join(FOTOS_SEP));
        }
      }
      const patch = {
        id: 'e'+Date.now()+Math.random().toString(36).slice(2,6),
        programacaoId: teamNumericId(),
        _coll: teamCollectionName(),
        ts: Date.now(),
        observacao: obs,
        atribuicoes: Object.keys(editors).map(eqId=>({
          equipeId: Number(eqId),
          atividades: editors[eqId].map((r,i)=>({
            atividadeId: Number(r.atividadeId),
            quantidadePrevista: r.quantidadePrevista? parseFloat(r.quantidadePrevista): null,
            quantidadeExecutada: (r.quantidadeExecutada===''||r.quantidadeExecutada==null)? null : parseFloat(r.quantidadeExecutada),
            qtdAnomaliaExecutada: (teamMode()==='ose' && r.qtdAnomaliaExecutada!=='' && r.qtdAnomaliaExecutada!=null)? parseFloat(r.qtdAnomaliaExecutada) : null,
            fotos: fotosUrls[eqId][i]||''
          }))
        }))
      };
      // Envia as respostas do RDO (perguntas + horários de saída) junto com a conclusão
      const pendRDO = loadPendingRDO(teamKey());
      const respostas = Object.assign({}, (pendRDO&&pendRDO.respostas)||{}, horariosFinais||{});
      if(Object.keys(respostas).length){ patch.respostas = respostas; }
      if(pendRDO) clearPendingRDO(teamKey());
      const q = loadQueue(); q.push(patch); saveQueue(q);
      observacao = '';
      enviado = true;
      render();
      syncNow();
    }catch(err){
      console.error(err);
      toast('Erro ao enviar as fotos. Tente novamente.', 'error');
    }finally{
      _fotosEnviando = false;
      if(btn){ btn.disabled = false; btn.textContent = 'Enviar alterações'; }
    }
  });
}
function coletarHorariosFinais(cb){
  const campos = [
    ['rdo_horario_finalizacao','Horário Finalização das atividades'],
    ['rdo_horario_saida_obra','Horário Saída da obra'],
    ['rdo_horario_chegada_base','Horário Chegada na base']
  ];
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,13,18,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;max-width:420px;width:100%;box-shadow:0 18px 50px rgba(0,0,0,.4);box-sizing:border-box;">
      <h3 style="margin:0 0 4px;font-size:16px;color:#0f1319;">Finalizar atividades</h3>
      <p style="margin:0 0 18px;font-size:13px;color:#555;">Informe os horários de encerramento do serviço para concluir e enviar.</p>
      ${campos.map(([id,label])=>`
        <div style="margin-bottom:14px;">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:4px;color:#222;">${label}</label>
          <input type="text" class="fin-hora" data-h="${id}" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" style="width:100%;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px;font-family:'JetBrains Mono',monospace;letter-spacing:.06em;box-sizing:border-box;">
        </div>`).join('')}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">
        <button type="button" class="fin-cancel" style="padding:10px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:8px;font-size:13px;font-weight:600;color:#333;cursor:pointer;">Voltar</button>
        <button type="button" class="fin-ok" style="padding:10px 16px;border:1px solid #e0a050;background:#e0a050;border-radius:8px;font-size:13px;font-weight:700;color:#1a1206;cursor:pointer;">Concluir e enviar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelectorAll('.fin-hora').forEach(inp=>{
    inp.addEventListener('input', ()=>{ maskHora(inp); });
    inp.addEventListener('blur', ()=>{ padHora(inp); });
  });
  const close = ()=> ov.remove();
  ov.querySelector('.fin-cancel').addEventListener('click', close);
  ov.querySelector('.fin-ok').addEventListener('click', ()=>{
    const horarios = {};
    let ok = true;
    ov.querySelectorAll('.fin-hora').forEach(inp=>{
      const v = inp.value;
      if(!horaValida(v)){ ok=false; inp.style.borderColor='#d33'; } else { inp.style.borderColor='#ccc'; horarios[inp.dataset.h]=v; }
    });
    if(!ok){ toast('Preencha os horários de finalização (HH:MM) para concluir.', 'error'); return; }
    close();
    cb(horarios);
  });
}
async function syncNow(){
  if(syncing) return;
  const q = loadQueue();
  if(!q.length){ setStatus(online? 'Tudo em dia' : 'Offline — aguardando conexão', online? 'ok':'warn'); return; }
  if(navigator.onLine === false){ setStatus('Offline — aguardando internet para enviar', 'warn'); return; }
  syncing = true;
  setStatus('Enviando alterações…');
  try{
    const snap = await DB_REF.once('value');
    let db;
    if(snap.exists()){
      const v = snap.val();
      db = (typeof v==='string')? JSON.parse(v) : v;
    }else{
      db = { equipes:[], atividades:[], projetos:[], programacoes:[], ocnds:[], podaProgramacoes:[], oseProgramacoes:[], usuarios:[], customFields:{equipes:[],atividades:[],projetos:[],programacoes:[]}, seq:1 };
    }
    let changed = false;
    q.forEach(patch=>{
      const coll = patch._coll || 'programacoes';
      const pg = ((db[coll])||[]).find(p=>p.id===Number(patch.programacaoId));
      if(!pg) return;
      (pg.atribuicoes||[]).forEach(at=>{
        const pa = (patch.atribuicoes||[]).find(x=>String(x.equipeId)===String(at.equipeId));
        if(!pa) return;
        const existing = at.atividades||[];
        at.atividades = pa.atividades.map(x=>({
          atividadeId: Number(x.atividadeId),
          quantidadePrevista: x.quantidadePrevista,
          quantidadeExecutada: x.quantidadeExecutada != null ? x.quantidadeExecutada : (existing.find(y=>String(y.atividadeId)===String(x.atividadeId))?.quantidadeExecutada ?? null),
          qtdAnomalia: x.qtdAnomalia ?? existing.find(y=>String(y.atividadeId)===String(x.atividadeId))?.qtdAnomalia ?? null,
          qtdAnomaliaExecutada: x.qtdAnomaliaExecutada != null ? x.qtdAnomaliaExecutada : (existing.find(y=>String(y.atividadeId)===String(x.atividadeId))?.qtdAnomaliaExecutada ?? null),
          fotos: x.fotos || existing.find(y=>String(y.atividadeId)===String(x.atividadeId))?.fotos || ''
        }));
        at.historico = at.historico||[];
        at.historico.push({ usuarioNome:'Equipe', usuarioLogin:'', ts:patch.ts, tipo:'equipe', de:null, para:'atividades', motivo:patch.observacao });
        // Propagar dados do RDO
        if(patch.respostas){
          at.rdoRespostas = Object.assign({}, at.rdoRespostas||{}, patch.respostas||{});
          at.rdoHorarioChegada = patch.respostas.rdo_horario_chegada || at.rdoHorarioChegada;
          at.rdoHorarioInicio = patch.respostas.rdo_horario_inicio || at.rdoHorarioInicio;
          at.rdoHorarioFinalizacao = patch.respostas.rdo_horario_finalizacao || at.rdoHorarioFinalizacao;
          at.rdoHorarioSaidaObra = patch.respostas.rdo_horario_saida_obra || at.rdoHorarioSaidaObra;
          at.rdoHorarioChegadaBase = patch.respostas.rdo_horario_chegada_base || at.rdoHorarioChegadaBase;
          at.rdoCondicoes = patch.respostas.rdo_condicoes || at.rdoCondicoes;
          at.rdoImpedimento = patch.respostas.rdo_impedimento || at.rdoImpedimento;
          at.rdoFaltaMaterial = patch.respostas.rdo_falta_material || at.rdoFaltaMaterial;
          at.rdoProjetoIncoerente = patch.respostas.rdo_projeto_incoerente || at.rdoProjetoIncoerente;
          at.rdoEquipeIncompleta = patch.respostas.rdo_equipe_incompleta || at.rdoEquipeIncompleta;
          at.rdoFaltaVeiculo = patch.respostas.rdo_falta_veiculo || at.rdoFaltaVeiculo;
          at.rdoImpedimentoAcesso = patch.respostas.rdo_impedimento_acesso || at.rdoImpedimentoAcesso;
          at.rdoLicencaAmbiental = patch.respostas.rdo_licenca_ambiental || at.rdoLicencaAmbiental;
          at.rdoAutorizacaoEmbargo = patch.respostas.rdo_autorizacao_embargo || at.rdoAutorizacaoEmbargo;
          at.rdoDesligamento = patch.respostas.rdo_desligamento || at.rdoDesligamento;
          at.rdoKmInicial = patch.respostas.rdo_km_inicial || at.rdoKmInicial;
          at.rdoKmFinal = patch.respostas.rdo_km_final || at.rdoKmFinal;
        }
        changed = true;
      });
    });
    if(changed){
      await DB_REF.set(JSON.stringify(db));
      DB = db; saveCache(db); dbToEditors(db);
    }
    saveQueue([]);
    setStatus('Alterações enviadas ✓', 'ok');
    toast('Alterações enviadas ao escritório.');
    render();
  }catch(err){
    console.error('Falha ao sincronizar', err);
    setStatus('Falha ao enviar. Tentativa automática quando houver conexão.', 'warn');
  }finally{
    syncing = false;
  }
}

/* --- documento de campo (PDF / impressão) --- */
const PRINT_PROG = Number(new URLSearchParams(location.search).get('print')) || null;
const PRINT_EQUIPE = new URLSearchParams(location.search).get('e') || null;
function teamPageUrl(pgId){ return location.origin + location.pathname + '?equipe=' + pgId; }
function qrSvgHtml(url, cellSize){
  if(typeof qrcode==='undefined' || !url) return '';
  try{
    const qr = qrcode(0,'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(cellSize||3, 2);
  }catch(e){ return ''; }
}
function buildDocEquipeHtml(pg, eqId){
  const pr = findProjeto(DB, pg.projetoId);
  const eq = findEquipe(DB, Number(eqId)) || (pg.atribuicoes||[]).map(a=>findEquipe(DB, a.equipeId)).find(Boolean);
  const atrib = (pg.atribuicoes||[]).find(a=>String(a.equipeId)===String(eqId)) || (pg.atribuicoes||[])[0];
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
  return `
  <div class="print-sheet">
    <div class="ps-head">
      <div><h1>G26 New · Programação de Redes Elétricas</h1><div class="ps-sub">Documento de campo — equipe</div></div>
      <div style="text-align:right;"><div style="font-size:14px;font-weight:700;">${fmtDate(atrib?.dataProgramada||pg.dataProgramada)}</div><div class="ps-sub">Emissão: ${fmtDateTime(Date.now())}</div></div>
    </div>
    <div class="ps-block">
      <div class="ps-block-head">
        <div>${pg.gid||'G26-'+String(pg.id).padStart(7,'0')} — ${esc(pr?.nome||'Projeto')} (${esc(pr?.codigo||'')}) — ${esc(equipeLabel(eq))} — ${fmtDate(atrib?.dataProgramada||pg.dataProgramada)}</div>
        <div class="ps-qr">${qrSvgHtml(teamPageUrl(pg.id), 3)}<div class="ps-qr-cap">Escaneie para alterar as atividades</div></div>
      </div>
      <table class="ps-info">
        <tr><th>Supervisor</th><td>${esc(eq?.supervisor||'—')}</td><th>Encarregado</th><td>${esc(eq?.encarregado||'—')}</td></tr>
        <tr><th>Motorista</th><td>${esc(eq?.motorista||'—')}</td><th>Eletricistas</th><td>${esc((eq?.eletricistas||[]).filter(Boolean).join(', ')||'—')}</td></tr>
        <tr><th>Ciclo</th><td>${esc(pg.ciclo||'—')}</td><th>Setor</th><td>${esc(pr?.setor||'—')}</td></tr>
        ${pg.local? `<tr><th>Local de execução</th><td colspan="3"><strong>${esc(pg.local)}</strong>${(pg.localLat!=null&&pg.localLng!=null)? ` — ${esc(mapsLinkByCoords(pg.localLat,pg.localLng))}`:''}</td></tr>`:''}
      </table>
      ${(pg.localLat!=null&&pg.localLng!=null)? `<div style="margin:10px 0;"><strong>Localização:</strong><br>${staticMapImgTag(pg.localLat,pg.localLng,16,640,360, 'Mapa: '+(pg.local||''), 'width:100%;max-width:520px;border:1px solid #999;border-radius:4px;')}
      <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <img src="${esc(qrCodeUrl(mapsLinkByCoords(pg.localLat,pg.localLng), 100))}" alt="QR Code localização" style="width:100px;height:100px;border:1px solid #999;border-radius:4px;">
        <div style="font-size:11px;color:#333;"><strong>Escaneie para abrir no Google Maps</strong><br>${esc(mapsLinkByCoords(pg.localLat,pg.localLng))}</div>
      </div>
    </div>`:''}
      <table>
        <thead><tr><th style="width:26px;">#</th><th>Código</th><th>Descrição</th><th style="width:40px;">Un.</th><th style="width:52px;">Qtd prev.</th><th style="width:64px;">Qtd exec.</th><th>Obs.</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ps-check"><div><strong>Executou?</strong> &nbsp;☐ SIM &nbsp;☐ NÃO &nbsp;☐ PARCIAL</div><div><strong>Data da execução:</strong> ____/____/____</div></div>
      <div class="ps-sign"><strong>Observações do campo:</strong><div class="ps-obs"></div></div>
      <div class="ps-sign"><strong>Assinatura do encarregado:</strong> <span class="ps-line"></span></div>
    </div>
  </div>`;
}
let printDisparado = false;
function renderPrintDoc(){
  const root = document.getElementById('team-body');
  const pg = DB?.programacoes?.find(p=>p.id===PRINT_PROG);
  if(!pg){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Programação não encontrada.</p></div></div>`; return; }
  root.innerHTML = buildDocEquipeHtml(pg, PRINT_EQUIPE||(pg.atribuicoes||[])[0]?.equipeId);
  if(printDisparado) return;
  printDisparado = true;
  const imgs = root.querySelectorAll('img');
  if(!imgs.length){ window.print(); return; }
  let pendentes = 0, impresso = false;
  const tentar = ()=>{ pendentes--; if(pendentes<=0 && !impresso){ impresso = true; window.print(); } };
  imgs.forEach(img=>{
    if(img.complete && img.naturalWidth>0) return;
    pendentes++;
    img.addEventListener('load', tentar, {once:true});
    img.addEventListener('error', tentar, {once:true});
  });
  setTimeout(()=>{ if(!impresso){ impresso = true; window.print(); } }, 1500);
}
function initPrint(){
  document.body.classList.add('print-mode');
  const root = document.getElementById('team-body');
  if(!PRINT_PROG){ root.innerHTML = `<div class="panel"><div class="empty-state"><p>Link inválido para o documento.</p></div></div>`; return; }
  const cached = loadCache();
  if(cached){ DB = cached; renderPrintDoc(); }
  DB_REF.once('value').then(snap=>{
    if(snap.exists()){
      const v = snap.val();
      DB = (typeof v==='string')? JSON.parse(v) : v;
      saveCache(DB);
    }
    renderPrintDoc();
  }).catch(()=>{ renderPrintDoc(); });
}

/* --- init --- */
function init(){
  if(PRINT_PROG){
    initPrint();
    return;
  }
  if(!progId && !ocndsId && !podaId && !oseId){
    render();
    setStatus('Link inválido', 'warn');
    return;
  }
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('./sw.js').catch(()=>{}); }
  const cached = loadCache();
  if(cached){ DB = cached; dbToEditors(DB); if(!isOcndsMode) atualizaRDOCompletado(); render(); }
  window.addEventListener('online', ()=>{ online=true; setStatus('Conectado — sincronizando…','ok'); if(isOcndsMode) syncNowOcNds(); else syncNow(); });
  window.addEventListener('offline', ()=>{ online=false; setStatus('Offline — as alterações serão enviadas quando houver conexão','warn'); });
  DB_REF.once('value').then(snap=>{
    if(snap.exists()){
      const v = snap.val();
      DB = (typeof v==='string')? JSON.parse(v) : v;
      saveCache(DB); dbToEditors(DB);
    }
    if(!isOcndsMode){
      const pg = teamFindProg(DB);
      if(pg){
        const _d = diasAtrasoProgramacao();
        if(_d){
          setStatus(`Envio atrasado — ${_d} dia${_d>1?'s':''} após a programação`, 'warn');
        }
      }
      atualizaRDOCompletado();
    }
    render();
  }).catch(()=>{ render(); }).finally(()=>{ if(isOcndsMode) syncNowOcNds(); else syncNow(); });
  window.addEventListener('pagehide', ()=>pararPresencaTeam());
  window.addEventListener('beforeunload', ()=>pararPresencaTeam());
  iniciarPresencaTeam();
}
init();
