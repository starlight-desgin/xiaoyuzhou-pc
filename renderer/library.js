function searchResultText(item, isPodcast) {
  return item?.description
    || item?.brief
    || item?.introduction
    || item?.podcast?.title
    || item?.podcast?.name
    || (isPodcast ? "播客节目" : "小宇宙单集");
}

function descriptionBlock(text) {
  const value = String(text || "").trim();
  const collapsible = value.length > 110;
  return `<div class="result-description-wrap${collapsible ? " is-collapsed" : ""}">
    <span class="result-description">${esc(value)}</span>
    ${collapsible ? '<button class="description-toggle" data-row-action="toggle-description" type="button">展开</button>' : ""}
  </div>`;
}

function timestampDeepLink(item, seconds) {
  return XYZEpisodeContent.deepLink(episodeIdOf(item), seconds);
}

function seekToTimestamp(seconds, { scroll = false } = {}) {
  const audio = $("#audio");
  if (!audio.src) return notify("当前没有可跳转的播放内容");
  const target = Math.max(0, Number(seconds) || 0);
  audio.currentTime = Math.min(target, audio.duration || target);
  audio.play().catch(() => notify("已定位时间点，请点击播放继续"));
  updateActiveProgressAnchor(target);
  if (scroll) {
    document.querySelector(`[data-content-timestamp="${Math.floor(target)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderEpisodeContentBlocks(episode) {
  const content = episodeContentOf(episode);
  const blocks = XYZEpisodeContent.parseContent(content);
  if (!blocks.length) return `<div class="empty">这期暂时没有 Show Notes 正文。</div>`;
  let listOpen = false;
  const output = [];
  const closeList = () => {
    if (listOpen) output.push("</ul>");
    listOpen = false;
  };

  blocks.forEach((block) => {
    if (block.type !== "bullet") closeList();
    if (block.type === "heading") {
      output.push(`<h2>${esc(block.text)}</h2>`);
    } else if (block.type === "timestamp") {
      const deepLink = timestampDeepLink(episode, block.seconds);
      output.push(`<div class="episode-timestamp-row" data-content-timestamp="${block.seconds}">
        <button class="timestamp-button" type="button" data-seek-seconds="${block.seconds}" title="跳转到 ${esc(block.label)}">${esc(block.label)}</button>
        <p>${esc(block.text || "从这里继续收听")}</p>
        ${deepLink ? `<a href="${esc(deepLink)}" title="在小宇宙打开这个时间点">小宇宙 ↗</a>` : ""}
      </div>`);
    } else if (block.type === "bullet") {
      if (!listOpen) {
        output.push('<ul class="episode-content-list">');
        listOpen = true;
      }
      output.push(`<li>${esc(block.text)}</li>`);
    } else {
      output.push(`<p>${esc(block.text)}</p>`);
    }
  });
  closeList();
  return output.join("");
}


let libraryGeneration = 0;
let feedCache = null;
let subscriptionCache = null;

function resetLibrary() {
  libraryGeneration++;
  feedCache = null;
  subscriptionCache = null;
  state.subscribedPids.clear();
  state.searchKeyword = "";
  $("#search-input").value = "";
  $("#home-picks").hidden = true;
  $("#home-feed").replaceChildren();
}

function getPicks() {
  if (feedCache && Date.now() < feedCache.expires) return feedCache.promise;
  const promise = (async () => {
    let failure;
    for (const [endpoint, body] of [["/editor_pick", {}], ["/discovery", {}], ["/top_list", { category: "HOT" }]]) {
      try {
        const items = extractContent(await api(endpoint, body));
        if (items.length) return items;
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
    return [];
  })();
  feedCache = { promise, expires: Date.now() + 5 * 60_000 };
  promise.catch(() => { if (feedCache?.promise === promise) feedCache = null; });
  return promise;
}

function coverMarkup(item, lazy = true) {
  const url = imageOf(item);
  return url ? `<img src="${esc(url)}" alt="" ${lazy ? 'loading="lazy"' : ''} />` : icon("orbit");
}

function mediaActions(item) {
  const pid = podcastIdOf(item);
  const eid = episodeIdOf(item);
  const subscribed = state.subscribedPids.has(pid);
  return moreActions([
    !isPodcastItem(item) && pid ? '<button data-action="podcast">查看节目</button>' : "",
    pid ? `<button data-action="subscribe" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    '<button data-action="download">下载音频</button><button data-action="transcribe">导出文字稿</button>',
    summaryActionButton(item, "", 'data-action="summarize"'),
    eid ? '<button data-action="copy-episode">复制单集链接</button>' : "",
    pid ? '<button data-action="copy-podcast">复制节目链接</button>' : ""
  ].join(""));
}

