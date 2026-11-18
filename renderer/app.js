const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const AUTH_SESSION_KEY = "xyzAuthSession";
const SUMMARY_PROVIDERS = [
  { id: "qwen", label: "Qwen", keyField: "summaryQwenApiKey" },
  { id: "doubao", label: "豆包", keyField: "summaryDoubaoApiKey" },
  { id: "deepseek", label: "DeepSeek", keyField: "summaryDeepseekApiKey" },
  { id: "kimi", label: "Kimi", keyField: "summaryKimiApiKey" },
  { id: "glm", label: "GLM", keyField: "summaryGlmApiKey" },
  { id: "openrouter", label: "OpenRouter", keyField: "" }
];
const SUMMARY_PROVIDER_DEFAULTS = {
  qwen: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus" },
  doubao: { endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", model: "doubao-seed-2-1-pro-260628" },
  deepseek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash" },
  kimi: { endpoint: "https://api.moonshot.cn/v1/chat/completions", model: "kimi-k2.6" },
  glm: { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-5.2" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "qwen/qwen3.7-plus" }
};

const state = {
  route: "listen",
  searchType: "episode",
  current: null,
  listeningHistory: [],
  episodeDetails: new Map(),
  auth: null,
  settings: null,
  settingsTab: "files",
  searchRequest: 0,
  searchKeyword: "",
  searchResultsByType: { episode: null, podcast: null },
  searchErrorsByType: {},
  podcastView: null,
  episodeView: null,
  subscribedPids: new Set(),
  currentTranscriptPath: "",
  currentTranscriptEpisodeId: "",
  currentTranscriptSegments: [],
  currentSummaryPath: "",
  summaryHistory: new Map(),
  summaryModelDrafts: [],
  summaryModelCredentialStatus: {},
  summaryModelEditorId: "",
  summaryModelMutationPending: false,
  summaryPromptDrafts: [],
  summaryPromptEditorId: ""
};

const routeTitles = { listen: "收听", discover: "发现", subscriptions: "我的订阅", history: "播放历史", search: "搜索", settings: "设置" };
const navigationTrail = [];

const SEARCH_TYPES = ["episode", "podcast"];
const SEARCH_TYPE_LABELS = {
  episode: "单集",
  podcast: "节目"
};

async function send(type, payload = {}) {
  const result = await window.xyzDesktop.request({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || "请求失败");
  return result.data;
}

function api(endpoint, body = {}, method = "POST") {
  return send("api", { payload: { endpoint, body, method } });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function summaryRecordOf(item) {
  return state.summaryHistory.get(episodeIdOf(item)) || null;
}

function summaryActionButton(item, className, actionAttribute) {
  const eid = episodeIdOf(item);
  const completed = Boolean(eid && state.summaryHistory.has(eid));
  return `<button
    class="${className}${completed ? " is-complete" : ""}"
    ${actionAttribute}
    ${eid ? `data-summary-eid="${esc(eid)}"` : ""}
    title="${completed ? "已有总结，再次点击可重新生成" : "生成 AI 总结"}"
  >${completed ? "已 AI 总结" : "AI 总结"}</button>`;
}

function transcriptActionLabel() {
  return "ASR 转写";
}

function refreshSummaryIndicators(episodeId = "") {
  const eid = String(episodeId || "");
  $$("[data-summary-eid]").forEach((button) => {
    if (button.dataset.summaryEid !== eid) return;
    button.classList.add("is-complete");
    button.textContent = "已 AI 总结";
    button.title = "已有总结，再次点击可重新生成";
  });
  if (episodeIdOf(state.current) === eid) updatePlayerLinkButtons(state.current);
}

function moreActions(content, className = "") {
  if (!content) return "";
  return `<details class="action-menu ${className}">
    <summary class="more-button" title="更多操作" aria-label="更多操作">${icon("more")}</summary>
    <div class="action-menu-panel">${content}</div>
  </details>`;
}

function closeActionMenu(target) {
  target?.closest(".action-menu")?.removeAttribute("open");
}

function dataOf(response) {
  return response?.data ?? response?.list ?? response?.items ?? response ?? [];
}

function itemOf(value) {
  if (["EPISODE", "PODCAST", "USER"].includes(value?.type) || value?.eid || value?.pid) return value;
  return value?.episode || value?.podcast || value?.item || value;
}

function isContentItem(item) {
  return Boolean(item?.eid || item?.pid || item?.episode?.eid || item?.podcast?.pid || item?.podcast?.id ||
    (["EPISODE", "PODCAST"].includes(item?.type) && item?.id));
}

function listOf(response) {
  const data = dataOf(response);
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.list ?? data?.items ?? data?.episodes ?? data?.podcasts ?? data?.picks ?? [];
}

function extractContent(response) {
  const items = [];
  const visited = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const item = itemOf(value);
    if (item !== value && item && typeof item === "object") {
      if (isContentItem(item)) items.push(item);
      return;
    }
    if (isContentItem(value)) {
      items.push(value);
      return;
    }
    ["data", "list", "items", "picks", "target", "collections", "sections"].forEach((key) => walk(value[key]));
  };
  walk(response);
  return [...new Map(items.map((item) => [`${episodeIdOf(item)}:${podcastIdOf(item)}`, item])).values()];
}

function unwrapDetail(response) {
  const data = dataOf(response);
  return data?.data || data?.episode || data;
}

function imageOf(item) {
  const urlOf = value => value?.image?.picUrl || value?.image?.largePicUrl || value?.image?.middlePicUrl ||
    value?.image?.thumbnailUrl || value?.cover?.url || value?.imageUrl || "";
  return urlOf(item?.podcast) || urlOf(item);
}

function episodeWithPodcast(episode, parent) {
  if (!episode || !parent) return episode;
  const podcast = { ...parent, ...episode.podcast };
  podcast.imageUrl = imageOf(episode.podcast) || imageOf(parent);
  return { ...episode, podcast };
}

function titleOf(item) {
  return item?.title || item?.name || item?.podcast?.title || item?.podcast?.name || "未命名节目";
}

function episodeMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatEpisodeMetricCount(value) {
  const count = episodeMetricNumber(value);
  if (count === null) return "";
  if (count < 10_000) return String(Math.floor(count));
  if (count < 100_000_000) {
    const compact = Math.round(count / 1_000) / 10;
    return `${String(compact).replace(/\.0$/, "")}万`;
  }
  const compact = Math.round(count / 10_000_000) / 10;
  return `${String(compact).replace(/\.0$/, "")}亿`;
}

function formatEpisodePublishDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day}`;
}

function episodeCardFacts(item) {
  const source = item?.episode?.eid ? item.episode : item;
  const duration = durationOf(source);
  const facts = [
    {
      className: "is-duration",
      label: "时长",
      value: duration ? formatTime(duration) : "",
      icon: ""
    },
    {
      className: "is-published",
      label: "发布日期",
      value: formatEpisodePublishDate(source?.pubDate || source?.publishedAt || source?.createdAt),
      icon: ""
    },
    {
      className: "is-listens",
      label: "收听数",
      value: formatEpisodeMetricCount(source?.playCount),
      icon: "metric-icon-listens"
    },
    {
      className: "is-comments",
      label: "评论数",
      value: formatEpisodeMetricCount(source?.commentCount),
      icon: "metric-icon-comments"
    }
  ].filter((fact) => fact.value);
  if (!facts.length) return "";
  return `<div class="episode-card-facts" aria-label="单集数据">${
    facts.map((fact) => `<span class="episode-card-metric ${fact.className}" aria-label="${esc(`${fact.label} ${fact.value}`)}" title="${esc(`${fact.label} ${fact.value}`)}">${
      fact.icon ? `<i class="metric-icon ${fact.icon}" aria-hidden="true"></i>` : ""
    }<span>${esc(fact.value)}</span></span>`).join("")
  }</div>`;
}

function podcastIdOf(item) {
  return item?.pid || item?.podcast?.pid || item?.podcast?.id || (item?.type === "PODCAST" ? item.id : "") || "";
}

function episodeIdOf(item) {
  return item?.eid || item?.episode?.eid || item?.episode?.id || (item?.type === "EPISODE" ? item.id : "") || "";
}

function podcastOf(item) {
  return item?.podcast && podcastIdOf(item.podcast) ? item.podcast : item;
}

function isPodcastItem(item) {
  return Boolean(podcastIdOf(item) && !episodeIdOf(item));
}

function audioOf(item) {
  return item?.media?.source?.url || item?.media?.url || item?.enclosure?.url || item?.audioUrl || item?.url || "";
}

function episodeContentOf(item) {
  const html = String(item?.shownotes || "");
  if (html) {
    const documentValue = new DOMParser().parseFromString(html, "text/html");
    documentValue.querySelectorAll("[data-timestamp]").forEach((node) => {
      const seconds = Number(node.getAttribute("data-timestamp"));
      const label = Number.isFinite(seconds) ? formatTime(seconds) : "";
      if (label && !String(node.textContent || "").includes(label)) {
        node.prepend(`${label} `);
      }
      node.after(" ");
    });
    documentValue.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    documentValue.querySelectorAll("p, li, h1, h2, h3, h4")
      .forEach((node) => node.append("\n"));
    const content = String(documentValue.body.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (content) return content;
  }
  const plain = item?.description || item?.brief || item?.introduction || "";
  return String(plain).replace(/\\n/g, "\n").trim();
}

function durationOf(item) {
  const value = Number(item?.duration || item?.media?.duration || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function audioExtensionOf(item) {
  try {
    const extension = new URL(audioOf(item)).pathname.match(/\.(mp3|m4a|wav|ogg|flac|aac|aiff|wma|webm)$/i)?.[1];
    return extension ? `.${extension.toLowerCase()}` : ".m4a";
  } catch {
    return ".m4a";
  }
}

function filenamePart(value, fallback) {
  const clean = String(value || fallback).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function audioFilenameOf(item) {
  const extension = audioExtensionOf(item);
  const filename = `${filenamePart(item?.podcast?.title || item?.podcast?.name, "小宇宙")} - ${filenamePart(titleOf(item), "单集")}`;
  return `${filename.slice(0, 160)}${extension}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return XYZEpisodeContent.formatTimestamp(seconds);
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setTranscriptionStatus(message = "", type = "pending") {
  const status = $("#transcription-status");
  status.hidden = !message;
  status.textContent = message;
  status.title = message;
  status.style.color = type === "success" ? "#377551" : type === "error" ? "#9a5146" : "#8a6a16";
}

function setRoute(route) {
  if (!Object.hasOwn(routeTitles, route)) return;
  navigationTrail.length = 0;
  state.podcastView = null;
  state.episodeView = null;
  state.route = route;
  renderRoute();
  window.scrollTo(0, 0);
}

function showDetail(views) {
  navigationTrail.push({ podcastView: state.podcastView, episodeView: state.episodeView, scrollY: window.scrollY });
  state.podcastView = views.podcastView || null;
  state.episodeView = views.episodeView || null;
  renderRoute();
  window.scrollTo(0, 0);
}

function goBack() {
  const previous = navigationTrail.pop();
  if (!previous) return;
  state.podcastView = previous.podcastView;
  state.episodeView = previous.episodeView;
  renderRoute();
  requestAnimationFrame(() => window.scrollTo(0, previous.scrollY));
}

function markConnection() {
  const account = $("#account-button");
  const accountName = state.auth?.user?.nickname || state.auth?.user?.name || "";
  $("#account-label").textContent = state.auth ? (accountName || "已登录") : "登录";
  account.title = state.auth ? (accountName || "已登录") + " · 账号设置" : "登录小宇宙";
  account.setAttribute("aria-label", account.title);
  account.classList.toggle("is-logged", Boolean(state.auth));
}

function renderRoute() {
  const root = $("#page-content");
  const detail = Boolean(state.episodeView || state.podcastView);
  document.body.classList.toggle("detail-layout", detail);
  $("#back-button").hidden = !navigationTrail.length;
  $("#route-title").textContent = routeTitles[state.route];
  $("#route-meta").textContent = "";
  $$(".nav-item[data-route]").forEach(button => {
    const active = button.dataset.route === state.route;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const home = !detail && state.route === "listen";
  const history = !detail && state.route === "history";
  mountListeningLayout(home, history);
  if (home) return renderHomePicks();
  if (history) return;
  if (state.episodeView) return renderEpisodePage(root);
  if (state.podcastView) return renderPodcastPage(root);
  if (state.route === "search") return renderSearchPage(root);
  if (state.route === "subscriptions") return renderSubscriptionsPage(root);
  if (state.route === "settings") return renderSettingsPage(root);
  return renderDiscoverPage(root);
}

function podcastLinkOf(item) {
  const pid = podcastIdOf(item);
  return pid ? `https://www.xiaoyuzhoufm.com/podcast/${pid}` : "";
}

function episodeLinkOf(item) {
  const eid = episodeIdOf(item);
  return eid ? `https://www.xiaoyuzhoufm.com/episode/${eid}` : "";
}

function showPlayerTimestampTooltip(button) {
  const tooltip = $("#player-timestamp-tooltip");
  const track = button.closest(".player-progress-track");
  if (!tooltip || !track) return;
  tooltip.textContent = button.dataset.label || "";
  tooltip.classList.add("is-visible");
  requestAnimationFrame(() => {
    const width = tooltip.offsetWidth;
    const trackRect = track.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2;
    const viewportCenter = Math.max(width / 2 + 12, Math.min(window.innerWidth - width / 2 - 12, center));
    tooltip.style.left = `${viewportCenter - trackRect.left}px`;
  });
}

function hidePlayerTimestampTooltip() {
  $("#player-timestamp-tooltip")?.classList.remove("is-visible");
}

let chapterButtons = [];
let activeChapter = null;

function renderPlayerAnchors(item = null) {
  const holder = $("#progress-anchors");
  if (!holder) return;
  const timeline = item ? XYZEpisodeContent.extractTimeline(episodeContentOf(item)) : [];
  const audioDuration = Number($("#audio")?.duration);
  const duration = Number.isFinite(audioDuration) && audioDuration > 0
    ? audioDuration
    : durationOf(item) || (timeline.at(-1)?.seconds || 0);
  holder.innerHTML = duration > 0
    ? timeline.map((entry) => {
      const left = Math.max(0, Math.min(100, entry.seconds / duration * 100));
      const tooltip = `${entry.label} ${entry.text || "继续收听"}`;
      return `<button
        type="button"
        style="--anchor-position:${left}%"
        data-progress-seconds="${entry.seconds}"
        data-label="${esc(tooltip)}"
        aria-label="${esc(`跳转到 ${entry.label} ${entry.text || ""}`)}"
      ></button>`;
    }).join("")
    : "";
  activeChapter = null;
  chapterButtons = $$("[data-progress-seconds]", holder);
  chapterButtons.forEach((button) => {
    button.addEventListener("click", () => seekToTimestamp(button.dataset.progressSeconds, { scroll: true }));
    button.addEventListener("mouseenter", () => showPlayerTimestampTooltip(button));
    button.addEventListener("focus", () => showPlayerTimestampTooltip(button));
    button.addEventListener("mouseleave", hidePlayerTimestampTooltip);
    button.addEventListener("blur", hidePlayerTimestampTooltip);
  });
  updateActiveProgressAnchor($("#audio")?.currentTime || 0);
}

function updateActiveProgressAnchor(seconds) {
  const next = chapterButtons.findLast(button => Number(button.dataset.progressSeconds) <= seconds + .25);
  if (next === activeChapter) return;
  activeChapter?.classList.remove("is-active");
  next?.classList.add("is-active");
  activeChapter = next;
}

async function copyLink(url, label) {
  if (!url) return notify(`当前没有可复制的${label}链接`);
  try { await navigator.clipboard.writeText(url); notify("链接已复制"); } catch { notify(url); }
}

function copyEpisodeLink(item) {
  return copyLink(episodeLinkOf(item), "单集");
}

function copyPodcastLink(item) {
  return copyLink(podcastLinkOf(item), "节目");
}

function updatePlayerLinkButtons(item = null) {
  const hasAudio = Boolean(audioOf(item));
  const hasSummaryModel = Boolean(state.settings?.summaryModels?.some((model) => model.enabled));
  const summaryButton = $("#summarize-button");
  const summarized = Boolean(summaryRecordOf(item));
  $("#download-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").textContent = transcriptActionLabel();
  $("#transcribe-audio-button").title = transcriptSourceLabel();
  summaryButton.disabled = !hasAudio || !hasSummaryModel;
  summaryButton.textContent = summarized ? "已 AI 总结" : "AI 总结";
  summaryButton.classList.toggle("is-complete", summarized);
  summaryButton.title = summarized
    ? "已有总结，再次点击可重新生成"
    : hasSummaryModel
      ? "导出文字稿并总结当前单集"
      : "请先在设置中启用 AI 总结模型";
  $("#view-podcast-button").disabled = !podcastIdOf(item);
  $("#copy-episode-link-button").disabled = !episodeLinkOf(item);
  $("#copy-podcast-link-button").disabled = !podcastLinkOf(item);
}

async function resolveEpisode(item) {
  if (!item) return;
  const owner = listeningOwner();
  let eid = episodeIdOf(item);
  let episode = item;
  if (!eid && podcastIdOf(item)) {
    const response = await api("/episode_list", { pid: podcastIdOf(item), order: "desc" });
    const episodes = extractContent(response).filter((candidate) => episodeIdOf(candidate));
    episode = episodeWithPodcast(episodes[0], podcastOf(item)) || item;
    eid = episodeIdOf(episode);
  }
  if (eid && state.episodeDetails.has(eid)) {
    return state.episodeDetails.get(eid);
  }
  if (eid) {
    try {
      const detail = unwrapDetail(await api("/episode_detail", { eid }, "GET"));
      episode = episodeWithPodcast({ ...episode, ...detail }, episode.podcast);
      if (owner === listeningOwner()) state.episodeDetails.set(eid, episode);
    } catch (error) {
      if (!audioOf(episode)) throw error;
      episode = { ...episode, detailLoadError: error.message };
    }
  }
  return episode;
}

async function downloadEpisodeAudio(item) {
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) return notify("这集暂时没有可下载的音频地址");
    const result = await send("download-audio", { payload: { url: audio, filename: audioFilenameOf(episode) } });
    if (result?.path) notify(`音频已保存：${result.path}`);
    else notify(state.settings?.downloadSaveAs ? "请选择本地保存位置" : "已开始下载音频");
  } catch (error) {
    notify(error.message);
  }
}

function transcriptSourceLabel() {
  return asrProviderLabel();
}

function transcriptTimelineOf(episode) {
  return XYZEpisodeContent.extractTimeline(episodeContentOf(episode))
    .map((entry) => ({
      seconds: entry.seconds,
      label: entry.label,
      title: entry.text || ""
    }));
}

function rememberTranscriptExport(episode, result) {
  const transcriptPath = result.markdown || result.md || result.txt;
  if (!transcriptPath) throw new Error("文字稿导出完成但未返回文件路径");
  state.currentTranscriptPath = transcriptPath;
  state.currentTranscriptEpisodeId = episodeIdOf(episode);
  state.currentTranscriptSegments = [];
  state.currentSummaryPath = "";
  return transcriptPath;
}

async function transcribeEpisodeAudio(item, button = null, { propagate = false } = {}) {
  const originalText = button?.textContent;
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) throw new Error("这集暂时没有可转写的音频地址");
    if (button) {
      button.disabled = true;
      button.textContent = "转写中…";
    }
    const providerLabel = state.settings?.asrProvider === "local_qwen"
      ? "本地 Qwen"
      : state.settings?.asrProvider === "doubao"
        ? "豆包"
        : "Qwen";
    setTranscriptionStatus(`${providerLabel} 长音频转写中，请保持窗口打开`);
    notify(`${providerLabel} ASR 正在转写，请保持窗口打开`);
    const filename = audioFilenameOf(episode);
    const result = await send("transcribe-audio", {
      payload: {
        url: audio,
        filename,
        baseName: filename.replace(/\.[^.]+$/, ""),
        language: "zh",
        episodeId: episodeIdOf(episode),
        episodeUrl: episodeLinkOf(episode),
        timeline: transcriptTimelineOf(episode)
      }
    });
    const transcriptPath = rememberTranscriptExport(episode, result);
    const timestampNote = result.chapterCount
      ? ` · 已按节目时间轴整理为 ${result.chapterCount} 个章节`
      : " · 节目未提供时间轴，已输出连续文稿";
    setTranscriptionStatus(`转写完成${timestampNote}：${transcriptPath}`, "success");
    notify(`转写完成：${transcriptPath}`);
    return transcriptPath;
  } catch (error) {
    setTranscriptionStatus(`转写失败：${error.message}`, "error");
    if (!propagate) notify(error.message);
    if (propagate) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function exportEpisodeTranscript(item, button = null, options = {}) {
  return transcribeEpisodeAudio(item, button, options);
}

function summaryProviderLabel() {
  const model = state.settings?.summaryModels?.find((item) => item.enabled);
  return model?.name || "当前 AI 模型";
}

function asrProviderLabel(providerId = state.settings?.asrProvider) {
  return {
    local_qwen: "本机 Qwen3-ASR（音频不外发）",
    qwen: "Qwen API",
    doubao: "豆包 API"
  }[providerId] || "当前 ASR 服务";
}

function ensureSummaryConsent() {
  if (state.settings?.summaryConsentAccepted) return Promise.resolve(true);
  const dialog = $("#summary-consent-dialog");
  $("#summary-consent-provider").textContent = summaryProviderLabel();
  $("#summary-consent-asr").textContent = transcriptSourceLabel();
  $("#summary-consent-comments").textContent = "评论不会被读取或发送。";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#summary-consent-confirm").onclick = async () => {
      try {
        state.settings = await send("update-settings", {
          settings: { summaryConsentAccepted: true }
        });
        finish(true);
        dialog.close();
      } catch (error) {
        notify(error.message);
      }
    };
    dialog.showModal();
  });
}

