/* Family Watch List - TV-friendly, parent-approved kids media launcher.
   Plain ES5 + Promises for older smart-TV browsers. */
(function () {
  'use strict';
  var LS = window.localStorage;
  var K = { hash: 'fwl.pinHash', salt: 'fwl.pinSalt', topic: 'fwl.ntfyTopic', lock: 'fwl.lockUntil' };
  var NTFY = 'https://ntfy.sh';
  var $ = function (id) { return document.getElementById(id); };
  var stack = [];          // open overlay screen ids
  var lastHomeFocus = null;
  var current = null;      // title being requested
  var pending = null;      // {id, es, pollTimer, done}
  var failCount = 0;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function randStr(n) {
    var abc = 'abcdefghijkmnpqrstuvwxyz23456789', out = '', a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) out += abc[a[i] % abc.length];
    return out;
  }
  function sha256Hex(str) {
    var c = window.crypto;
    if (c && c.subtle && window.TextEncoder) {
      return c.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }).catch(function () { return window.sha256HexFallback(str); });
    }
    return Promise.resolve(window.sha256HexFallback(str));
  }
  function hasPin() { return !!LS.getItem(K.hash); }
  function setPin(pin) {
    var salt = randStr(16);
    return sha256Hex(salt + ':' + pin).then(function (h) { LS.setItem(K.salt, salt); LS.setItem(K.hash, h); });
  }
  function checkPin(pin) {
    return sha256Hex((LS.getItem(K.salt) || '') + ':' + pin).then(function (h) { return h === LS.getItem(K.hash); });
  }
  function topic() { return LS.getItem(K.topic) || ''; }

  /* ---------- Screens & focus ---------- */
  function open(id, focusSel) {
    if (stack[stack.length - 1] !== id) { stack.push(id); }
    if (stack.length === 1 && document.activeElement && $('home').contains(document.activeElement)) lastHomeFocus = document.activeElement;
    ['ask', 'pinScreen', 'settings', 'player'].forEach(function (s) { $(s).hidden = s !== id; });
    $('home').setAttribute('aria-hidden', 'true');
    focusFirst(focusSel);
  }
  function closeTop() {
    var id = stack.pop();
    if (id === 'ask') cancelPending();
    if (id === 'player') $('frameWrap').innerHTML = '';
    var next = stack[stack.length - 1];
    ['ask', 'pinScreen', 'settings', 'player'].forEach(function (s) { $(s).hidden = s !== next; });
    if (!next) { $('home').removeAttribute('aria-hidden'); var lf = lastHomeFocus && document.body.contains(lastHomeFocus) ? lastHomeFocus : document.querySelector('.tile'); lf.focus(); }
    else focusFirst();
  }
  function closeAll() { while (stack.length) closeTop(); }
  function activeRoot() { return stack.length ? $(stack[stack.length - 1]) : $('home'); }
  function focusables() {
    return Array.prototype.filter.call(activeRoot().querySelectorAll('.f, .tile, .pad button'), function (e) {
      return !e.disabled && e.offsetParent !== null;
    });
  }
  function focusFirst(sel) {
    setTimeout(function () {
      var t = sel ? activeRoot().querySelector(sel) : null;
      (t || focusables()[0] || document.body).focus();
    }, 30);
  }
  function move(dir) {
    var list = focusables(), cur = document.activeElement;
    if (list.indexOf(cur) < 0) { if (list[0]) list[0].focus(); return; }
    var a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bestScore = Infinity;
    list.forEach(function (e) {
      if (e === cur) return;
      var b = e.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2, dx = bx - ax, dy = by - ay, main, cross;
      if (dir === 'left') { if (b.right > a.left + 2 && bx >= ax) return; main = -dx; cross = Math.abs(dy); }
      if (dir === 'right') { if (b.left < a.right - 2 && bx <= ax) return; main = dx; cross = Math.abs(dy); }
      if (dir === 'up') { if (b.bottom > a.top + 2 && by >= ay) return; main = -dy; cross = Math.abs(dx); }
      if (dir === 'down') { if (b.top < a.bottom - 2 && by <= ay) return; main = dy; cross = Math.abs(dx); }
      if (main <= 0) return;
      var score = main + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) { best.focus(); }
  }
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (t && !stack.length && (t.id === 'settingsBtn' || (t.closest && t.closest('.section') === document.querySelector('.section')))) { window.scrollTo(0, 0); return; }
    if (t && t.scrollIntoView && !stack.length) {
      try { t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (x) { t.scrollIntoView(false); }
    }
  });

  var BACK_KEYS = { 27: 1, 461: 1, 10009: 1, 166: 1, 196: 1 }; // Esc, webOS, Tizen, generic Back
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode, tag = (document.activeElement || {}).tagName;
    var typing = tag === 'INPUT';
    if (stack[stack.length - 1] === 'pinScreen' && !typing) {
      if (k >= 48 && k <= 57) { pinPress(String(k - 48)); e.preventDefault(); return; }
      if (k >= 96 && k <= 105) { pinPress(String(k - 96)); e.preventDefault(); return; }
      if (k === 8) { if (pin.value.length) pinPress('del'); else if (hasPin()) closeTop(); e.preventDefault(); return; }
    }
    if (k === 37 && !typing) { move('left'); e.preventDefault(); }
    else if (k === 38) { move('up'); e.preventDefault(); }
    else if (k === 39 && !typing) { move('right'); e.preventDefault(); }
    else if (k === 40) { move('down'); e.preventDefault(); }
    else if (BACK_KEYS[k] || (k === 8 && !typing)) {
      if (stack.length && !(stack[0] === 'pinScreen' && !hasPin()) && !(pin.mode === 'setup' || pin.mode === 'setup2')) { closeTop(); e.preventDefault(); }
    }
  });

  /* ---------- Home grid ---------- */
  function renderHome() {
    var root = $('sections');
    window.SECTIONS.forEach(function (s) {
      var grid = el('div', { 'class': 'grid' });
      window.TITLES.filter(function (t) { return t.section === s.id; }).forEach(function (t) {
        var badges = el('div', { 'class': 'badges' });
        if (t.embed) badges.appendChild(el('span', { 'class': 'badge play', text: '▶ Plays here' }));
        t.links.forEach(function (l) { badges.appendChild(el('span', { 'class': 'badge', text: l.name })); });
        grid.appendChild(el('button', { 'class': 'tile', 'data-id': t.id, 'aria-label': t.title + (t.year ? ', ' + t.year : '') + ', ages ' + t.age, onclick: function () { askFor(t); } }, [
          el('img', { src: t.poster, alt: '', loading: 'lazy' }),
          el('div', { 'class': 'info' }, [
            el('div', { 'class': 't', text: t.title }),
            el('div', { 'class': 'y' }, [t.year || 'TV series', el('span', { 'class': 'age', text: 'Ages ' + t.age })]),
            el('div', { 'class': 'why', text: t.why }),
            badges
          ])
        ]));
      });
      root.appendChild(el('section', { 'class': 'section' }, [el('h2', { text: s.name }), grid]));
    });
  }

  /* ---------- Ask a grown-up ---------- */
  function askFor(t) {
    current = t;
    $('askPoster').src = t.poster;
    $('askTitle').textContent = t.title;
    $('askMeta').textContent = [t.year, 'Ages ' + t.age].filter(Boolean).join(' · ');
    showAsk();
    open('ask');
  }
  function showAsk() {
    var st = $('askState'), bt = $('askButtons');
    st.innerHTML = ''; bt.innerHTML = '';
    st.appendChild(el('p', { 'class': 'bigmsg', text: 'Ask a grown-up! 🙋' }));
    st.appendChild(el('p', { 'class': 'note', text: 'A grown-up needs to say yes before this opens.' }));
    bt.appendChild(el('button', { 'class': 'f btn primary', id: 'btnPin', text: '🔢 Grown-up: enter PIN', onclick: function () {
      askPin('Grown-up PIN', 'Enter your PIN to say yes to "' + current.title + '".', function () { approved('pin'); });
    } }));
    if (topic()) bt.appendChild(el('button', { 'class': 'f btn', id: 'btnPhone', text: '📱 Ask on grown-up\'s phone', onclick: requestPhone }));
    bt.appendChild(el('button', { 'class': 'f btn ghost', text: '← Go back', onclick: closeTop }));
  }
  function approved(how) {
    cancelPending();
    var t = current, st = $('askState'), bt = $('askButtons');
    // PIN screen may be on top; make sure "ask" is the visible top screen
    while (stack.length && stack[stack.length - 1] !== 'ask') stack.pop();
    ['ask', 'pinScreen', 'settings', 'player'].forEach(function (s) { $(s).hidden = s !== 'ask'; });
    st.innerHTML = ''; bt.innerHTML = '';
    st.appendChild(el('p', { 'class': 'bigmsg good', text: 'Yes! Enjoy the show 🎉' }));
    st.appendChild(el('p', { 'class': 'note', html: 'Pick where to watch. When you are done, press the TV remote\'s <b>Back</b> button to come back here.' }));
    if (t.embed) bt.appendChild(el('button', { 'class': 'f btn svc playhere', text: '▶ Play here', onclick: function () { play(t); } }));
    t.links.forEach(function (l) {
      bt.appendChild(el('a', { 'class': 'f btn svc', href: l.url, rel: 'noopener', text: l.name + (l.fallback ? ' (via JustWatch)' : '') }));
    });
    bt.appendChild(el('button', { 'class': 'f btn ghost', text: '← Back', onclick: closeTop }));
    bt.className = 'btnrow wrap';
    focusFirst();
  }
  function denied() {
    cancelPending();
    var st = $('askState'), bt = $('askButtons');
    st.innerHTML = ''; bt.innerHTML = '';
    st.appendChild(el('p', { 'class': 'bigmsg bad', text: 'Not this time 💛' }));
    st.appendChild(el('p', { 'class': 'note', text: 'That\'s okay! Let\'s pick something else together.' }));
    bt.appendChild(el('button', { 'class': 'f btn primary', text: '← Pick something else', onclick: closeTop }));
    focusFirst();
  }

  /* ---------- Phone approval via ntfy.sh ---------- */
  function requestPhone() {
    var tp = topic(); if (!tp) return;
    cancelPending();
    var id = randStr(12), since = Math.floor(Date.now() / 1000) - 5;
    var p = pending = { id: id, done: false };
    var st = $('askState'), bt = $('askButtons');
    st.innerHTML = ''; bt.innerHTML = '';
    st.appendChild(el('p', { 'class': 'bigmsg' }, [el('span', { 'class': 'spinner' }), 'Asking your grown-up…']));
    st.appendChild(el('p', { 'class': 'note', text: 'A message was sent to their phone. Waiting for Approve or Deny.' }));
    bt.appendChild(el('button', { 'class': 'f btn primary', text: '🔢 Grown-up: enter PIN instead', onclick: function () {
      askPin('Grown-up PIN', 'Enter your PIN to say yes to "' + current.title + '".', function () { approved('pin'); });
    } }));
    bt.appendChild(el('button', { 'class': 'f btn ghost', text: 'Cancel', onclick: function () { cancelPending(); showAsk(); focusFirst(); } }));
    focusFirst();

    function handle(msgText) {
      if (p.done || !msgText) return;
      msgText = String(msgText).trim();
      if (msgText === 'approve:' + id) { p.done = true; approved('phone'); }
      else if (msgText === 'deny:' + id) { p.done = true; denied(); }
    }
    function onData(raw) {
      try { var d = JSON.parse(raw); if (d.event === 'message') handle(d.message); } catch (x) {}
    }
    var replyUrl = NTFY + '/' + encodeURIComponent(tp + '-reply');
    function startPoll() {
      if (p.pollTimer || p.done) return;
      p.pollTimer = setInterval(function () {
        if (p.done) return clearInterval(p.pollTimer);
        fetch(replyUrl + '/json?poll=1&since=' + since).then(function (r) { return r.text(); }).then(function (txt) {
          txt.split('\n').forEach(function (line) { if (line) onData(line); });
        }).catch(function () {});
      }, 3000);
    }
    if (window.EventSource) {
      try {
        p.es = new EventSource(replyUrl + '/sse?since=' + since);
        p.es.onmessage = function (ev) { onData(ev.data); };
        p.es.onerror = function () { startPoll(); };
      } catch (x) { startPoll(); }
    } else startPoll();

    var t = current;
    var body = {
      topic: tp,
      title: 'Request: ' + t.title,
      message: 'Your kid wants to watch "' + t.title + '"' + (t.year ? ' (' + t.year + ')' : '') + ', ages ' + t.age + '. Tap Approve or Deny.',
      tags: ['tv'],
      priority: 4,
      actions: [
        { action: 'http', label: 'Approve', url: replyUrl, method: 'POST', body: 'approve:' + id, clear: true },
        { action: 'http', label: 'Deny', url: replyUrl, method: 'POST', body: 'deny:' + id, clear: true }
      ]
    };
    // JSON publish goes to the ntfy root URL (no Content-Type header keeps it a CORS "simple" request)
    fetch(NTFY + '/', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }).catch(function (err) {
      if (p.done) return;
      st.querySelector('.note').textContent = 'Could not reach the phone service (' + err.message + '). Ask a grown-up to use the PIN.';
    });
  }
  function cancelPending() {
    if (!pending) return;
    pending.done = true;
    if (pending.es) try { pending.es.close(); } catch (x) {}
    if (pending.pollTimer) clearInterval(pending.pollTimer);
    pending = null;
  }

  /* ---------- PIN pad ---------- */
  var pin = { value: '', mode: '', cb: null, first: '' };
  function buildPad() {
    var pad = $('pad');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].forEach(function (k) {
      pad.appendChild(el('button', { 'class': k === 'ok' ? 'ok' : k === 'del' ? 'del' : '', 'data-k': k, 'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'OK' : k,
        text: k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k, onclick: function () { pinPress(k); } }));
    });
    $('pinCancel').addEventListener('click', function () { if (hasPin()) closeTop(); });
  }
  function drawDots() {
    var d = $('pinDots'); d.innerHTML = '';
    var n = Math.max(4, pin.value.length);
    for (var i = 0; i < n; i++) d.appendChild(el('span', { 'class': i < pin.value.length ? 'on' : '' }));
  }
  function showPin(mode, title, help, cb) {
    pin.value = ''; pin.mode = mode; pin.cb = cb;
    $('pinTitle').textContent = title; $('pinHelp').textContent = help;
    $('pinMsg').textContent = ''; $('pinMsg').className = 'msg';
    $('pinCancel').hidden = !hasPin();
    drawDots();
    open('pinScreen', '.pad button[data-k="1"]');
  }
  function askPin(title, help, onOk) { showPin('verify', title, help, onOk); }
  function pinMsg(t, ok) { $('pinMsg').textContent = t; $('pinMsg').className = 'msg' + (ok ? ' ok' : ''); }
  function pinPress(k) {
    if (k === 'del') { pin.value = pin.value.slice(0, -1); drawDots(); return; }
    if (k !== 'ok') { if (pin.value.length < 6) pin.value += k; drawDots(); if (!(pin.mode === 'verify' && pin.value.length === 6)) return; }
    // OK pressed (or 6 digits reached in verify mode)
    var v = pin.value;
    if (v.length < 4) { pinMsg('Use 4 to 6 digits.'); return; }
    if (pin.mode === 'setup' || pin.mode === 'change') {
      pin.first = v; pin.value = ''; drawDots();
      pin.mode = pin.mode === 'setup' ? 'setup2' : 'change2';
      $('pinTitle').textContent = 'Type the same PIN again'; pinMsg('', true);
      return;
    }
    if (pin.mode === 'setup2' || pin.mode === 'change2') {
      if (v !== pin.first) { pin.mode = pin.mode === 'setup2' ? 'setup' : 'change'; pin.value = ''; drawDots(); $('pinTitle').textContent = 'Create a parent PIN'; pinMsg('Those didn\'t match. Try again.'); return; }
      var cb = pin.cb;
      setPin(v).then(function () { pin.value = ''; cb && cb(); });
      return;
    }
    // verify
    var lockUntil = +LS.getItem(K.lock) || 0;
    if (Date.now() < lockUntil) { pin.value = ''; drawDots(); pinMsg('Too many tries. Wait ' + Math.ceil((lockUntil - Date.now()) / 1000) + ' seconds.'); return; }
    checkPin(v).then(function (ok) {
      pin.value = ''; drawDots();
      if (ok) { failCount = 0; var cb2 = pin.cb; pin.cb = null; cb2 && cb2(); }
      else {
        failCount++;
        if (failCount >= 5) { failCount = 0; LS.setItem(K.lock, String(Date.now() + 60000)); pinMsg('Too many tries. Locked for 60 seconds.'); }
        else pinMsg('That PIN is not right.');
      }
    });
  }

  /* ---------- Settings / setup ---------- */
  function renderQR(text) {
    var box = $('qr'); box.innerHTML = '';
    if (!text) { box.appendChild(el('p', { text: 'Phone approval is off', style: 'color:#10213a;text-align:center' })); return; }
    try { var q = window.qrcode(0, 'M'); q.addData(text); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
    catch (x) { box.appendChild(el('p', { text: text, style: 'color:#10213a' })); }
  }
  function refreshSettings() {
    var tp = topic();
    $('topicBig').textContent = tp || '(off)';
    $('topicInput').value = tp;
    renderQR(tp ? NTFY + '/' + tp : '');
  }
  function setMsg(t, ok) { $('setMsg').textContent = t; $('setMsg').className = 'msg' + (ok ? ' ok' : ''); }
  function openSettings(first) {
    $('setTitle').textContent = first ? 'Almost done: set up phone approval (optional)' : 'Parent settings';
    setMsg(first ? 'PIN saved! You can also approve from your phone.' : '', true);
    refreshSettings();
    open('settings', '#setDone');
  }
  function bindSettings() {
    $('settingsBtn').addEventListener('click', function () {
      askPin('Parent settings', 'Enter your parent PIN.', function () { stack.pop(); openSettings(false); });
    });
    $('saveTopic').addEventListener('click', function () {
      var v = $('topicInput').value.trim();
      if (!/^[A-Za-z0-9_-]{12,64}$/.test(v)) { setMsg('Topic must be 12-64 letters, numbers, - or _ (long = harder to guess).'); return; }
      LS.setItem(K.topic, v); refreshSettings(); setMsg('Topic saved.', true);
    });
    $('newTopic').addEventListener('click', function () { LS.setItem(K.topic, 'fwl-' + randStr(20)); refreshSettings(); setMsg('New topic made. Subscribe to it in the ntfy app.', true); });
    $('offTopic').addEventListener('click', function () { LS.removeItem(K.topic); refreshSettings(); setMsg('Phone approval is off. The PIN still works.', true); });
    $('testNtfy').addEventListener('click', function () {
      var tp = topic(); if (!tp) { setMsg('Turn on phone approval first (New random topic).'); return; }
      fetch(NTFY + '/', { method: 'POST', body: JSON.stringify({ topic: tp, title: 'Family Watch List', message: 'Test: phone approval is working. 👍', tags: ['tv'] }) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); setMsg('Test sent! Check your phone.', true); })
        .catch(function (e) { setMsg('Could not send (' + e.message + ').'); });
    });
    $('changePin').addEventListener('click', function () {
      showPin('change', 'Create a new PIN', '4 to 6 digits.', function () { stack.pop(); openSettings(false); setMsg('PIN changed.', true); });
    });
    $('setDone').addEventListener('click', function () { closeAll(); });
  }

  /* ---------- Player (official YouTube embeds only) ---------- */
  function play(t) {
    $('playerTitle').textContent = t.title + ' — YouTube (' + t.embed.channel + ')';
    var src = 'https://www.youtube.com/embed/' + t.embed.youtubeId + '?autoplay=1&rel=0&playsinline=1&origin=' + encodeURIComponent(location.origin);
    $('frameWrap').innerHTML = '';
    $('frameWrap').appendChild(el('iframe', { src: src, title: t.title, allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture', allowfullscreen: '' }));
    open('player', '#fsBtn');
  }
  function bindPlayer() {
    $('closePlayer').addEventListener('click', closeTop);
    $('fsBtn').addEventListener('click', function () {
      var f = $('frameWrap').querySelector('iframe'); if (!f) return;
      var fn = f.requestFullscreen || f.webkitRequestFullscreen || f.msRequestFullscreen;
      if (fn) fn.call(f); else toast('Full screen is not supported on this TV browser.');
    });
  }

  /* ---------- Boot ---------- */
  renderHome(); buildPad(); bindSettings(); bindPlayer();
  if (!hasPin()) {
    showPin('setup', 'Create a parent PIN', 'Welcome! Grown-ups: pick a 4-6 digit PIN. Kids will need you to enter it before anything opens.', function () {
      if (!topic()) LS.setItem(K.topic, 'fwl-' + randStr(20));
      stack.pop(); openSettings(true);
    });
  } else {
    setTimeout(function () { var t = document.querySelector('.tile'); t && t.focus(); }, 50);
  }
  window.__fwl = { move: move }; // for testing
})();