function playControl(item) {
  return `<button class="tile-play" type="button" data-action="play" data-play-eid="${esc(episodeIdOf(item))}" aria-label="播放 ${esc(titleOf(item))}" title="播放">${icon("play")}</button>`;
}

function mediaItem(item, index, layout) {
  const podcast = isPodcastItem(item);
  const title = esc(titleOf(item));
  const subtitle = podcast ? (item.author?.nickname || item.author?.name || item.brief || "播客节目")
    : item.podcast?.title || item.podcast?.name || "播客单集";
  const minutes = Math.ceil(durationOf(item) / 60);
  const detail = `<button type="button" class="media-title" title="${title}" data-action="detail">${title}</button>`;
  const cover = `<button type="button" class="media-image" data-action="detail" aria-label="查看${title}">${coverMarkup(item)}</button>`;
  const byline = `<span class="media-byline">${esc(subtitle)}</span>`;
  if (layout === "grid") {
    return `<article class="media-item media-tile" data-index="${index}"><div class="tile-art">${cover}${playControl(item)}</div>
      <div class="tile-caption"><div>${detail}${byline}</div>${mediaActions(item)}</div>
      ${!podcast ? episodeCardFacts(item) : ""}</article>`;
  }
  return `<article class="media-item media-row" data-index="${index}">${cover}<div class="media-info">${detail}${byline}
    ${layout === "search" && searchResultText(item, podcast) !== subtitle ? descriptionBlock(searchResultText(item, podcast)) : ""}</div>
    ${minutes ? `<small class="row-duration">${minutes} 分钟</small>` : ""}${playControl(item)}${layout === "preview" ? "" : mediaActions(item)}</article>`;
}

function syncLibraryPlayButtons() {
  const current = episodeIdOf(state.current);
  const playing = current && !$("#audio").paused && !$("#audio").ended;
  for (const button of $$("[data-play-eid]")) {
    const active = Boolean(playing && button.dataset.playEid === current);
    const label = active ? "暂停" : "播放";
    button.querySelector("use")?.setAttribute("href", "symbols.svg#" + (active ? "pause" : "play"));
    button.title = label;
    if (button.id === "detail-play") button.querySelector("span").textContent = active ? "暂停" : "播放单集";
    button.setAttribute("aria-label", label + " " + (button.closest(".media-item")?.querySelector(".media-title")?.textContent || button.dataset.episodeTitle || ""));
  }
}

function toggleEpisode(item) {
  if (episodeIdOf(item) && episodeIdOf(item) === episodeIdOf(state.current) && !$("#audio").paused) {
    $("#audio").pause();
    return;
  }
  return openEpisode(item);
}

function renderMediaList(holder, items, layout) {
  holder.innerHTML = items.map((item, index) => mediaItem(item, index, layout)).join("");
  syncLibraryPlayButtons();
  holder.onclick = event => {
    const control = event.target.closest("button");
    const row = control?.closest("[data-index]");
    if (!row) return;
    const item = items[Number(row.dataset.index)];
    closeActionMenu(control);
    switch (control.dataset.action || control.dataset.rowAction) {
      case "detail": return isPodcastItem(item) ? openPodcast(item) : openEpisodeDetail(item);
      case "play": return toggleEpisode(item);
      case "podcast": return openPodcast(item);
      case "subscribe": return toggleSubscription(item, control);
      case "download": return downloadEpisodeAudio(item);
      case "transcribe": return exportEpisodeTranscript(item, control);
      case "summarize": return summarizeEpisode(item, control).catch(error => notify(error.message));
      case "copy-episode": return copyEpisodeLink(item);
      case "copy-podcast": return copyPodcastLink(item);
      case "toggle-description": {
        const wrap = control.closest(".result-description-wrap");
        control.textContent = wrap.classList.toggle("is-collapsed") ? "展开" : "收起";
      }
    }
  };
}

function libraryError(holder, error, retry) {
  holder.innerHTML = `<div class="empty"><p>${esc(error.message || "加载失败")}</p><button class="secondary-button" data-retry>重试</button>
    ${!state.auth ? '<button class="secondary-button" data-login>登录小宇宙</button>' : ""}</div>`;
  $("[data-retry]", holder).onclick = retry;
  $("[data-login]", holder)?.addEventListener("click", openLogin);
}