function ensureResummarize(episode) {
  const record = summaryRecordOf(episode);
  if (!record) return Promise.resolve(true);
  const dialog = $("#resummarize-dialog");
  const createdAt = record.createdAt
    ? new Date(record.createdAt).toLocaleString("zh-CN")
    : "此前";
  $("#resummarize-detail").textContent = `${createdAt} 已生成过总结。`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#resummarize-confirm").onclick = () => {
      finish(true);
      dialog.close();
    };
    dialog.showModal();
  });
}

async function summarizeTranscriptPath(
  transcriptPath,
  button = null,
  statusNode = null,
  { skipConsent = false, episodeId = "" } = {}
) {
  if (!transcriptPath) throw new Error("请先生成或选择 Markdown 转写稿");
  if (!skipConsent && !await ensureSummaryConsent()) return null;
  const originalText = button?.textContent;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "总结中…";
    }
    if (statusNode) statusNode.textContent = `${summaryProviderLabel()} 正在总结，请保持窗口打开`;
    setTranscriptionStatus(`${summaryProviderLabel()} AI 正在总结，请保持窗口打开`);
    const result = await send("summarize-transcript", {
      payload: { transcriptPath, episodeId }
    });
    const summaryPath = result.markdown;
    if (!summaryPath) throw new Error("AI 总结完成但未返回 Markdown 路径");
    state.currentSummaryPath = summaryPath;
    if (episodeId) {
      state.summaryHistory.set(episodeId, {
        markdown: summaryPath,
        provider: result.provider,
        model: result.model,
        modelName: result.modelName || result.model,
        createdAt: new Date().toISOString(),
        commentCount: 0
      });
      refreshSummaryIndicators(episodeId);
    }
    if (statusNode) statusNode.textContent = `总结完成：${summaryPath}`;
    setTranscriptionStatus(`AI 总结完成：${summaryPath}`, "success");
    notify("AI 总结完成");
    return result;
  } catch (error) {
    if (statusNode) statusNode.textContent = `总结失败：${error.message}`;
    setTranscriptionStatus(`AI 总结失败：${error.message}`, "error");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      const completed = episodeId && state.summaryHistory.has(episodeId);
      button.textContent = completed ? "已 AI 总结" : originalText;
      button.classList.toggle("is-complete", Boolean(completed));
    }
  }
}

