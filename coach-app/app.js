/*
 * DUABC coach app
 * ===============
 * One screen: QR scanner + name search + result screens.
 * Every action goes straight to the Google Apps Script API (no offline mode).
 *
 * Where the API address comes from (first match wins):
 *   1. the coach link's "#api=..." part (kept on the phone, never sent to GitHub)
 *   2. what this phone saved last time
 *   3. config.js (optional)
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Name search (pure function – also used by the automated tests)
  // ------------------------------------------------------------------

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[-'’.]/g, ' ').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Optimal string alignment distance (Levenshtein + adjacent swaps), for small typos.
  function osa(a, b) {
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[m][n];
  }

  // Score of one typed word against one name word (lower is better, Infinity = no match).
  function wordScore(q, t) {
    if (t.indexOf(q) === 0) return 0;                       // prefix match
    if (q.length < 3) return Infinity;                       // too short to guess typos
    var allowed = q.length >= 6 ? 2 : 1;
    var best = Infinity;
    [q.length - 1, q.length, q.length + 1].forEach(function (len) {
      if (len < 1 || len > t.length) return;
      best = Math.min(best, osa(q, t.slice(0, len)));
    });
    if (q.length >= t.length) best = Math.min(best, osa(q, t));
    return best <= allowed ? 1 + best : Infinity;
  }

  /**
   * Matches the start of the first name or surname (any word), case-insensitive,
   * tolerating a small typo. Each typed word must match a different name word.
   */
  function searchMembers(index, query, limit) {
    var qWords = norm(query).split(' ').filter(Boolean);
    if (!qWords.length) return [];
    var out = [];
    for (var i = 0; i < index.length; i++) {
      var m = index[i];
      var words = m._words || (m._words = norm(m.name).split(' ').filter(Boolean));
      var used = {}, total = 0, ok = true, firstHit = false;
      for (var k = 0; k < qWords.length; k++) {
        var best = Infinity, bestIdx = -1;
        for (var w = 0; w < words.length; w++) {
          if (used[w]) continue;
          var s = wordScore(qWords[k], words[w]);
          if (s < best) { best = s; bestIdx = w; }
        }
        if (best === Infinity) { ok = false; break; }
        used[bestIdx] = true;
        total += best;
        if (bestIdx === 0 && best === 0) firstHit = true;
      }
      if (ok) out.push({ m: m, score: total, first: firstHit });
    }
    out.sort(function (a, b) {
      return a.score - b.score || (b.first - a.first) || a.m.name.localeCompare(b.m.name);
    });
    return out.slice(0, limit || 6).map(function (x) { return x.m; });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { searchMembers: searchMembers, norm: norm };
    return;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  var LS = {
    get: function (k) { try { return localStorage.getItem('duabc_' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('duabc_' + k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem('duabc_' + k); } catch (e) { /* ignore */ } }
  };

  var S = {
    api: null,
    coach: LS.get('coach') || '',
    muted: LS.get('muted') === '1',
    boot: null,
    index: [],
    indexAt: 0,
    session: null,          // { name, manual, date }
    busy: false,
    overlay: null,          // 'flash' | 'sheet' | null
    lastCode: '',
    lastCodeAt: 0,
    scanner: null,
    scannerOn: false,
    scannerStarting: false,
    cardToken: 0,
    lastRefresh: 0
  };

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------

  function apiUrlFrom(value) {
    var v = String(value || '').trim();
    if (!v) return null;
    var hash = /#api=([^&\s]+)/.exec(v);
    if (hash) v = decodeURIComponent(hash[1]);
    if (/^https?:\/\//i.test(v)) {
      var id = /\/macros\/s\/([A-Za-z0-9_-]+)\/exec/.exec(v);
      if (id) return 'https://script.google.com/macros/s/' + id[1] + '/exec';
      return v;   // any other full URL (used by the local test server)
    }
    if (/^[A-Za-z0-9_-]{20,}$/.test(v)) return 'https://script.google.com/macros/s/' + v + '/exec';
    return null;
  }

  function resolveApi() {
    var fromHash = apiUrlFrom(location.hash);
    if (fromHash) { LS.set('api', fromHash); return fromHash; }
    var saved = LS.get('api');
    if (saved) return saved;
    var cfg = window.DUABC_CONFIG && window.DUABC_CONFIG.apiUrl;
    return apiUrlFrom(cfg);
  }

  function api(action, params) {
    var body = Object.assign({ action: action, coach: S.coach }, params || {});
    if (S.session && body.session === undefined) body.session = S.session.name;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    // text/plain keeps this a "simple" request: no CORS preflight. Apps Script answers
    // with a redirect to googleusercontent.com, which fetch follows automatically.
    return fetch(S.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { throw new Error('The server link looks wrong – ask the Treasurer for a new coach link.'); }
        if (!data.ok) throw new Error(data.error || 'Something went wrong');
        return data.result;
      });
    }, function (err) {
      throw new Error(err && err.name === 'AbortError' ? 'The server is taking too long – try again.' : 'No connection to the server – try again.');
    }).finally(function () { clearTimeout(timer); });
  }

  // ------------------------------------------------------------------
  // Feedback: sound + vibration
  // ------------------------------------------------------------------

  var audioCtx = null;
  function unlockAudio() {
    if (audioCtx || !(window.AudioContext || window.webkitAudioContext)) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
  }
  function tone(freq, start, dur, vol) {
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    var t = audioCtx.currentTime + start;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function feedback(kind) {
    if (navigator.vibrate) {
      try { navigator.vibrate(kind === 'success' ? 40 : kind === 'error' ? [70, 50, 70] : 25); } catch (e) { /* ignore */ }
    }
    if (S.muted || !audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (kind === 'success') { tone(880, 0, 0.12, 0.18); tone(1320, 0.09, 0.16, 0.16); }
      else if (kind === 'error') { tone(220, 0, 0.18, 0.22); tone(180, 0.16, 0.22, 0.2); }
      else { tone(660, 0, 0.1, 0.12); }
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Small UI helpers
  // ------------------------------------------------------------------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.hidden = true; }, 250);
    }, ms || 3500);
  }

  function pill(text) {
    if (text) { $('pillText').textContent = text; $('pill').hidden = false; }
    else $('pill').hidden = true;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(ymd) {
    if (!ymd) return '';
    var p = ymd.split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }
  function money(n) {
    n = Number(n) || 0;
    return '£' + (n % 1 ? n.toFixed(2) : String(n));
  }

  var CHIP = {
    'Plan active': 'chip-active',
    'PAYG': 'chip-payg',
    'Plan expired': 'chip-expired',
    'Not registered': 'chip-notreg'
  };
  function chip(status) { return el('span', 'chip ' + (CHIP[status] || 'chip-payg'), status); }

  // ------------------------------------------------------------------
  // Full-screen green / red
  // ------------------------------------------------------------------

  var flashTimer = null;
  var ICON_TICK = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="56" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="4"/><path class="draw" d="M36 62l16 16 33-36" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_CROSS = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="56" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="4"/><path d="M42 42l36 36M78 42l-36 36" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/></svg>';

  function showFlash(kind, title, detail, member) {
    closeSheet(true);
    var f = $('flash');
    f.className = 'flash ' + kind;
    $('flashIcon').innerHTML = kind === 'success' ? ICON_TICK : ICON_CROSS;
    $('flashTitle').textContent = title || '';
    $('flashDetail').textContent = detail || '';
    $('flashEcBox').hidden = true;
    $('flashEcBox').textContent = '';
    var ecBtn = $('flashEc');
    ecBtn.hidden = !member;
    ecBtn.onclick = member ? function (ev) {
      ev.stopPropagation();
      clearTimeout(flashTimer);               // stay open while reading the contact
      showEmergency(member, $('flashEcBox'), true);
    } : null;
    S.overlay = 'flash';
    requestAnimationFrame(function () { f.classList.add('show'); });
    feedback(kind === 'success' ? 'success' : 'error');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(hideFlash, kind === 'success' ? 1500 : 2500);
  }

  function hideFlash() {
    clearTimeout(flashTimer);
    var f = $('flash');
    f.classList.remove('show');
    if (S.overlay === 'flash') S.overlay = null;
  }

  // ------------------------------------------------------------------
  // Slide-up card
  // ------------------------------------------------------------------

  function openSheet(build, opts) {
    hideFlash();
    var body = $('sheetBody');
    body.innerHTML = '';
    build(body);
    var sheet = $('sheet');
    sheet.className = 'sheet' + (opts && opts.tone ? ' tone-' + opts.tone : '');
    S.overlay = 'sheet';
    $('backdrop').classList.add('show');
    requestAnimationFrame(function () { sheet.classList.add('show'); });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return ++S.cardToken;
  }

  function closeSheet(silent) {
    S.cardToken++;
    $('sheet').classList.remove('show');
    $('backdrop').classList.remove('show');
    if (S.overlay === 'sheet') S.overlay = null;
  }

  function personHeader(body, name, status, sub) {
    var head = el('div', 'card-head');
    var h = el('h2', 'card-title', name);
    h.id = 'sheetTitle';
    head.appendChild(h);
    if (status) head.appendChild(chip(status));
    body.appendChild(head);
    (sub || []).forEach(function (line, i) {
      if (line) body.appendChild(el('p', i === 0 ? 'card-sub' : 'card-sub2', line));
    });
  }

  function primaryBtn(label, onClick) {
    var b = el('button', 'btn-primary', label);
    b.type = 'button';
    b.onclick = function () { busyButton(b, onClick); };
    return b;
  }
  function textBtn(label, onClick, cls) {
    var b = el('button', 'btn-text' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.onclick = function () { busyButton(b, onClick); };
    return b;
  }
  function busyButton(b, fn) {
    if (b.disabled) return;
    var buttons = $('sheetBody').querySelectorAll('button');
    Array.prototype.forEach.call(buttons, function (x) { x.disabled = true; });
    b.classList.add('loading');
    Promise.resolve().then(fn).catch(function (err) {
      toast(err.message || String(err));
    }).then(function () {
      Array.prototype.forEach.call(buttons, function (x) { x.disabled = false; });
      b.classList.remove('loading');
    });
  }

  function ecLink(member, container) {
    var wrap = el('div', 'ec');
    var link = el('button', 'ec-link', 'Emergency contact');
    link.type = 'button';
    var box = el('div', 'ec-box');
    box.hidden = true;
    link.onclick = function () { showEmergency(member, box, false); };
    wrap.appendChild(link);
    wrap.appendChild(box);
    container.appendChild(wrap);
  }

  function showEmergency(member, box, onFlash) {
    box.hidden = false;
    box.textContent = '';
    if (!member.id || member.status === 'Not registered') {
      box.appendChild(el('p', 'ec-none', 'No emergency contact on file – ask them to register'));
      return;
    }
    box.appendChild(el('p', 'ec-loading', 'Loading…'));
    api('emergency', { memberId: member.id }).then(function (r) {
      box.textContent = '';
      if (!r.has) { box.appendChild(el('p', 'ec-none', 'No emergency contact on file – ask them to register')); return; }
      box.appendChild(el('p', 'ec-name', r.ecName + (r.ecRel ? ' (' + r.ecRel + ')' : '')));
      var call = el('a', onFlash ? 'ec-call ec-call-light' : 'ec-call', 'Call ' + r.ecPhone);
      call.href = 'tel:' + String(r.ecPhone).replace(/[^\d+]/g, '');
      box.appendChild(call);
    }).catch(function (err) {
      box.textContent = '';
      box.appendChild(el('p', 'ec-none', err.message));
    });
  }

  // ------------------------------------------------------------------
  // Results → screens
  // ------------------------------------------------------------------

  function render(r, ctx) {
    ctx = ctx || {};
    if (!r) return;
    if (r.kind === 'success') {
      if (r.created && r.member) addToIndex(r.member);
      clearSearch();
      showFlash('success', r.member.name, r.detail, r.member);
    } else if (r.kind === 'invalid') {
      showFlash('error', r.reason.indexOf('Invalid') === 0 ? 'Invalid code' : r.reason, r.reason.indexOf('Invalid') === 0 ? 'Search their name instead' : '', null);
    } else if (r.kind === 'duplicate') {
      showDuplicate(r);
    } else if (r.kind === 'decision') {
      showDecision(r.type, r.member, ctx.method || 'Manual');
    }
  }

  function showDuplicate(r) {
    openSheet(function (body) {
      body.appendChild(el('p', 'card-kicker', 'Already checked in'));
      personHeader(body, r.member.name, r.member.status, [
        'Checked in' + (r.time ? ' at ' + r.time : '') + (r.coach ? ' by ' + r.coach : '') + ' this session.'
      ]);
      ecLink(r.member, body);
      body.appendChild(primaryBtn('OK', function () { closeSheet(); }));
    }, { tone: 'amber' });
    feedback('decision');
  }

  function priceLine() {
    var p = S.boot && S.boot.paygPrice;
    return (p ? money(p) + ' – ' : '') + 'check their payment confirmation';
  }

  /**
   * type: 'payg' | 'expired' | 'notRegistered'
   * member: { id?, name, status, plan, expiry }  (no id = a new name typed by the coach)
   */
  function showDecision(type, member, method) {
    var token = openSheet(function (body) {
      var sub;
      if (type === 'expired') sub = ['Plan expired' + (member.expiry ? ' ' + shortDate(member.expiry) : ''), priceLine()];
      else if (type === 'notRegistered') sub = ['Ask them to fill in the membership form', priceLine()];
      else sub = [priceLine()];
      personHeader(body, member.name, member.id ? member.status : 'Not registered', sub);

      body.appendChild(primaryBtn('Seen payment – log PAYG', function () {
        var p = member.id ? { memberId: member.id, method: method } : { newName: member.name, method: 'Manual' };
        return api('logPayg', p).then(function (r) { render(r, { method: method }); });
      }));
      if (type !== 'notRegistered') {
        body.appendChild(textBtn("Says they've paid for a plan – let in", function () {
          return api('logPlanUnverified', { memberId: member.id, method: method }).then(function (r) { render(r); });
        }));
      }
      if (type === 'notRegistered' && S.boot && S.boot.formLink) {
        var formWrap = el('div', 'form-qr');
        var show = el('button', 'ec-link', 'Show form QR');
        show.type = 'button';
        show.onclick = function () {
          show.hidden = true;
          var img = el('img', 'form-qr-img');
          img.alt = 'Membership form QR code';
          img.src = 'https://quickchart.io/qr?size=240&margin=2&text=' + encodeURIComponent(S.boot.formLink);
          formWrap.appendChild(img);
          formWrap.appendChild(el('p', 'card-sub2', 'They scan this with their phone camera'));
        };
        formWrap.appendChild(show);
        body.appendChild(formWrap);
      }
      ecLink(member, body);
      body.appendChild(textBtn('Cancel', function () { closeSheet(); }, 'btn-cancel'));
    });
    feedback('decision');
    return token;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  function needSession() {
    if (S.session && S.session.name) return false;
    openSessionPicker();
    toast('Choose a session first');
    return true;
  }

  function onScan(text) {
    var code = String(text || '').trim();
    var now = Date.now();
    // Ignore repeat reads of the same code within 5 s of the last time it was seen.
    if (code === S.lastCode && now - S.lastCodeAt < 5000) { S.lastCodeAt = now; return; }
    S.lastCode = code; S.lastCodeAt = now;
    if (S.overlay || S.busy || !code) return;
    if (needSession()) return;
    S.busy = true;
    pill('Checking…');
    api('scan', { code: code }).then(function (r) {
      render(r, { method: 'QR' });
    }).catch(function (err) {
      toast(err.message);
    }).then(function () { S.busy = false; pill(null); S.lastCodeAt = Date.now(); });
  }

  function onPick(member) {
    if (S.busy) return;
    if (needSession()) return;
    $('search').blur();
    if (member.status === 'Plan active') {
      S.busy = true;
      pill('Checking…');
      api('select', { memberId: member.id }).then(function (r) { render(r); })
        .catch(function (err) { toast(err.message); })
        .then(function () { S.busy = false; pill(null); });
      return;
    }
    // Show the card straight away from the name index, and confirm with the server in
    // the background (this also catches "already checked in").
    var type = member.status === 'Not registered' ? 'notRegistered' : (member.status === 'Plan expired' ? 'expired' : 'payg');
    var token = showDecision(type, member, 'Manual');
    api('select', { memberId: member.id }).then(function (r) {
      if (S.cardToken !== token || S.overlay !== 'sheet') return;  // card already used or closed
      if (r.kind === 'decision' && r.type === type) return;         // as expected
      render(r);
    }).catch(function (err) {
      if (S.cardToken === token) toast(err.message);
    });
  }

  function onAddNew(name) {
    if (needSession()) return;
    $('search').blur();
    showDecision('notRegistered', { name: name, status: 'Not registered' }, 'Manual');
  }

  // ------------------------------------------------------------------
  // Name search UI
  // ------------------------------------------------------------------

  /** Cleans a typed name; Title-Cases it if it was typed all in lower case (same rule as the server). */
  function cleanTyped(s) {
    var t = String(s || '').replace(/[^\p{L}\p{M}' .\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t && t === t.toLowerCase()) t = t.replace(/(^|[\s\-'])(\p{L})/gu, function (m, a, b) { return a + b.toUpperCase(); });
    return t;
  }

  function renderResults() {
    var q = $('search').value;
    var list = $('results');
    list.innerHTML = '';
    $('clearSearch').hidden = !q;
    var typed = cleanTyped(q);
    if (!typed) return;
    var hits = searchMembers(S.index, typed, 6);
    hits.forEach(function (m) {
      var li = el('li');
      var b = el('button', 'result');
      b.type = 'button';
      b.appendChild(el('span', 'result-name', m.name));
      b.appendChild(chip(m.status));
      b.onclick = function () { onPick(m); };
      li.appendChild(b);
      list.appendChild(li);
    });
    // Offer "Add as PAYG" when nothing matches, or once a full name (two words) has been typed.
    if (typed.length >= 2 && (!hits.length || typed.indexOf(' ') > 0)) {
      var li2 = el('li');
      var add = el('button', 'result result-add');
      add.type = 'button';
      add.appendChild(el('span', 'result-name', 'Add “' + typed + '”'));
      add.appendChild(el('span', 'result-hint', 'as PAYG · not registered'));
      add.onclick = function () { onAddNew(typed); };
      li2.appendChild(add);
      list.appendChild(li2);
    }
  }

  function clearSearch() {
    $('search').value = '';
    renderResults();
    document.body.classList.remove('searching');
  }

  function addToIndex(m) {
    if (!S.index.some(function (x) { return x.id === m.id; })) S.index.push({ id: m.id, name: m.name, status: m.status, plan: m.plan, expiry: m.expiry });
  }

  function loadIndex() {
    return api('index').then(function (r) {
      S.index = r.members;
      S.indexAt = Date.now();
      $('indexState').textContent = '';
      renderResults();
    }).catch(function (err) {
      if (!S.index.length) $('indexState').textContent = 'Names not loaded – ' + err.message;
    });
  }

  // ------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------

  function applySession() {
    var b = S.boot;
    var saved = null;
    try { saved = JSON.parse(LS.get('session') || 'null'); } catch (e) { saved = null; }
    if (saved && saved.date === b.today && saved.manual) S.session = saved;
    else S.session = b.current ? { name: b.current, manual: false, date: b.today } : null;
    renderTopbar();
  }

  function setSession(name, manual) {
    S.session = name ? { name: name, manual: manual, date: S.boot.today } : null;
    if (manual) LS.set('session', JSON.stringify(S.session)); else LS.del('session');
    if (!manual) applySession();
    renderTopbar();
    loadIndex();
  }

  function renderTopbar() {
    $('sessionName').textContent = S.session ? S.session.name : 'Choose session';
    $('sessionName').classList.toggle('placeholder', !S.session);
    $('sessionDate').textContent = S.boot ? S.boot.todayLabel : '';
    $('coachName').textContent = S.coach;
    $('muteIcon').hidden = !S.muted;
    updateSessionMsg();
  }

  function openSessionPicker() {
    var b = S.boot || { sessions: [] };
    openSheet(function (body) {
      body.appendChild(el('p', 'card-kicker', b.todayLabel || 'Today'));
      var h = el('h2', 'card-title', 'Session');
      h.id = 'sheetTitle';
      body.appendChild(h);
      var list = el('div', 'option-list');
      var addOption = function (title, sub, selected, fn) {
        var o = el('button', 'option' + (selected ? ' selected' : ''));
        o.type = 'button';
        o.appendChild(el('span', 'option-title', title));
        if (sub) o.appendChild(el('span', 'option-sub', sub));
        o.onclick = fn;
        list.appendChild(o);
      };
      var cur = S.session ? S.session.name : '';
      (b.sessions || []).forEach(function (s) {
        addOption(s.name, s.start + '–' + s.end, cur === s.name && S.session.manual, function () { closeSheet(); setSession(s.name, true); });
      });
      if (!(b.sessions || []).length) list.appendChild(el('p', 'card-sub2', 'No sessions in the timetable today.'));
      addOption('Automatic', b.current ? 'Now: ' + b.current : 'Picks the session from the timetable', S.session && !S.session.manual, function () {
        closeSheet(); setSession(null, false);
      });
      body.appendChild(list);

      var adhoc = el('form', 'adhoc');
      var inp = el('input', 'field');
      inp.placeholder = 'Ad-hoc session name';
      inp.maxLength = 40;
      inp.autocapitalize = 'words';
      var go = el('button', 'btn-secondary', 'Use');
      go.type = 'submit';
      adhoc.appendChild(inp); adhoc.appendChild(go);
      adhoc.onsubmit = function (e) {
        e.preventDefault();
        var n = cleanTyped(inp.value);
        if (!n) { inp.focus(); return; }
        closeSheet(); setSession(n, true);
      };
      body.appendChild(adhoc);
      body.appendChild(textBtn('Cancel', function () { closeSheet(); }, 'btn-cancel'));
    });
  }

  function openCoachMenu() {
    openSheet(function (body) {
      body.appendChild(el('p', 'card-kicker', 'Signed in on this phone as'));
      var h = el('h2', 'card-title', S.coach);
      h.id = 'sheetTitle';
      body.appendChild(h);
      var list = el('div', 'option-list');
      var sound = el('button', 'option');
      sound.type = 'button';
      sound.appendChild(el('span', 'option-title', 'Sound'));
      sound.appendChild(el('span', 'option-sub', S.muted ? 'Off' : 'On'));
      sound.onclick = function () {
        S.muted = !S.muted;
        LS.set('muted', S.muted ? '1' : '0');
        sound.lastChild.textContent = S.muted ? 'Off' : 'On';
        renderTopbar();
        if (!S.muted) { unlockAudio(); feedback('success'); }
      };
      list.appendChild(sound);
      var refresh = el('button', 'option');
      refresh.type = 'button';
      refresh.appendChild(el('span', 'option-title', 'Refresh names'));
      refresh.appendChild(el('span', 'option-sub', S.index.length + ' names'));
      refresh.onclick = function () { closeSheet(); refreshAll(true).then(function () { toast('Names refreshed'); }); };
      list.appendChild(refresh);
      body.appendChild(list);
      body.appendChild(primaryBtn('Switch coach', function () { closeSheet(); logOut(); }));
      body.appendChild(textBtn('Cancel', function () { closeSheet(); }, 'btn-cancel'));
      body.appendChild(el('p', 'version', 'DUABC coach app' + (S.boot && S.boot.version ? ' · v' + S.boot.version : '')));
    });
  }

  function logOut() {
    S.coach = '';
    LS.del('coach');
    S.index = [];              // name index is cleared on log out
    clearSearch();
    stopScanner();
    showNamePanel();
  }

  // ------------------------------------------------------------------
  // Scanner (html5-qrcode)
  // ------------------------------------------------------------------

  var msgKind = null;
  function scannerMsg(text, onTap, kind) {
    var b = $('scannerMsg');
    msgKind = text ? (kind || 'camera') : null;
    if (!text) { b.hidden = true; b.onclick = null; return; }
    b.textContent = text;
    b.hidden = false;
    b.onclick = onTap || null;
  }

  /** While no session is chosen, the scanner shows a "tap to choose" message. */
  function updateSessionMsg() {
    if (!S.session && S.boot) {
      if (!msgKind || msgKind === 'session') scannerMsg('No session right now – tap to choose', openSessionPicker, 'session');
    } else if (msgKind === 'session') {
      scannerMsg(null);
    }
  }

  function waitForLibrary(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function check() {
        if (window.Html5Qrcode) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(check, 100);
      })();
    });
  }

  function startScanner() {
    if (S.scannerOn || S.scannerStarting || document.hidden || !S.coach) return Promise.resolve();
    S.scannerStarting = true;
    scannerMsg(null);
    return waitForLibrary(8000).then(function (ok) {
      if (!ok) { scannerMsg('Scanner unavailable – use name search'); return; }
      if (!S.scanner) {
        S.scanner = new window.Html5Qrcode('reader', {
          verbose: false,
          formatsToSupport: [window.Html5QrcodeSupportedFormats.QR_CODE],
          experimentalFeatures: { useBarCodeDetectorIfSupported: true }
        });
      }
      return S.scanner.start({ facingMode: 'environment' }, { fps: 12, disableFlip: true }, onScan, function () {})
        .then(function () { S.scannerOn = true; updateSessionMsg(); });
    }).catch(function (err) {
      var msg = String(err && (err.name || err.message || err));
      scannerMsg(/NotAllowed|Permission/i.test(msg) ? 'Camera blocked – allow camera access, then tap here' : 'Camera not available – tap to try again', function () {
        startScanner();
      });
    }).then(function () { S.scannerStarting = false; });
  }

  function stopScanner() {
    if (!S.scanner || !S.scannerOn) return Promise.resolve();
    S.scannerOn = false;
    return S.scanner.stop().catch(function () { /* already stopped */ });
  }

  // ------------------------------------------------------------------
  // Start-up
  // ------------------------------------------------------------------

  function show(id) {
    ['app', 'setupPanel', 'namePanel'].forEach(function (x) { $(x).hidden = x !== id; });
  }

  function showSetupPanel(err) {
    show('setupPanel');
    $('setupError').hidden = !err;
    $('setupError').textContent = err || '';
  }

  function showNamePanel() {
    show('namePanel');
    var list = $('coachList');
    list.innerHTML = '';
    ((S.boot && S.boot.coaches) || []).forEach(function (c) { var o = el('option'); o.value = c; list.appendChild(o); });
    setTimeout(function () { $('nameInput').focus(); }, 50);
  }

  function refreshAll(force) {
    if (!force && Date.now() - S.lastRefresh < 30000) return Promise.resolve();
    S.lastRefresh = Date.now();
    return api('bootstrap').then(function (b) {
      var prevToday = S.boot && S.boot.today;
      S.boot = b;
      if (!S.session || !S.session.manual || prevToday !== b.today) applySession(); else renderTopbar();
      return loadIndex();
    }).catch(function (err) { toast(err.message); });
  }

  function enterApp() {
    show('app');
    renderTopbar();
    loadIndex();
    startScanner();
  }

  function boot() {
    S.api = resolveApi();
    if (!S.api) { showSetupPanel(); return; }
    api('bootstrap').then(function (b) {
      S.boot = b;
      S.lastRefresh = Date.now();
      applySession();
      if (!S.coach) showNamePanel();
      else enterApp();
    }).catch(function (err) {
      showSetupPanel(err.message);
    });
  }

  function wire() {
    document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    document.addEventListener('click', unlockAudio, { once: true });

    $('setupForm').onsubmit = function (e) {
      e.preventDefault();
      var url = apiUrlFrom($('setupInput').value);
      if (!url) { showSetupPanel('That doesn’t look like the coach link. Copy the whole link from the message.'); return; }
      LS.set('api', url);
      boot();
    };
    $('pasteBtn').onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { $('setupInput').focus(); return; }
      navigator.clipboard.readText().then(function (t) { $('setupInput').value = t; }).catch(function () { $('setupInput').focus(); });
    };

    $('nameForm').onsubmit = function (e) {
      e.preventDefault();
      var name = cleanTyped($('nameInput').value);
      if (name.length < 2) return;
      var btn = $('nameSubmit');
      btn.disabled = true;
      S.coach = name;
      api('setCoach').then(function (r) {
        S.coach = r.coach;
        LS.set('coach', S.coach);
        $('nameError').hidden = true;
        enterApp();
      }).catch(function (err) {
        S.coach = '';
        $('nameError').textContent = err.message;
        $('nameError').hidden = false;
      }).then(function () { btn.disabled = false; });
    };

    $('search').addEventListener('input', renderResults);
    $('search').addEventListener('focus', function () { document.body.classList.add('searching'); });
    $('search').addEventListener('blur', function () {
      setTimeout(function () { if (!$('search').value) document.body.classList.remove('searching'); }, 150);
    });
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = $('results').querySelector('button');
        if (first) first.click();
      }
    });
    $('clearSearch').onclick = function () { clearSearch(); $('search').focus(); };

    $('sessionBtn').onclick = openSessionPicker;
    $('coachBtn').onclick = openCoachMenu;
    $('backdrop').onclick = function () { closeSheet(); };
    $('flash').onclick = hideFlash;

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopScanner(); return; }
      if (S.coach && S.api && !$('app').hidden) { refreshAll(false); startScanner(); }
    });
    setInterval(function () {
      if (!document.hidden && S.coach && S.api && !$('app').hidden) refreshAll(true);
    }, 5 * 60 * 1000);

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* install-only helper */ });
    }
  }

  // Exposed for the automated end-to-end test only.
  window.__duabc = { state: S, onScan: onScan };

  wire();
  boot();
})();