function refreshHomePicks() {
  if (!document.body.classList.contains("listening-layout")) return;
  const recent = new Set(state.listeningHistory.slice(0, 3).map(entry => entry.episode.eid));
  const items = (feedCache?.items || []).filter(item => !recent.has(episodeIdOf(item))).slice(0, 2);
  renderMediaList($("#home-feed"), items, "preview");
  $("#home-picks").hidden = !items.length;
}

async function renderHomePicks() {
  const generation = libraryGeneration;
  try {
    const items = await getPicks();
    if (generation !== libraryGeneration || !feedCache) return;
    feedCache.items = items;
    refreshHomePicks();
  } catch {
    if (generation === libraryGeneration) $("#home-picks").hidden = true;
  }
}

async function renderDiscoverPage(root) {
  root.innerHTML = '<div class="section-heading"><h2>编辑精选</h2></div><div id="discover-feed" class="feed-grid"><div class="loading">正在加载精选单集…</div></div>';
  const holder = $("#discover-feed");
  try {
    const items = await getPicks();
    if (!holder.isConnected) return;
    if (!items.length) return libraryError(holder, Error("暂时没有发现内容"), () => renderDiscoverPage(root));
    renderMediaList(holder, items, "grid");
  } catch (error) {
    if (holder.isConnected) libraryError(holder, error, () => renderDiscoverPage(root));
  }
}

function renderSearchPage(root) {
  root.innerHTML = `<div class="segmented search-types" role="group" aria-label="搜索范围">${SEARCH_TYPES.map(type =>
    `<button data-search-type="${type}" aria-pressed="${type === state.searchType}">${SEARCH_TYPE_LABELS[type]}</button>`).join("")}</div>
    <div id="search-results" class="result-list"></div>`;
  $(".search-types", root).onclick = event => {
    const type = event.target.closest("[data-search-type]")?.dataset.searchType;
    if (type) { state.searchType = type; renderSearchPage(root); }
  };
  renderSearchResults();
}

function renderSearchResults() {
  const holder = $("#search-results");
  if (!holder?.isConnected) return;
  const keyword = state.searchKeyword;
  $("#route-meta").textContent = keyword ? "“" + keyword + "”" : "";
  if (!keyword) {
    holder.innerHTML = '<div class="empty">在上方输入节目或单集名称，按 Enter 搜索</div>';
    return;
  }
  const type = state.searchType;
  if (state.searchErrorsByType[type]) return libraryError(holder, new Error(state.searchErrorsByType[type]), () => performSearch(keyword));
  const items = state.searchResultsByType[type];
  if (!items) { holder.innerHTML = '<div class="loading">正在搜索…</div>'; return; }
  if (!items.length) { holder.innerHTML = `<div class="empty">没有找到相关${SEARCH_TYPE_LABELS[type]}</div>`; return; }
  renderMediaList(holder, items, "search");
}

async function performSearch(keyword) {
  const request = ++state.searchRequest;
  state.searchKeyword = keyword;
  state.searchResultsByType = { episode: null, podcast: null };
  state.searchErrorsByType = {};
  setRoute("search");
  if (!keyword) return;
  await Promise.all(SEARCH_TYPES.map(async type => {
    try {
      const result = await api("/search", { keyword, type: type.toUpperCase() });
      if (request !== state.searchRequest) return;
      state.searchResultsByType[type] = listOf(result).map(itemOf).filter(item => item?.type === type.toUpperCase());
    } catch (error) {
      if (request !== state.searchRequest) return;
      state.searchErrorsByType[type] = error.message || "搜索失败";
    }
    if (state.route === "search" && !state.episodeView && !state.podcastView && state.searchType === type) renderSearchResults();
  }));
}