async function summarizeEpisode(item, button = null) {
  const episode = await resolveEpisode(item);
  const eid = episodeIdOf(episode);
  if (!eid) throw new Error("无法识别需要总结的单集");
  if (!await ensureResummarize(episode)) return null;
  if (!await ensureSummaryConsent()) return null;
  const hasMatchingTranscript = (
    state.currentTranscriptPath
    && state.currentTranscriptEpisodeId === eid
  );
  const transcriptPath = hasMatchingTranscript
    ? state.currentTranscriptPath
    : "";
  let resolvedTranscriptPath = transcriptPath;
  if (!resolvedTranscriptPath) {
    const existing = await send("find-existing-transcript", {
      episodeId: eid
    });
    if (existing?.path) {
      resolvedTranscriptPath = rememberTranscriptExport(episode, {
        markdown: existing.path
      });
      setTranscriptionStatus(
        `已复用现有转写稿：${resolvedTranscriptPath}`,
        "success"
      );
    } else {
      resolvedTranscriptPath = await exportEpisodeTranscript(
        episode,
        button,
        { propagate: true }
      );
    }
  }
  return summarizeTranscriptPath(
    resolvedTranscriptPath,
    button,
    null,
    { skipConsent: true, episodeId: eid }
  );
}

async function openEpisode(item, { autoplay = true, navigate = false, record = null } = {}) {
  const version = ++selectionVersion;
  const owner = listeningOwner();
  const active = () => version === selectionVersion && owner === listeningOwner();
  const player = $("#audio");
  try {
    const episode = await resolveEpisode(item);
    if (!episode || !active()) return;
    if (!audioOf(episode)) return notify("这集暂时没有可播放的音频地址");
    const eid = episodeIdOf(episode);
    const same = eid && eid === episodeIdOf(state.current) && player.src && !player.error;
    if (!same) {
      record = record || state.listeningHistory.find(entry => entry.episode.eid === eid)
        || (owner && eid ? await window.xyzDesktop.history(eid) : null);
      if (!active()) return;
      if (state.currentTranscriptEpisodeId !== eid) {
        state.currentTranscriptPath = "";
        state.currentTranscriptEpisodeId = "";
        state.currentTranscriptSegments = [];
      }
      state.currentSummaryPath = summaryRecordOf(episode)?.markdown || "";
      setTranscriptionStatus();
      updatePlayerLinkButtons(episode);
      activatePlayer(episode, record);
      renderPlayerAnchors(episode);
    }
    if (navigate) setRoute("listen");
    if (autoplay) {
      if (player.ended) player.currentTime = 0;
      await player.play();
    }
  } catch (error) {
    if (active() && error.name !== "AbortError") notify(error.message || "音频暂时无法播放");
  }
}

