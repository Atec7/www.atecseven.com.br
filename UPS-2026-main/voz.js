// =====================================================================
// ALERTAS POR VOZ — gratuito (Web Speech API do navegador)
// ---------------------------------------------------------------------
// Configuração GLOBAL (Firebase: voice_settings) — definida pelo admin e
// aplicada a todos os usuários (admin e supervisores): liga/desliga,
// alertas e anúncios de déficit por setor.
// Configuração LOCAL (localStorage) — preferências do aparelho: voz,
// velocidade, tom, volume, aviso sonoro e "silenciar neste aparelho".
// =====================================================================
(function() {
  'use strict';

  var GLOBAL_PATH = 'voice_settings';
  var GLOBAL_LS = 'ups_voice_global';
  var LOCAL_KEY = 'ups_voice_cfg';
  var SPOKEN_KEY = 'ups_voice_spoken';
  var DEFICIT_KEY = 'ups_voice_deficit';
  var synth = window.speechSynthesis || null;
  var supported = !!(synth && window.SpeechSynthesisUtterance);
  var audioOk = typeof Audio !== 'undefined';
  function canSpeak() { return supported || audioOk; }
  var gen = 0; // incrementa ao parar, para interromper a fila em andamento

  var GLOBAL_DEFAULTS = {
    enabled: false,
    rules: { classA: true, fimTurno: true, semAbertura: true, parada: true, offline: false, encerrado: false },
    fimTurnoMin: 60,
    semAberturaMin: 60,
    paradaMin: 120,
    offlineMin: 30,
    deficit: { stc: true, stcMin: 40, perdas: true, perdasMin: 60 }
  };
  var LOCAL_DEFAULTS = { voiceURI: '', rate: 1.0, pitch: 1.0, volume: 1.0, chime: true, muted: false };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeGlobal(src) {
    var out = clone(GLOBAL_DEFAULTS);
    if (!src || typeof src !== 'object') return out;
    Object.keys(src).forEach(function(k) {
      if ((k === 'rules' || k === 'deficit') && src[k] && typeof src[k] === 'object') {
        Object.keys(src[k]).forEach(function(r) { out[k][r] = src[k][r]; });
      } else if (k in out) out[k] = src[k];
    });
    return out;
  }
  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  var gcfg = mergeGlobal(lsGet(GLOBAL_LS));          // último valor conhecido (funciona offline)
  var lcfg = Object.assign(clone(LOCAL_DEFAULTS), lsGet(LOCAL_KEY) || {});
  function saveLocal() { lsSet(LOCAL_KEY, lcfg); }

  function canEditGlobal() { return typeof isAdmin === 'function' && isAdmin(); }
  function active() { return canSpeak() && gcfg.enabled && !lcfg.muted; }

  // Lê a configuração global (cache de 60s compartilhado com o app)
  function refreshGlobal() {
    if (typeof fbCached !== 'function') return Promise.resolve(gcfg);
    return fbCached(GLOBAL_PATH, 60000).then(function(data) {
      if (data && typeof data === 'object') {
        gcfg = mergeGlobal(data);
        lsSet(GLOBAL_LS, gcfg);
        updateButtons();
      }
      return gcfg;
    }).catch(function() { return gcfg; });
  }

  function saveGlobal() {
    if (!canEditGlobal()) return;
    lsSet(GLOBAL_LS, gcfg);
    updateButtons();
    if (typeof memoryCache !== 'undefined') {
      Object.keys(memoryCache).forEach(function(k) { if (k.indexOf(GLOBAL_PATH + '|') === 0) delete memoryCache[k]; });
    }
    if (typeof fbUpdate !== 'function') return;
    var payload = clone(gcfg);
    payload.updated_at = Date.now();
    payload.updated_by = (typeof currentUser !== 'undefined' && currentUser && currentUser.username) || '';
    fbUpdate(GLOBAL_PATH, payload).catch(function(err) {
      notify('Erro ao salvar configuração de voz: ' + (err && err.message || err), 'error');
    });
  }

  // ---------- Vozes ----------
  var voices = [];
  function scoreVoice(v) {
    var name = (v.name || '').toLowerCase();
    var lang = (v.lang || '').toLowerCase().replace('_', '-');
    if (lang.indexOf('pt') !== 0) return -1;
    var s = lang === 'pt-br' ? 30 : 5;
    if (name.indexOf('natural') !== -1) s += 100;
    if (name.indexOf('neural') !== -1) s += 90;
    if (name.indexOf('online') !== -1) s += 40;
    if (name.indexOf('google') !== -1) s += 50;
    if (/francisca|thalita|antonio|brenda|leila|yara|elza|giovanna|leticia/.test(name)) s += 10;
    if (!v.localService) s += 5;
    return s;
  }
  function loadVoices() {
    if (!supported) return [];
    voices = synth.getVoices().filter(function(v) { return scoreVoice(v) >= 0; })
      .sort(function(a, b) { return scoreVoice(b) - scoreVoice(a); });
    return voices;
  }
  // Voz online do Google: funciona em qualquer navegador/aparelho
  var GOOGLE = '__google__';
  function hasNaturalVoice() {
    if (!voices.length) loadVoices();
    return !!(voices[0] && scoreVoice(voices[0]) >= 90);
  }
  // 'google' ou 'browser'. Automático: voz neural do navegador (Edge) se existir; senão Google.
  function engine() {
    if (!supported || lcfg.voiceURI === GOOGLE) return 'google';
    if (lcfg.voiceURI && voices.some(function(v) { return v.voiceURI === lcfg.voiceURI; })) return 'browser';
    return hasNaturalVoice() ? 'browser' : 'google';
  }
  function currentVoice() {
    if (!voices.length) loadVoices();
    if (lcfg.voiceURI && lcfg.voiceURI !== GOOGLE) {
      var found = voices.find(function(v) { return v.voiceURI === lcfg.voiceURI; });
      if (found) return found;
    }
    return voices[0] || null;
  }
  if (supported) {
    loadVoices();
    if (synth.addEventListener) {
      synth.addEventListener('voiceschanged', function() {
        loadVoices();
        if ($id('vzVoice')) fillVoiceSelect();
      });
    }
  }

  // ---------- Som de aviso ----------
  var audioCtx = null;
  function chime() {
    return new Promise(function(resolve) {
      if (!lcfg.chime) return resolve();
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return resolve();
        audioCtx = audioCtx || new AC();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        var t = audioCtx.currentTime;
        [[659.25, 0], [880, 0.16]].forEach(function(n) {
          var o = audioCtx.createOscillator();
          var g = audioCtx.createGain();
          o.type = 'sine';
          o.frequency.value = n[0];
          g.gain.setValueAtTime(0.0001, t + n[1]);
          g.gain.exponentialRampToValueAtTime(0.18 * lcfg.volume, t + n[1] + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.45);
          o.connect(g); g.connect(audioCtx.destination);
          o.start(t + n[1]); o.stop(t + n[1] + 0.5);
        });
        setTimeout(resolve, 650);
      } catch (e) { resolve(); }
    });
  }

  // ---------- Fila de fala ----------
  var queue = [];
  var speaking = false;
  var keepAlive = null;

  function humanize(text) {
    return String(text)
      .replace(/\bUPS\b/g, 'U P S')
      .replace(/\bSTC\b/g, 'S T C')
      .replace(/(\d+)\.(\d+)/g, '$1 vírgula $2')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function splitSentences(text) {
    var parts = text.match(/[^.!?;]+[.!?;]?/g) || [text];
    return parts.map(function(p) { return p.trim(); }).filter(Boolean);
  }
  // Divide em trechos de até ~180 caracteres (limite do serviço do Google)
  function chunkText(text, max) {
    var out = [];
    var rest = text;
    while (rest.length > max) {
      var cut = rest.lastIndexOf(',', max);
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }
  var currentAudio = null;
  function playGoogle(text) {
    return new Promise(function(resolve, reject) {
      var url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=pt-BR&ttsspeed=1&q=' + encodeURIComponent(text);
      var a = new Audio();
      currentAudio = a;
      a.preload = 'auto';
      a.volume = Math.max(0, Math.min(1, Number(lcfg.volume)));
      try { a.preservesPitch = true; } catch (e) {}
      a.onended = function() { resolve(); };
      a.onerror = function() { reject(new Error('audio')); };
      a.src = url;
      a.playbackRate = Number(lcfg.rate) || 1;
      var p = a.play();
      if (p && p.catch) p.catch(reject);
      setTimeout(resolve, Math.max(10000, text.length * 200));
    });
  }
  function speakGoogle(text) {
    var chain = Promise.resolve();
    chunkText(humanize(text), 180).forEach(function(part) {
      chain = chain.then(function() { return playGoogle(part); });
    });
    return chain;
  }
  function speakNow(text) {
    if (engine() === 'google') {
      // Se o serviço online falhar (sem internet/bloqueio), usa a voz do navegador
      return speakGoogle(text).catch(function() { return supported ? speakBrowser(text) : null; });
    }
    return speakBrowser(text);
  }
  function speakBrowser(text) {
    return new Promise(function(resolve) {
      var u = new SpeechSynthesisUtterance(humanize(text));
      var v = currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'pt-BR'; }
      u.rate = Number(lcfg.rate) || 1;
      u.pitch = Number(lcfg.pitch) || 1;
      u.volume = Number(lcfg.volume);
      var done = false;
      var finish = function() { if (!done) { done = true; resolve(); } };
      u.onend = finish;
      u.onerror = finish;
      setTimeout(finish, Math.max(8000, text.length * 160));
      synth.speak(u);
    });
  }
  function processQueue() {
    if (speaking || !queue.length || !canSpeak()) return;
    speaking = true;
    var item = queue.shift();
    var myGen = gen;
    clearInterval(keepAlive);
    if (supported) keepAlive = setInterval(function() { if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); } }, 10000);
    var chain = chime();
    splitSentences(item).forEach(function(s) {
      chain = chain.then(function() { return myGen === gen ? speakNow(s) : null; }).then(function() {
        return new Promise(function(r) { setTimeout(r, 180); });
      });
    });
    chain.then(function() {
      if (myGen !== gen) return;
      clearInterval(keepAlive);
      speaking = false;
      setTimeout(processQueue, 700);
    });
  }
  function say(text) {
    if (!canSpeak() || !text) return;
    queue.push(text);
    processQueue();
  }
  function stop() {
    gen++;
    queue = [];
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
    if (supported) synth.cancel();
    clearInterval(keepAlive);
    speaking = false;
  }

  // ---------- Textos ----------
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function numWord(n, singular, plural) { return n + ' ' + (n === 1 ? singular : plural); }
  function durationWords(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    if (h && m) return numWord(h, 'hora', 'horas') + ' e ' + numWord(m, 'minuto', 'minutos');
    if (h) return numWord(h, 'hora', 'horas');
    return numWord(m, 'minuto', 'minutos');
  }
  function upsWords(v) {
    var n = Math.round(v * 10) / 10;
    return (n % 1 === 0 ? String(n) : String(n).replace('.', ',')) + ' UPS';
  }
  // Inteiro sem separador de milhar: a voz lê "1250 reais" corretamente
  function moneyWords(v) {
    var n = Math.round(Math.max(0, v));
    return numWord(n, 'real', 'reais');
  }
  function clockWords() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    return h + (m ? ' e ' + m : ' horas');
  }
  function joinNames(names) {
    var list = names.slice(0, 6);
    var extra = names.length - list.length;
    if (extra > 0) return list.join(', ') + ', e mais ' + numWord(extra, 'equipe', 'equipes');
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(', ') + ' e ' + list[list.length - 1];
  }
  function spokenName(name) { return String(name || 'sem nome').replace(/[-_]+/g, ' '); }
  function classWords(c) { return c && c !== '-' ? 'classe ' + c : 'sem classificação'; }

  // ---------- Cálculos por equipe (dia de hoje) ----------
  function topClass() {
    var rules = (typeof rulesCache !== 'undefined' && rulesCache) || [];
    if (!rules.length) return null;
    return rules.slice().sort(function(a, b) { return b.minUps - a.minUps; })[0];
  }
  function parseHM(str) {
    var p = String(str || '').split(':').map(Number);
    if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return null;
    return p;
  }
  function shiftStartMs(team) {
    var p = parseHM(team.shift_start);
    if (!p) return null;
    var now = new Date();
    var ms = new Date(now.getFullYear(), now.getMonth(), now.getDate(), p[0], p[1]).getTime();
    if (ms > now.getTime()) ms -= 86400000;
    return ms;
  }
  function serviceTimeMs(s) {
    var p = parseHM(s.time);
    if (!p || !s.date) return null;
    var d = String(s.date).split('-').map(Number);
    return new Date(d[0], d[1] - 1, d[2], p[0], p[1]).getTime();
  }
  function todayInfo(team, today) {
    var svcs = (team.services || []).filter(function(s) { return s.date === today; });
    var ups = svcs.reduce(function(sum, s) { return sum + (s.upsValue || 0); }, 0);
    var money = svcs.reduce(function(sum, s) { return sum + (s.totalMoney || 0); }, 0);
    var cls = (typeof getClassification === 'function') ? getClassification(ups) : { class: '-' };
    var sp = (typeof getShiftProgress === 'function') ? getShiftProgress(team) : { enabled: false };
    return { svcs: svcs, ups: ups, money: money, cls: cls, sp: sp };
  }

  function evaluateTeam(team, today) {
    var events = [];
    var info = todayInfo(team, today);
    var svcs = info.svcs, ups = info.ups, cls = info.cls, sp = info.sp;
    var top = topClass();
    var isTop = top && cls.class === top.class;
    var name = spokenName(team.username);
    var now = Date.now();
    var r = gcfg.rules;

    if (r.classA && top && isTop) events.push({ rule: 'classA', key: 'classA', name: name, ups: ups, cls: cls.class });

    if (sp.enabled && sp.status === 'durante') {
      var startMs = shiftStartMs(team);
      var sinceStartMin = startMs ? (now - startMs) / 60000 : 0;
      var remainingMin = (sp.remaining || 0) / 60000;

      if (r.fimTurno && top && !isTop && remainingMin <= gcfg.fimTurnoMin) {
        events.push({ rule: 'fimTurno', key: 'fimTurno', name: name, ups: ups, cls: cls.class,
          remaining: remainingMin, missing: Math.max(0, top.minUps - ups), top: top.class });
      }
      if (r.semAbertura && svcs.length === 0 && sinceStartMin >= gcfg.semAberturaMin) {
        events.push({ rule: 'semAbertura', key: 'semAbertura', name: name, since: sinceStartMin, start: team.shift_start });
      }
      if (r.parada && svcs.length > 0) {
        var last = svcs.reduce(function(m, s) { var t = serviceTimeMs(s); return t && t > m ? t : m; }, 0);
        var idle = last ? (now - last) / 60000 : 0;
        if (last && idle >= gcfg.paradaMin) events.push({ rule: 'parada', key: 'parada@' + last, name: name, idle: idle });
      }
      if (r.offline && team.lastSeen && (now - team.lastSeen) / 60000 >= gcfg.offlineMin && sinceStartMin >= gcfg.offlineMin) {
        events.push({ rule: 'offline', key: 'offline', name: name, off: (now - team.lastSeen) / 60000 });
      }
    }
    if (r.encerrado && sp.enabled && sp.status === 'depois' && top && !isTop) {
      events.push({ rule: 'encerrado', key: 'encerrado', name: name, ups: ups, cls: cls.class });
    }
    return events;
  }

  function phrase(rule, evs) {
    var n = evs.length;
    var names = evs.map(function(e) { return e.name; });
    var e = evs[0];
    switch (rule) {
      case 'classA':
        if (n === 1) return pick([
          'Boa notícia! A equipe ' + e.name + ' acaba de alcançar a ' + classWords(e.cls) + ', com ' + upsWords(e.ups) + ' hoje. Parabéns ao time!',
          'Parabéns, equipe ' + e.name + '! Vocês chegaram à ' + classWords(e.cls) + ', somando ' + upsWords(e.ups) + ' no dia.',
          'Que ótimo! A equipe ' + e.name + ' entrou na ' + classWords(e.cls) + ', com ' + upsWords(e.ups) + '.'
        ]);
        return 'Boa notícia! ' + numWord(n, 'equipe chegou', 'equipes chegaram') + ' à ' + classWords(e.cls) + ' hoje: ' + joinNames(names) + '. Parabéns a todos!';
      case 'fimTurno':
        if (n === 1) return pick([
          'Atenção. A equipe ' + e.name + ' está a ' + durationWords(e.remaining) + ' do fim do turno, e ainda está na ' + classWords(e.cls) + ', com ' + upsWords(e.ups) + '. Faltam ' + upsWords(e.missing) + ' para a classe ' + e.top + '.',
          'Fique de olho na equipe ' + e.name + '. O turno termina em ' + durationWords(e.remaining) + ', e ela segue na ' + classWords(e.cls) + '. Ainda faltam ' + upsWords(e.missing) + ' para chegar à classe ' + e.top + '.'
        ]);
        return 'Atenção. ' + numWord(n, 'equipe está', 'equipes estão') + ' perto do fim do turno, ainda abaixo da classe ' + e.top + ': ' +
          evs.slice(0, 6).map(function(x) { return x.name + ', na ' + classWords(x.cls); }).join('; ') + (n > 6 ? '; e mais ' + (n - 6) : '') + '.';
      case 'semAbertura':
        if (n === 1) return pick([
          'Atenção. A equipe ' + e.name + ' ainda não fez nenhum lançamento hoje. O turno começou às ' + e.start + ', há ' + durationWords(e.since) + '.',
          'Alerta de abertura. Já se passaram ' + durationWords(e.since) + ' desde o início do turno, e a equipe ' + e.name + ' continua sem lançamento.'
        ]);
        return 'Atenção. ' + numWord(n, 'equipe continua', 'equipes continuam') + ' sem nenhum lançamento, mais de ' + durationWords(gcfg.semAberturaMin) + ' após a abertura do turno: ' + joinNames(names) + '.';
      case 'parada':
        if (n === 1) return pick([
          'A equipe ' + e.name + ' está sem lançar serviço há ' + durationWords(e.idle) + '. Vale a pena verificar o que está acontecendo.',
          'Atenção. Nenhum lançamento novo da equipe ' + e.name + ' há ' + durationWords(e.idle) + '.'
        ]);
        return 'Atenção. ' + numWord(n, 'equipe está parada', 'equipes estão paradas') + ', sem novos lançamentos há mais de ' + durationWords(gcfg.paradaMin) + ': ' + joinNames(names) + '.';
      case 'offline':
        if (n === 1) return 'A equipe ' + e.name + ' está sem conexão há ' + durationWords(e.off) + ', em pleno turno.';
        return numWord(n, 'equipe está', 'equipes estão') + ' sem conexão durante o turno: ' + joinNames(names) + '.';
      case 'encerrado':
        if (n === 1) return 'O turno da equipe ' + e.name + ' foi encerrado na ' + classWords(e.cls) + ', com ' + upsWords(e.ups) + '.';
        return 'Turno encerrado abaixo da classe A para ' + numWord(n, 'equipe', 'equipes') + ': ' + joinNames(names) + '.';
    }
    return '';
  }
  var RULE_ORDER = ['semAbertura', 'parada', 'fimTurno', 'offline', 'encerrado', 'classA'];

  // ---------- Déficit por setor ----------
  // Considera as equipes do setor em turno agora (ou sem horário cadastrado)
  function teamsInShift(teams, sector) {
    return (teams || []).filter(function(t) {
      if ((t.sector || 'STC') !== sector) return false;
      var sp = (typeof getShiftProgress === 'function') ? getShiftProgress(t) : { enabled: false };
      return !sp.enabled || sp.status === 'durante';
    });
  }

  function stcDeficitText(teams, today) {
    var list = teamsInShift(teams, 'STC');
    if (!list.length) return '';
    var top = topClass();
    var withGoal = 0, below = 0, moneyDef = 0, upsDef = 0, belowTop = 0;
    var rank = [];
    list.forEach(function(t) {
      var info = todayInfo(t, today);
      if (t.goal_money > 0) {
        withGoal++;
        var d = Math.max(0, t.goal_money - info.money);
        if (d > 0) { below++; moneyDef += d; rank.push({ name: spokenName(t.username), def: d }); }
      }
      if (top && info.ups < top.minUps) { belowTop++; upsDef += top.minUps - info.ups; }
    });
    var parts = ['Déficit do STC, atualização das ' + clockWords() + '.'];
    if (withGoal) {
      if (!below) parts.push('Sem déficit financeiro: todas as equipes em turno já bateram a meta do dia. Parabéns!');
      else {
        parts.push('Faltam ' + moneyWords(moneyDef) + ' para a meta do dia. ' + below + ' de ' + withGoal + ' equipes estão abaixo da meta.');
        rank.sort(function(a, b) { return b.def - a.def; });
        parts.push('Maiores déficits: ' + rank.slice(0, 3).map(function(r) { return r.name + ', faltando ' + moneyWords(r.def); }).join('; ') + '.');
      }
    }
    if (top) {
      if (belowTop) parts.push(numWord(belowTop, 'equipe ainda está', 'equipes ainda estão') + ' abaixo da classe ' + top.class + ', somando ' + upsWords(upsDef) + ' de déficit.');
      else parts.push('Todas as equipes em turno estão na classe ' + top.class + '.');
    }
    return parts.length > 1 ? parts.join(' ') : '';
  }

  function perdasDeficitText(teams, today) {
    var list = teamsInShift(teams, 'PERDAS');
    if (!list.length) return '';
    var cats = (typeof PERDAS_CATS !== 'undefined' && PERDAS_CATS) || [];
    var catDef = {}, catGoal = {};
    cats.forEach(function(c) { catDef[c.key] = 0; catGoal[c.key] = 0; });
    var withGoal = 0, below = 0, rank = [];
    list.forEach(function(t) {
      var info = todayInfo(t, today);
      var counts = (typeof perdasCounts === 'function') ? perdasCounts(info.svcs) : {};
      var goals = t.perdasGoals || {};
      var teamDef = 0, hasGoal = false;
      cats.forEach(function(c) {
        var g = Number(goals[c.key]) || 0;
        if (g <= 0) return;
        hasGoal = true;
        catGoal[c.key] += g;
        var d = Math.max(0, g - (counts[c.key] || 0));
        catDef[c.key] += d;
        teamDef += d;
      });
      if (hasGoal) {
        withGoal++;
        if (teamDef > 0) { below++; rank.push({ name: spokenName(t.username), def: teamDef }); }
      }
    });
    if (!withGoal) return '';
    var parts = ['Déficit de Perdas, atualização das ' + clockWords() + '.'];
    if (!below) {
      parts.push('Sem déficit: todas as equipes em turno já bateram as metas do dia. Parabéns!');
      return parts.join(' ');
    }
    var catParts = cats.filter(function(c) { return catGoal[c.key] > 0; }).map(function(c) {
      return c.label + ', ' + (catDef[c.key] > 0 ? 'faltam ' + numWord(catDef[c.key], 'execução', 'execuções') : 'meta batida');
    });
    if (catParts.length) parts.push(catParts.join('; ') + '.');
    parts.push(below + ' de ' + withGoal + ' equipes estão abaixo da meta.');
    rank.sort(function(a, b) { return b.def - a.def; });
    parts.push('Maiores déficits: ' + rank.slice(0, 3).map(function(r) { return r.name + ', faltando ' + r.def; }).join('; ') + '.');
    return parts.join(' ');
  }

  function deficitTick() {
    if (!active() || !lastTeams || !periodHasToday(lastPeriod)) return;
    var d = gcfg.deficit || {};
    var today = todayStr();
    var last = lsGet(DEFICIT_KEY) || {};
    var now = Date.now();
    [['STC', d.stc, d.stcMin, stcDeficitText], ['PERDAS', d.perdas, d.perdasMin, perdasDeficitText]].forEach(function(s) {
      if (!s[1]) return;
      var every = Math.max(5, Number(s[2]) || 60) * 60000;
      if (last[s[0]] && now - last[s[0]] < every) return;
      var text = s[3](lastTeams, today);
      if (!text) return;
      last[s[0]] = now;
      say(text);
    });
    lsSet(DEFICIT_KEY, last);
  }

  // ---------- Controle de repetição (uma vez por dia) ----------
  function loadSpoken(today) {
    var s = lsGet(SPOKEN_KEY) || {};
    if (s.day !== today) s = { day: today, keys: {} };
    return s;
  }
  function collect(teams, today) {
    var all = [];
    (teams || []).forEach(function(t) {
      evaluateTeam(t, today).forEach(function(ev) { ev.userId = t.userId; all.push(ev); });
    });
    return all;
  }
  function speakEvents(evs) {
    var grouped = {};
    evs.forEach(function(ev) { (grouped[ev.rule] = grouped[ev.rule] || []).push(ev); });
    RULE_ORDER.forEach(function(rule) {
      if (grouped[rule]) say(phrase(rule, grouped[rule]));
    });
  }
  function periodHasToday(p) {
    var today = todayStr();
    return !p || (p.start <= today && p.end >= today);
  }

  var lastTeams = null, lastPeriod = null;

  // Chamado a cada atualização dos dados (painel / monitor)
  function check(teams, period) {
    lastTeams = teams || [];
    lastPeriod = period || null;
    refreshGlobal().then(function() {
      if (!active() || !lastTeams.length || !periodHasToday(lastPeriod)) return;
      var today = todayStr();
      var spoken = loadSpoken(today);
      var fresh = collect(lastTeams, today).filter(function(ev) {
        var k = ev.rule + '|' + ev.userId + '|' + ev.key;
        if (spoken.keys[k]) return false;
        spoken.keys[k] = Date.now();
        return true;
      });
      lsSet(SPOKEN_KEY, spoken);
      if (fresh.length) speakEvents(fresh);
      deficitTick();
    });
  }
  setInterval(deficitTick, 60000);

  // ---------- Teste ----------
  function test() {
    if (!canSpeak()) { notify('Este navegador não suporta áudio.', 'error'); return; }
    stop();
    var v = engine() === 'browser' ? currentVoice() : null;
    var who = v ? v.name.replace(/Microsoft\s*/i, '').replace(/\s*\(.*\)/, '').replace(/Online|Natural/gi, '').replace(/\s*-\s*.*$/, '').trim() : 'online do Google';
    say('Olá! ' + (who ? 'Eu sou a voz ' + who + ', ' : 'Esta é a voz ') + 'dos alertas do Sistema UPS. ' +
      'Atenção. A equipe Exemplo está a quarenta minutos do fim do turno, e ainda está na classe B. ' +
      'Boa notícia! A equipe Modelo acaba de alcançar a classe A. Parabéns ao time!');
  }
  function previewCurrent() {
    if (!canSpeak()) return test();
    stop();
    var evs = collect(currentTeams(), todayStr());
    if (!evs.length) say('Tudo tranquilo por aqui. No momento, nenhuma equipe está em situação de alerta.');
    else speakEvents(evs);
  }
  function previewDeficit() {
    if (!canSpeak()) return test();
    stop();
    var teams = currentTeams(), today = todayStr();
    var a = stcDeficitText(teams, today), b = perdasDeficitText(teams, today);
    if (!a && !b) say('No momento, nenhuma equipe está em turno para calcular o déficit.');
    if (a) say(a);
    if (b) say(b);
  }
  function currentTeams() {
    var v = document.querySelector('.view.active');
    if (v && v.id === 'monitorView' && typeof monitorData !== 'undefined') return monitorData;
    if (typeof painelData !== 'undefined') return painelData;
    return [];
  }
  function notify(msg, type) {
    if (typeof toast === 'function') toast(msg, type || 'info'); else alert(msg);
  }

  // ---------- Interface ----------
  function $id(id) { return document.getElementById(id); }

  function fillVoiceSelect() {
    var sel = $id('vzVoice');
    if (!sel) return;
    loadVoices();
    var sv = lcfg.voiceURI || '';
    var autoLabel = 'Automática — ' + (hasNaturalVoice() ? 'voz neural deste navegador' : 'voz online do Google');
    var opts = [
      '<option value=""' + (sv === '' ? ' selected' : '') + '>' + autoLabel + '</option>',
      '<option value="' + GOOGLE + '"' + (sv === GOOGLE ? ' selected' : '') + '>★ Google online — pt-BR (qualquer aparelho)</option>'
    ];
    voices.forEach(function(v) {
      var label = (scoreVoice(v) >= 90 ? '★ ' : '') + v.name + ' (' + v.lang + ')';
      opts.push('<option value="' + v.voiceURI.replace(/"/g, '&quot;') + '"' + (sv === v.voiceURI ? ' selected' : '') + '>' + label.replace(/</g, '&lt;') + '</option>');
    });
    sel.innerHTML = opts.join('');
  }

  function ruleRow(key, label, minKey, minLabel) {
    return '<div class="vz-rule">' +
      '<label class="vz-check"><input type="checkbox" data-rule="' + key + '"' + (gcfg.rules[key] ? ' checked' : '') + '> ' + label + '</label>' +
      (minKey ? '<span class="vz-min">' + minLabel + ' <input type="number" min="5" max="600" step="5" data-min="' + minKey + '" value="' + gcfg[minKey] + '"> min</span>' : '') +
      '</div>';
  }
  function deficitRow(key, label) {
    var d = gcfg.deficit;
    return '<div class="vz-rule">' +
      '<label class="vz-check"><input type="checkbox" data-def="' + key + '"' + (d[key] ? ' checked' : '') + '> ' + label + '</label>' +
      '<span class="vz-min">a cada <input type="number" min="5" max="600" step="5" data-defmin="' + key + 'Min" value="' + d[key + 'Min'] + '"> min</span>' +
      '</div>';
  }

  function injectCss() {
    if ($id('vzCss')) return;
    var css = document.createElement('style');
    css.id = 'vzCss';
    css.textContent =
      '#voiceModal .vz-rule{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;padding:9px 0;border-bottom:1px solid var(--border-light, rgba(0,0,0,.06));}' +
      '#voiceModal .vz-rule:last-child{border-bottom:0;}' +
      '#voiceModal .vz-check{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--text);cursor:pointer;flex:1;min-width:200px;}' +
      '#voiceModal .vz-min{font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;}' +
      '#voiceModal .vz-min input{width:72px;padding:5px 8px;min-height:32px;font-size:13px;}' +
      '#voiceModal input[type=range]{width:100%;accent-color:var(--primary);}' +
      '#voiceModal .vz-sliders{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}' +
      '@media (max-width:520px){#voiceModal .vz-sliders{grid-template-columns:1fr;}}' +
      '#voiceModal .vz-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}' +
      '#voiceModal .vz-actions .btn{flex:1;min-width:140px;justify-content:center;}' +
      '#voiceModal .vz-section{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-secondary);margin:18px 0 4px;}' +
      '#voiceModal .vz-locked{opacity:.6;}' +
      '.icon-btn.vz-btn{position:relative;}' +
      '.icon-btn.vz-on{color:var(--primary);}' +
      '.icon-btn.vz-on::after{content:"";position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:var(--success, #22c55e);}';
    document.head.appendChild(css);
  }

  function buildModal() {
    injectCss();
    var old = $id('voiceModal');
    if (old) old.parentNode.removeChild(old);
    var editable = canEditGlobal();
    var m = document.createElement('div');
    m.id = 'voiceModal';
    m.className = 'modal-overlay';
    m.style.display = 'none';
    m.setAttribute('onclick', 'if(event.target===this)VoiceAlerts.close()');
    m.innerHTML =
      '<div class="modal-content" role="dialog" aria-modal="true" style="max-width:560px;">' +
        '<div class="modal-header">' +
          '<h2><span class="material-symbols-outlined">record_voice_over</span> Alertas por voz</h2>' +
          '<button class="modal-close-btn" onclick="VoiceAlerts.close()" aria-label="Fechar"><span class="material-symbols-outlined">close</span></button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div id="vzGlobal" class="' + (editable ? '' : 'vz-locked') + '">' +
            '<label class="vz-check" style="font-size:15px;font-weight:600;"><input type="checkbox" id="vzEnabled"' + (gcfg.enabled ? ' checked' : '') + '> Ativar alertas por voz para todos os usuários</label>' +

            '<div class="vz-section">Alertas</div>' +
            ruleRow('classA', 'Equipe alcançou a classe A', null) +
            ruleRow('fimTurno', 'Perto do fim do turno em classe B ou inferior', 'fimTurnoMin', 'faltando') +
            ruleRow('semAbertura', 'Sem lançamento após a previsão de abertura', 'semAberturaMin', 'após') +
            ruleRow('parada', 'Equipe parada (sem novo lançamento)', 'paradaMin', 'há') +
            ruleRow('offline', 'Equipe sem conexão durante o turno', 'offlineMin', 'há') +
            ruleRow('encerrado', 'Turno encerrado abaixo da classe A', null) +

            '<div class="vz-section">Déficit por setor</div>' +
            deficitRow('stc', 'Déficit do STC') +
            deficitRow('perdas', 'Déficit de Perdas') +
          '</div>' +

          '<div class="vz-section">Voz deste aparelho</div>' +
          '<div class="form-group" style="margin-bottom:6px;"><select id="vzVoice"></select></div>' +
          '<div class="vz-sliders" style="margin-top:12px;">' +
            '<div><label class="field-label">Velocidade <span id="vzRateV"></span></label><input type="range" id="vzRate" min="0.7" max="1.4" step="0.05" value="' + lcfg.rate + '"></div>' +
            '<div><label class="field-label">Tom <span id="vzPitchV"></span></label><input type="range" id="vzPitch" min="0.7" max="1.3" step="0.05" value="' + lcfg.pitch + '"></div>' +
            '<div><label class="field-label">Volume <span id="vzVolV"></span></label><input type="range" id="vzVol" min="0.1" max="1" step="0.05" value="' + lcfg.volume + '"></div>' +
          '</div>' +
          '<label class="vz-check" style="margin-top:10px;"><input type="checkbox" id="vzChime"' + (lcfg.chime ? ' checked' : '') + '> Aviso sonoro antes de falar</label>' +
          '<label class="vz-check" style="margin-top:8px;"><input type="checkbox" id="vzMuted"' + (lcfg.muted ? ' checked' : '') + '> Silenciar neste aparelho</label>' +

          '<div class="vz-actions">' +
            '<button class="btn btn-primary" onclick="VoiceAlerts.test()"><span class="material-symbols-outlined">play_arrow</span> Testar voz</button>' +
            '<button class="btn btn-outline" onclick="VoiceAlerts.previewCurrent()"><span class="material-symbols-outlined">campaign</span> Ouvir alertas atuais</button>' +
            '<button class="btn btn-outline" onclick="VoiceAlerts.previewDeficit()"><span class="material-symbols-outlined">trending_down</span> Ouvir déficit</button>' +
            '<button class="btn btn-ghost" onclick="VoiceAlerts.stop()"><span class="material-symbols-outlined">stop</span> Parar</button>' +
            '<button class="btn btn-ghost" onclick="VoiceAlerts.resetToday()"><span class="material-symbols-outlined">replay</span> Repetir alertas de hoje</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    var q = function(sel) { return Array.prototype.slice.call(m.querySelectorAll(sel)); };

    // --- Global (somente admin) ---
    if (editable) {
      $id('vzEnabled').addEventListener('change', function() {
        gcfg.enabled = this.checked; saveGlobal();
        if (gcfg.enabled) {
          say('Alertas por voz ativados para todos. Vou avisar sempre que alguma equipe precisar de atenção.');
          check(currentTeams(), lastPeriod);
        } else stop();
      });
      q('[data-rule]').forEach(function(el) {
        el.addEventListener('change', function() { gcfg.rules[el.getAttribute('data-rule')] = el.checked; saveGlobal(); });
      });
      q('[data-min]').forEach(function(el) {
        el.addEventListener('change', function() {
          var k = el.getAttribute('data-min');
          var v = Math.max(5, Math.min(600, parseInt(el.value, 10) || GLOBAL_DEFAULTS[k]));
          el.value = v; gcfg[k] = v; saveGlobal();
        });
      });
      q('[data-def]').forEach(function(el) {
        el.addEventListener('change', function() { gcfg.deficit[el.getAttribute('data-def')] = el.checked; saveGlobal(); });
      });
      q('[data-defmin]').forEach(function(el) {
        el.addEventListener('change', function() {
          var k = el.getAttribute('data-defmin');
          var v = Math.max(5, Math.min(600, parseInt(el.value, 10) || GLOBAL_DEFAULTS.deficit[k]));
          el.value = v; gcfg.deficit[k] = v; saveGlobal();
        });
      });
    } else {
      q('#vzGlobal input').forEach(function(el) { el.disabled = true; });
    }

    // --- Local (cada aparelho) ---
    $id('vzVoice').addEventListener('change', function() { lcfg.voiceURI = this.value; saveLocal(); });
    [['vzRate', 'rate', 'vzRateV', 'x'], ['vzPitch', 'pitch', 'vzPitchV', ''], ['vzVol', 'volume', 'vzVolV', '%']].forEach(function(s) {
      var el = $id(s[0]);
      var show = function() {
        var v = Number(el.value);
        $id(s[2]).textContent = s[3] === '%' ? '· ' + Math.round(v * 100) + '%' : '· ' + v.toFixed(2).replace('.', ',') + s[3];
      };
      show();
      el.addEventListener('input', function() { lcfg[s[1]] = Number(el.value); show(); });
      el.addEventListener('change', saveLocal);
    });
    $id('vzChime').addEventListener('change', function() { lcfg.chime = this.checked; saveLocal(); });
    $id('vzMuted').addEventListener('change', function() {
      lcfg.muted = this.checked; saveLocal(); updateButtons();
      if (lcfg.muted) stop();
    });
  }

  function open() {
    refreshGlobal().then(function() {
      buildModal();
      fillVoiceSelect();
      $id('voiceModal').style.display = 'flex';
    });
  }
  function close() {
    var m = $id('voiceModal');
    if (m) m.style.display = 'none';
  }
  function resetToday() {
    try { localStorage.removeItem(SPOKEN_KEY); localStorage.removeItem(DEFICIT_KEY); } catch (e) {}
    notify('Os alertas de hoje serão falados novamente na próxima atualização.', 'info');
  }
  function updateButtons() {
    var on = active();
    var btns = document.querySelectorAll('.vz-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('vz-on', on);
      btns[i].title = on ? 'Alertas por voz: ligados' : 'Alertas por voz: desligados';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateButtons);
  else updateButtons();

  window.VoiceAlerts = {
    check: check,
    test: test,
    previewCurrent: previewCurrent,
    previewDeficit: previewDeficit,
    stop: stop,
    say: say,
    open: open,
    close: close,
    resetToday: resetToday,
    isSupported: function() { return supported; }
  };
})();