function renderSubscriptionsPage(root) {
  root.innerHTML = '<div id="subscriptions-list" class="feed-grid"><div class="loading">正在读取订阅…</div></div><button id="more-subscriptions" class="secondary-button load-more" hidden>加载更多节目</button>';
  const holder = $("#subscriptions-list");
  const more = $("#more-subscriptions");
  const cache = subscriptionCache ||= { items: [], loaded: false, cursor: null, pending: null };
  const paint = () => {
    if (!holder.isConnected || subscriptionCache !== cache) return;
    more.hidden = !cache.cursor;
    more.disabled = Boolean(cache.pending);
    $("#route-meta").textContent = cache.items.length ? cache.items.length + (cache.cursor ? "+ 个节目" : " 个节目") : "";
    if (cache.items.length) renderMediaList(holder, cache.items, "grid");
    else holder.innerHTML = '<div class="empty">还没有订阅节目。可以在节目详情里点击「订阅节目」。</div>';
  };
  const load = async () => {
    more.disabled = true;
    try {
      if (!cache.pending) {
        cache.pending = (async () => {
          const body = { limit: 40, sortOrder: "desc", sortBy: "subscribedAt" };
          if (cache.cursor) body.loadMoreKey = cache.cursor;
          const response = await api("/subscription", body);
          if (cache !== subscriptionCache) return;
          const seen = new Set(cache.items.map(podcastIdOf));
          const fresh = listOf(response).map(itemOf).filter(isPodcastItem).filter(item => {
            const id = podcastIdOf(item);
            if (!id || seen.has(id)) return false;
            seen.add(id); state.subscribedPids.add(id); return true;
          });
          cache.items.push(...fresh);
          const next = response.loadMoreKey ?? response.data?.loadMoreKey;
          cache.cursor = fresh.length && next && JSON.stringify(next) !== JSON.stringify(cache.cursor) ? next : null;
          cache.loaded = true;
        })().finally(() => { cache.pending = null; });
      }
      await cache.pending;
      paint();
    } catch (error) {
      if (!holder.isConnected) return;
      if (!cache.items.length) libraryError(holder, error, load);
      else notify(error.message);
    } finally { more.disabled = false; }
  };
  more.onclick = load;
  if (cache.loaded) paint(); else load();
}

function openPodcast(item) {
  const podcast = podcastOf(item);
  if (!podcastIdOf(podcast)) return notify("无法识别这个节目");
  if (state.podcastView && podcastIdOf(state.podcastView.podcast) === podcastIdOf(podcast)) return;
  showDetail({ podcastView: { podcast, episodes: null } });
}

function renderPodcastPage(root) {
  const view = state.podcastView;
  const podcast = view.podcast;
  const pid = podcastIdOf(podcast);
  const subscribed = state.subscribedPids.has(pid);
  root.innerHTML = `<article class="podcast-detail"><div class="detail-header"><div class="detail-cover">${coverMarkup(podcast, false)}</div>
    <div><span class="detail-type">播客节目</span><h1>${esc(titleOf(podcast))}</h1>
    <p>${esc(podcast.author?.nickname || podcast.author?.name || "")}</p>
    <div class="detail-actions"><button id="detail-subscribe" class="primary-button" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button><button id="detail-copy" class="secondary-button">复制节目链接</button></div></div></div>
    ${podcast.description || podcast.brief ? `<p class="detail-description">${esc(podcast.description || podcast.brief)}</p>` : ""}
    <div class="section-heading"><h2>节目单集</h2></div><div id="podcast-episodes" class="result-list"><div class="loading">正在读取单集…</div></div>
    <button class="secondary-button load-more" id="more-episodes" hidden>加载更多单集</button></article>`;
  $("#detail-subscribe").onclick = event => toggleSubscription(podcast, event.currentTarget);
  $("#detail-copy").onclick = () => copyPodcastLink(podcast);
  const holder = $("#podcast-episodes");
  const more = $("#more-episodes");
  const paint = () => {
    if (!holder.isConnected) return;
    more.hidden = !view.cursor;
    if (view.episodes?.length) renderMediaList(holder, view.episodes, "rows");
    else holder.innerHTML = '<div class="empty">这个节目还没有单集</div>';
  };
  const load = async () => {
    more.disabled = true;
    try {
      if (!view.pending) view.pending = (async () => {
        const response = await api("/episode_list", { pid, order: "desc", ...(view.cursor ? { loadMoreKey: view.cursor } : {}) });
        const known = new Set((view.episodes || []).map(episodeIdOf));
        const items = extractContent(response).filter(item => episodeIdOf(item) && !known.has(episodeIdOf(item))).map(item => episodeWithPodcast(item, podcast));
        const next = response.loadMoreKey ?? response.data?.loadMoreKey;
        view.cursor = items.length && next && JSON.stringify(next) !== JSON.stringify(view.cursor) ? next : null;
        view.episodes = [...(view.episodes || []), ...items];
      })().finally(() => { view.pending = null; });
      await view.pending;
      paint();
    } catch (error) {
      if (holder.isConnected && !view.episodes) libraryError(holder, error, load);
      else if (holder.isConnected) notify(error.message);
    } finally { more.disabled = false; }
  };
  more.onclick = load;
  if (view.episodes) paint(); else load();
}