async function toggleSubscription(item, button = null) {
  const pid = podcastIdOf(item);
  if (!pid) return notify("无法识别这个节目");
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "订阅中…";
  }
  try {
    await api("/subscription_update", { pid, mode: "ON" });
    state.subscribedPids.add(pid);
    subscriptionCache = null;
    if (button) button.textContent = "已订阅";
    notify("已加入订阅");
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    notify(error.message);
  }
}

function openLogin() {
  $("#login-error").textContent = "";
  $("#code-status").className = "code-status";
  $("#code-status").textContent = "在官方窗口完成登录后将自动返回。";
  $("#login-dialog").showModal();
}

function openLogoutConfirmation() {
  $("#logout-dialog").showModal();
}

async function confirmLogout() {
  const button = $("#logout-confirm");
  button.disabled = true;
  button.textContent = "正在退出…";
  try {
    await send("logout");
    $("#logout-dialog").close();
    markConnection();
    renderRoute();
    notify("已退出登录");
  } catch (error) {
    notify(`退出失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "确认退出登录";
  }
}

async function openOfficialLogin() {
  const errorNode = $("#login-error");
  const statusNode = $("#code-status");
  const button = $("#open-official-login-button");
  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "打开中…";
  statusNode.className = "code-status is-pending";
  statusNode.textContent = "正在打开小宇宙官方登录窗口…";
  try {
    await send("open-official-login");
    statusNode.className = "code-status is-success";
    statusNode.textContent = "请在官方窗口完成登录，客户端会自动保存登录状态。";
    notify("已打开小宇宙官方登录窗口");
  } catch (error) {
    statusNode.className = "code-status is-error";
    statusNode.textContent = "无法打开小宇宙官方登录窗口，请重试。";
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "重新打开官方登录";
  }
}

async function syncOfficialLogin() {
  const errorNode = $("#login-error");
  const statusNode = $("#code-status");
  const button = $("#sync-official-login-button");
  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "同步中…";
  statusNode.className = "code-status is-pending";
  statusNode.textContent = "正在验证小宇宙官方登录态…";
  try {
    await send("sync-official-login");
    statusNode.className = "code-status is-success";
    statusNode.textContent = "官方登录态已同步。";
    markConnection();
    $("#login-dialog").close();
    notify("登录成功");
    renderRoute();
  } catch (error) {
    statusNode.className = "code-status is-error";
    statusNode.textContent = "未能同步官方登录态。请确认已在官方窗口完成登录后重试。";
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "重新检测登录状态";
  }
}

function initPlayer() {
  const audio = $("#audio");
  const closePlayerMenu = () => $("#player-more-menu").removeAttribute("open");
  $("#play-button").addEventListener("click", () => {
    if (!audio.src) return state.auth ? setRoute("discover") : openLogin();
    if (audio.paused) audio.play().catch(error => notify(error.message)); else audio.pause();
  });
  $("#skip-back").addEventListener("click", () => skipBy(-15));
  $("#skip-forward").addEventListener("click", () => skipBy(30));
  $("#speed-button").addEventListener("change", event => {
    if (sourceReady) startedListening = true;
    audio.playbackRate = Number(event.currentTarget.value);
  });
  const volume = $("#volume-slider");
  const applyVolume = () => {
    audio.volume = Number(volume.value) / 100;
    $("#volume-value").value = volume.value + "%";
    $("#speaker-symbol").setAttribute("href", "symbols.svg#" + (audio.volume ? "volume" : "mute"));
  };
  const savedVolume = localStorage.getItem("player-volume");
  if (savedVolume !== null && Number.isFinite(Number(savedVolume))) volume.value = savedVolume;
  applyVolume();
  volume.addEventListener("input", applyVolume);
  volume.addEventListener("change", () => localStorage.setItem("player-volume", volume.value));
  $("#view-podcast-button").addEventListener("click", () => { closePlayerMenu(); if (state.current) openPodcast(state.current); });
  $("#download-audio-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? downloadEpisodeAudio(state.current) : notify("当前没有正在播放的单集");
  });
  $("#transcribe-audio-button").addEventListener("click", (event) => {
    closePlayerMenu();
    return state.current ? exportEpisodeTranscript(state.current, event.currentTarget) : notify("当前没有正在播放的单集");
  });
  $("#summarize-button").addEventListener("click", (event) => {
    if (!state.current) return notify("当前没有正在播放的单集");
    summarizeEpisode(state.current, event.currentTarget).catch((error) => notify(error.message));
  });
  $("#copy-episode-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyEpisodeLink(state.current) : notify("当前没有正在播放的单集");
  });
  $("#copy-podcast-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyPodcastLink(state.current) : notify("当前没有正在播放的节目");
  });
  audio.addEventListener("loadedmetadata", () => {
    renderPlayerAnchors(state.current);
  });
  XYZPlayerSeek.attach({
    audio,
    input: $("#progress"),
    current: $("#current-time"),
    duration: $("#duration"),
    format: formatTime,
    getDuration: () => durationOf(state.current),
    onTime: value => { updateActiveProgressAnchor(value); drawWaveform(); }
  });
  audio.addEventListener("error", () => notify("音频暂时无法加载，请检查网络后重试"));
}

async function init() {
  const [auth, settings, history] = await Promise.all([
    send("restore-auth"),
    send("get-settings"),
    send("get-summary-history")
  ]);
  state.auth = auth;
  state.settings = settings;
  state.summaryHistory = new Map(Object.entries(history || {}));
  $("#back-button").hidden = true;
  markConnection(); initPlayer(); initializeListening(); initializeSummaryModelDialog(); renderRoute();
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setRoute(item.dataset.route)));
  initializeLibrary();
  $("#back-button").addEventListener("click", () => {
    goBack();
  });
  $("#account-button").addEventListener("click", () => {
    if (!state.auth) return openLogin();
    state.settingsTab = "account";
    setRoute("settings");
  });
  $("#logout-confirm").addEventListener("click", confirmLogout);
  $("#open-official-login-button").addEventListener("click", openOfficialLogin);
  $("#sync-official-login-button").addEventListener("click", syncOfficialLogin);
  window.xyzDesktop.onStorage(({ changes, areaName }) => {
    if (areaName !== "session" || !changes[AUTH_SESSION_KEY]) return;
    const next = changes[AUTH_SESSION_KEY].newValue || null;
    const previousOwner = listeningOwner();
    state.auth = next;
    markConnection();
    if (previousOwner !== listeningOwner()) {
      clearListeningSession();
      resetLibrary();
      state.podcastView = null; state.episodeView = null;
      state.searchRequest++; state.searchResultsByType = { episode: null, podcast: null };
      state.searchErrorsByType = {};
      setRoute("listen");
      if (next) loadListeningHistory().catch(error => notify(error.message));
    }
    if (next && $("#login-dialog").open) $("#login-dialog").close();
  });
  loadListeningHistory().catch(error => notify(error.message));
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("toggle", event => {
    const menu = event.target;
    if (!menu.matches?.(".action-menu") || !menu.open) return;
    const bounds = menu.querySelector("summary").getBoundingClientRect();
    const available = innerHeight - bounds.bottom;
    menu.classList.toggle("opens-up", available < menu.querySelector(".action-menu-panel").offsetHeight + 8 && bounds.top > available);
  }, true);
  document.addEventListener("click", (event) => {
    const activeMenu = event.target.closest(".action-menu");
    $$(".action-menu[open]").forEach((menu) => {
      if (menu !== activeMenu) menu.removeAttribute("open");
    });
  });
}

init().catch((error) => notify(error.message));
