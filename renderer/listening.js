// The full-size player and the compact footer share one audio element and one slider.
let selectionVersion = 0;
let sourceReady = false;
let startedListening = false;
let bufferedResume = null;
let historyFilter = 'all';
let lastTick = 0;
let lastHistoryPaint = 0;
let historyLoad = 0;

function listeningOwner() {
  const user = state.auth?.user;
  return String(user?.uid || user?.id || user?.userId || '');
}
function icon(name) {
  return '<svg aria-hidden="true"><use href="symbols.svg#' + name + '"/></svg>';
}
function paintCover(node, url, label) {
  node.replaceChildren();
  if (!url) { node.innerHTML = icon('orbit'); return; }
  const img = document.createElement('img');
  img.alt = label || '';
  img.addEventListener('error', () => { if (img.parentNode === node) node.innerHTML = icon('orbit'); }, { once: true });
  img.src = url;
  node.append(img);
}
function mountListeningLayout(home, history) {
  document.body.classList.toggle('listening-layout', home);
  $('#listening-page').hidden = !home;
  $('#history-page').hidden = !history;
  $('#page-content').hidden = home || history;
  if (home || history) $('#page-content').replaceChildren();
  const parent = $(home ? '#home-player-slot' : '#mini-player-slot');
  const player = $('.player-bar');
  if (player.parentNode !== parent) {
    for (const menu of $$('details[open]', player)) menu.open = false;
    parent.append(player);
  }
  if (home || history) {
    const slot = $(history ? '#history-page' : '#home-history-slot');
    const panel = $('#history-panel');
    if (panel.parentNode !== slot) slot.append(panel);
    panel.setAttribute('aria-labelledby', history ? 'route-title' : 'history-heading');
    $('.history-filters').hidden = !history;
    $('.history-heading').hidden = history;
    renderListeningHistory();
  }
  $('#player-cover').title = home ? '查看单集详情' : '打开收听页';
  $('#player-cover').setAttribute('aria-label', $('#player-cover').title);
  if (home) requestAnimationFrame(drawWaveform);
}
function syncPlaybackButtons() {
  const audio = $('#audio');
  const play = $('#play-button');
  const paused = audio.paused || audio.ended;
  const label = paused ? '播放' : '暂停';
  play.title = label;
  play.setAttribute('aria-label', label);
  play.querySelector('use').setAttribute('href', 'symbols.svg#' + (paused ? 'play' : 'pause'));
  $('#skip-back').disabled = !state.current;
  $('#skip-forward').disabled = !state.current;
  $('#episode-notes-button').disabled = !state.current;
  document.body.classList.toggle('player-empty', !state.current);
  play.disabled = !state.current;
  $('#player-title').disabled = !state.current;
  $('#player-cover').disabled = !state.current;
  $('#player-state').textContent = !state.current ? '尚未播放' : audio.ended ? '已听完' : paused ? '继续收听' : '正在播放';
  $('.player-bar').classList.toggle('is-playing', !paused);
  syncLibraryPlayButtons();
}
function historyTime(record) {
  if (record.completed) return '已听完';
  return record.duration ? formatTime(record.currentTime) + ' / ' + formatTime(record.duration) : formatTime(record.currentTime);
}
function renderListeningHistory() {
  const holder = $('#history-list');
  if (!holder) return;
  for (const button of $$('[data-history-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.historyFilter === historyFilter));
  }
  const home = document.body.classList.contains('listening-layout');
  const all = state.listeningHistory;
  const filtered = home ? all.slice(0, 3) : all.filter(record => historyFilter === 'all' || record.completed === (historyFilter === 'completed'));
  if (!home && !$('#history-page').hidden) $('#route-meta').textContent = all.length + ' 集';
  const focused = holder.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest('[data-history-eid]')?.dataset.historyEid;
  const focusedAction = focused?.dataset.historyAction;
  holder.replaceChildren();
  if (!filtered.length) {
    const text = !state.auth ? '登录后可以在这里找到听过的单集' : !all.length ? '听过的单集和进度会显示在这里'
      : historyFilter === 'completed' ? '还没有已听完的单集' : '所有单集都已听完';
    holder.innerHTML = '<div class="history-empty">' + icon('history') + '<span>' + text + '</span>' +
      (!state.auth ? '<button class="text-action" data-empty-action="login">登录</button>' :
        !home && all.length ? '<button class="text-action" data-empty-action="all">查看全部</button>' : '') + '</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  const list = document.createElement('ul');
  list.className = 'history-rows';
  for (const record of filtered) {
    const episode = record.episode;
    const row = document.createElement('li');
    row.className = 'history-row';
    row.dataset.historyEid = episode.eid;
    row.innerHTML = '<button class="history-cover" type="button" data-history-action="cover"></button>' +
      '<div class="history-copy"><button class="history-title" type="button" data-history-action="detail"></button><small></small>' +
      '<span class="history-meter" aria-hidden="true"><i></i></span></div>' +
      '<span class="history-time"><span></span></span><button class="tile-play" type="button" data-history-action="play">' + icon('play') + '</button>';
    const cover = $('.history-cover', row);
    cover.setAttribute('aria-label', '查看单集详情 ' + titleOf(episode));
    paintCover(cover, imageOf(episode), '');
    const title = $('.history-title', row);
    title.textContent = titleOf(episode);
    title.title = titleOf(episode);
    $('.history-copy small', row).textContent = episode.podcast?.title || '';
    const progress = record.completed ? 100 : (record.duration ? record.currentTime / record.duration * 100 : 0);
    $('.history-meter i', row).style.width = Math.min(100, Math.max(0, progress)) + '%';
    $('.history-time span', row).textContent = historyTime(record);
    const play = $('.tile-play', row);
    play.dataset.playEid = episode.eid;
    play.dataset.episodeTitle = titleOf(episode);
    fragment.append(row);
  }
  list.append(fragment);
  holder.append(list);
  syncLibraryPlayButtons();
  if (focusedId && focusedAction) holder.querySelector(`[data-history-eid="${CSS.escape(focusedId)}"] [data-history-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}

async function loadListeningHistory(restore = true) {
  const version = ++historyLoad;
  const selection = selectionVersion;
  const owner = listeningOwner();
  const entries = owner ? await xyzDesktop.history() : [];
  if (version !== historyLoad || owner !== listeningOwner()) return;
  state.listeningHistory = entries;
  renderListeningHistory(); refreshHomePicks();
  if (!restore || state.current || selectionVersion !== selection) return;
  const record = entries.find(entry => !entry.completed) || entries[0];
  if (record) await openEpisode(record.episode, { autoplay: false, navigate: false, record });
}
function updateLocalPosition(record) {
  const entries = state.listeningHistory;
  const index = entries.findIndex(entry => entry.episode.eid === record.episode.eid);
  const existing = entries[index];
  const structureChanged = index !== 0 || existing?.completed !== record.completed;
  if (index >= 0) entries.splice(index, 1);
  entries.unshift(record);
  if ($('#listening-page').hidden && $('#history-page').hidden) return;
  if (structureChanged) { renderListeningHistory(); refreshHomePicks(); return; }
  const row = $('#history-list [data-history-eid="' + CSS.escape(record.episode.eid) + '"]');
  if (!row) return;
  $('.history-time span', row).textContent = historyTime(record);
  $('.history-meter i', row).style.width = record.duration ? (record.currentTime / record.duration * 100) + '%' : '0%';
}
function recordPlayback(kind) {
  const audio = $('#audio');
  if (!state.current || !sourceReady || audio.seeking || !listeningOwner()) return;
  const now = Date.now();
  if (kind === 'timeupdate' && now - lastTick < 800) return;
  lastTick = now;
  if (!audio.paused || kind === 'play') startedListening = true;
  const episode = state.current;
  const compact = { type: 'EPISODE', eid: episodeIdOf(episode), title: titleOf(episode), duration: durationOf(episode),
    audioUrl: audioOf(episode), pubDate: episode.pubDate, imageUrl: imageOf(episode),
    podcast: { pid: podcastIdOf(episode), title: episode.podcast?.title || episode.podcast?.name || '', imageUrl: imageOf(episode) } };
  const duration = Number.isFinite(audio.duration) ? audio.duration : durationOf(episode);
  const currentTime = audio.currentTime;
  const ended = audio.ended || (duration > 0 && currentTime >= duration);
  const force = kind !== 'timeupdate';
  xyzDesktop.playback({ owner: listeningOwner(), record: startedListening, force, episode: compact, title: compact.title,
    currentTime, duration, paused: audio.paused, rate: audio.playbackRate, ended });
  if (startedListening && (force || now - lastHistoryPaint >= 1000)) {
    lastHistoryPaint = now;
    updateLocalPosition({ episode: compact, currentTime, duration, rate: audio.playbackRate, completed: ended, updatedAt: now });
  }
}
function skipBy(seconds) {
  const audio = $('#audio');
  const duration = Number.isFinite(audio.duration) ? audio.duration : durationOf(state.current);
  if (!state.current || !sourceReady || !duration) return;
  startedListening = true;
  audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
}
function activatePlayer(episode, record) {
  const audio = $('#audio');
  recordPlayback('switch');
  sourceReady = false;
  startedListening = false;
  bufferedResume = record && !record.completed ? record.currentTime : 0;
  state.current = episode;
  audio.pause();
  audio.src = audioOf(episode);
  audio.defaultPlaybackRate = record?.rate || 1;
  audio.playbackRate = audio.defaultPlaybackRate;
  if (bufferedResume > 0) audio.currentTime = bufferedResume;
  $('#player-title').textContent = titleOf(episode);
  $('#player-subtitle').textContent = episode.podcast?.title || episode.podcast?.name || '小宇宙单集';
  paintCover($('#player-cover'), imageOf(episode), '节目封面');
  const speed = $('#speed-button');
  const rate = String(audio.playbackRate);
  if (![...speed.options].some(option => option.value === rate)) speed.add(new Option(rate + '×', rate));
  speed.value = rate;
  syncPlaybackButtons();
}
function applyResumePosition() {
  const audio = $('#audio');
  if (!state.current || audio.readyState < 1) return;
  if (bufferedResume !== null) {
    const total = Number.isFinite(audio.duration) ? audio.duration : durationOf(state.current);
    const seconds = total ? Math.min(bufferedResume, total) : bufferedResume;
    if (Math.abs(audio.currentTime - seconds) > .4) audio.currentTime = seconds;
    bufferedResume = null;
  }
  sourceReady = true;
}
function clearListeningSession() {
  selectionVersion++;
  historyLoad++;
  sourceReady = false;
  startedListening = false;
  bufferedResume = null;
  state.current = null;
  state.listeningHistory = [];
  historyFilter = 'all';
  state.episodeDetails.clear();
  state.currentTranscriptPath = ''; state.currentTranscriptEpisodeId = '';
  state.currentTranscriptSegments = []; state.currentSummaryPath = '';
  const audio = $('#audio');
  audio.pause(); audio.removeAttribute('src'); audio.load();
  $('#player-cover').innerHTML = '<img src="icons/planet.svg" alt="" />';
  $('#player-title').textContent = '选一集开始收听';
  $('#player-subtitle').textContent = '从发现或我的订阅选择一集';
  updatePlayerLinkButtons(null); setTranscriptionStatus(); renderPlayerAnchors(null); syncPlaybackButtons();
}
function drawWaveform() {
  const canvas = $('#progress-waveform');
  if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
  const width = canvas.clientWidth, height = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) {
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
  const step = 3.6, inset = 7, count = Math.max(2, Math.floor((width - 2*inset)/step));
  const progress = Number($('#progress').value)/100, enabled = !$('#progress').disabled;
  const samples = state.current?.waveform;
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i=0; i<count; i++) {
    const t = i/(count-1), x = inset + t*(width-2*inset);
    // Decorative bars when a provider supplies no waveform. Time and thumb always come from the audio.
    const supplied = Array.isArray(samples) && samples.length ? Number(samples[Math.round(t*(samples.length-1))]) : NaN;
    const envelope = Math.sin(Math.PI*t)**.65 * (.18 + .5*Math.sin(t*12+.4)**2 + .26*Math.cos(t*23+.8)**2);
    const amplitude = Number.isFinite(supplied) ? Math.min(1,Math.abs(supplied)) :
      envelope * (.22 + .78*Math.abs(Math.sin(i*8.07+.6)*Math.cos(i*.61)));
    const half = enabled ? Math.max(1,amplitude*(height-5)/2) : 1.4 + .22*height*amplitude;
    ctx.strokeStyle = enabled && t <= progress ? '#fbfcfd' : '#7e858c';
    ctx.beginPath(); ctx.moveTo(x,height/2-half); ctx.lineTo(x,height/2+half); ctx.stroke();
  }
}
function initializeListening() {
  $('#all-history').onclick = () => { historyFilter = 'all'; setRoute('history'); };
  $('#empty-discover').onclick = () => setRoute('discover');
  $('#empty-subscriptions').onclick = () => setRoute('subscriptions');
  $('#player-title').onclick = () => { if (state.current) openEpisodeDetail(state.current); };
  $('#player-cover').onclick = () => {
    if (document.body.classList.contains('listening-layout')) openEpisodeDetail(state.current);
    else setRoute('listen');
  };
  $('#brand-home').addEventListener('click', () => setRoute('listen'));
  $('.history-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-history-filter]');
    if (button) { historyFilter = button.dataset.historyFilter; renderListeningHistory(); }
  });
  $('#history-list').addEventListener('click', event => {
    const action = event.target.closest('[data-empty-action]')?.dataset.emptyAction;
    if (action === 'login') return openLogin();
    if (action === 'discover') return setRoute('discover');
    if (action === 'all') { historyFilter = 'all'; return renderListeningHistory(); }
    const id = event.target.closest('[data-history-eid]')?.dataset.historyEid;
    const record = state.listeningHistory.find(r => r.episode.eid === id);
    if (!record) return;
    const rowAction = event.target.closest('[data-history-action]')?.dataset.historyAction;
    if (rowAction === 'play') toggleEpisode(record.episode);
    if (rowAction === 'detail' || rowAction === 'cover') openEpisodeDetail(record.episode);
  });
  $('#episode-notes-button').addEventListener('click', () => {
    $('#player-more-menu').open = false;
    if (state.current) openEpisodeDetail(state.current);
  });
  $('#all-settings-button').addEventListener('click', () => { $('#desktop-options-dialog').close(); setRoute('settings'); });
  const audio = $('#audio');
  audio.addEventListener('loadedmetadata', applyResumePosition);
  for (const kind of ['play','playing','pause','timeupdate','seeked','ratechange','ended','loadedmetadata']) {
    audio.addEventListener(kind, () => {
      if (kind !== 'timeupdate' && kind !== 'seeked') syncPlaybackButtons();
      recordPlayback(kind);
    });
  }
  $('#progress').addEventListener('input', () => {
    if (sourceReady) startedListening = true;
    drawWaveform();
  });
  new ResizeObserver(drawWaveform).observe($('#progress-waveform'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) recordPlayback('hidden'); });
  window.addEventListener('beforeunload', () => recordPlayback('quit'));
  syncPlaybackButtons();
}