async function openEpisodeDetail(item) {
  if (!episodeIdOf(item)) return openPodcast(item);
  if (state.episodeView && episodeIdOf(state.episodeView.episode) === episodeIdOf(item)) return;
  const view = { episode: item, loading: !state.episodeDetails.has(episodeIdOf(item)) };
  showDetail({ episodeView: view });
  try {
    view.episode = await resolveEpisode(item) || item;
  } catch (error) { view.error = error.message; }
  view.loading = false;
  if (state.episodeView === view) renderEpisodePage($("#page-content"));
}

function renderEpisodePage(root) {
  const { episode, loading, error } = state.episodeView;
  const timeline = XYZEpisodeContent.extractTimeline(episodeContentOf(episode));
  const source = episodeLinkOf(episode);
  const facts = [episode.podcast?.title, formatEpisodePublishDate(episode.pubDate), durationOf(episode) ? Math.ceil(durationOf(episode) / 60) + " 分钟" : ""].filter(Boolean);
  root.innerHTML = `<article class="episode-content-page"><div class="detail-header"><div class="detail-cover">${coverMarkup(episode, false)}</div>
    <div><span class="detail-type">播客单集</span><h1>${esc(titleOf(episode))}</h1><p>${esc(facts.join(" · "))}</p>
    <div class="detail-actions"><button id="detail-play" class="primary-button" data-play-eid="${esc(episodeIdOf(episode))}" data-episode-title="${esc(titleOf(episode))}">${icon("play")}<span>播放单集</span></button>
    ${podcastIdOf(episode) ? '<button id="detail-program" class="secondary-button">查看节目</button>' : ""}${source ? `<a href="${esc(source)}" target="_blank" rel="noreferrer">原文 ↗</a>` : ""}</div></div></div>
    ${timeline.length ? `<div class="section-heading"><h2>章节</h2></div><div class="episode-chapter-strip">${timeline.map(ch => `<button data-seek-seconds="${ch.seconds}"><strong>${esc(ch.label)}</strong><span>${esc(ch.text || "从这里收听")}</span></button>`).join("")}</div>` : ""}
    <div class="section-heading"><h2>本期内容</h2></div><div class="episode-content-body">${loading ? '<div class="loading">正在读取单集详情…</div>' : error ? `<div class="empty">${esc(error)}</div>` : renderEpisodeContentBlocks(episode)}</div></article>`;
  $("#detail-play").onclick = () => toggleEpisode(episode);
  $("#detail-program")?.addEventListener("click", () => openPodcast(episode));
  syncLibraryPlayButtons();
  $$("[data-seek-seconds]", root).forEach(button => button.onclick = async () => {
    await openEpisode(episode, { autoplay: false });
    if (episodeIdOf(state.current) !== episodeIdOf(episode)) return;
    bufferedResume = Number(button.dataset.seekSeconds);
    seekToTimestamp(bufferedResume);
    if (sourceReady) bufferedResume = null;
  });
}

function initializeLibrary() {
  const input = $("#search-input");
  $("#global-search").onsubmit = event => { event.preventDefault(); performSearch(input.value.trim()); };
  $("#more-picks").onclick = () => setRoute("discover");
  document.addEventListener("keydown", event => {
    if (event.isComposing || event.defaultPrevented || $("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
      event.preventDefault(); input.focus(); input.select(); return;
    }
    if (event.key === "Escape" && $(".action-menu[open]")) {
      const menu = $(".action-menu[open]"); menu.open = false; menu.querySelector("summary").focus(); return;
    }
    if (event.altKey && event.key === "ArrowLeft" && navigationTrail.length) {
      event.preventDefault(); goBack(); return;
    }
    if (event.code === "Space" && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
        !event.target.closest("input, select, textarea, button, a, summary, [contenteditable=true]") && state.current) {
      event.preventDefault(); $("#play-button").click();
    }
  });
  document.addEventListener("error", event => {
    const image = event.target;
    if (image.tagName === "IMG" && image.closest(".media-image, .detail-cover")) image.parentElement.innerHTML = icon("orbit");
  }, true);
}
