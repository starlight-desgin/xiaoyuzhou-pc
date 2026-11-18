const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { DEFAULT_SETTINGS, ASR_SETTINGS_VERSION, TRANSCRIPT_SOURCE_SETTINGS_VERSION,
  SUMMARY_SETTINGS_VERSION, normalizeSummarySettings } = require("./service-settings.cjs");

const AUTH_KEY = "xyzAuth";
const AUTH_SESSION_KEY = "xyzAuthSession";
const SIGNED_OUT_KEY = "xyzSignedOut";
const SETTINGS_KEY = "xyzSettings";
const SUMMARY_HISTORY_KEY = "xyzSummaryHistory";

const UPSTREAM = {
  api: "https://api.xiaoyuzhoufm.com",
  auth: "https://podcaster-api.xiaoyuzhoufm.com"
};
const OFFICIAL_LOGIN_URL = "https://accounts.xiaoyuzhoufm.com/login?clientId=podcaster-platform&redirectURL=https%3A%2F%2Fpodcaster.xiaoyuzhoufm.com%2Fpodcast&hideWeChatLogin=false";

const API_ENDPOINTS = {
  "/discovery": "/v1/discovery-feed/list",
  "/editor_pick": "/v1/editor-pick/list",
  "/top_list": "/v1/top-list/get",
  "/search": "/v1/search/create",
  "/episode_detail": "/v1/episode/get",
  "/episode_list": "/v1/episode/list",
  "/subscription": "/v1/subscription/list",
  "/subscription_update": "/v1/subscription/update"
};

const APP_HEADERS = {
  "Accept": "*/*",
  "Accept-Language": "zh-Hans-CN,zh-Hant-TW;q=0.9,en;q=0.8",
  "Connection": "keep-alive",
  "App-BuildNo": "1576",
  "App-Version": "2.57.1",
  "BundleID": "app.podcast.cosmos",
  "Content-Type": "application/json",
  "Market": "AppStore",
  "Manufacturer": "Apple",
  "Model": "iPhone14,2",
  "OS": "ios",
  "OS-Version": "17.4.1",
  "User-Agent": "Xiaoyuzhou/2.57.1 (build:1576; iOS 17.4.1)",
  "WifiConnected": "true",
  "abtest-info": "{\"old_user_discovery_feed\":\"enable\"}",
  "app-permissions": "4",
  "x-custom-xiaoyuzhou-app-dev": ""
};

// The two encrypted namespaces retain the keys used by earlier desktop releases.
function storageArea(store, areaName, publish) {
  const key = areaName === "local" ? "extensionLocal" : "extensionSession";
  function apply(next, changes) {
    store.set(key, next);
    publish({ areaName, changes });
  }
  return {
    read(field, fallback = null) { return store.get(key, {})[field] ?? fallback; },
    set(fields) {
      const previous = store.get(key, {});
      const changes = Object.fromEntries(Object.entries(fields).map(([field, newValue]) =>
        [field, { oldValue: previous[field], newValue }]));
      apply({ ...previous, ...fields }, changes);
    },
    remove(field) {
      const { [field]: oldValue, ...next } = store.get(key, {});
      if (oldValue !== undefined) apply(next, { [field]: { oldValue } });
    }
  };
}

function createBackend({ store, fetch, publish, nativeRequest, nativeHostPath, download,
  officialLogin, cookies: cookiesForDomain, clearOfficialLogin, showWindow }) {
  const local = storageArea(store, "local", publish);
  const session = storageArea(store, "session", publish);
  let authGeneration = 0;
  let refreshInFlight = null;
  let loginInFlight = null;

  async function getSettings() {
    const settings = local.read(SETTINGS_KEY, {});
    const downloads = path.join(os.homedir(), "Downloads");
    let merged = { ...DEFAULT_SETTINGS,
      audioDownloadPath: path.join(downloads, "小宇宙音频"),
      transcriptDownloadPath: path.join(downloads, "小宇宙转写稿"),
      summaryDownloadPath: path.join(downloads, "小宇宙转写稿"), ...settings };
    let changed = false;
    if ("apiMode" in merged || "proxyBaseUrl" in merged) {
      delete merged.apiMode;
      delete merged.proxyBaseUrl;
      changed = true;
    }
    if ((settings.asrSettingsVersion || 0) < ASR_SETTINGS_VERSION) {
      merged = {
        ...merged,
        asrSettingsVersion: ASR_SETTINGS_VERSION,
        qwenAsrEndpoint: DEFAULT_SETTINGS.qwenAsrEndpoint,
        qwenAsrModel: DEFAULT_SETTINGS.qwenAsrModel
      };
      changed = true;
    }
    if ((settings.transcriptSourceSettingsVersion || 0) < TRANSCRIPT_SOURCE_SETTINGS_VERSION) {
      merged = {
        ...merged,
        transcriptSourceSettingsVersion: TRANSCRIPT_SOURCE_SETTINGS_VERSION,
        transcriptSource: DEFAULT_SETTINGS.transcriptSource
      };
      changed = true;
    }
    if ((settings.summarySettingsVersion || 0) < SUMMARY_SETTINGS_VERSION) changed = true;
    merged = normalizeSummarySettings(merged);
    if (changed) await local.set({ [SETTINGS_KEY]: merged });
    return merged;
  }

  async function getAuth() {
    const auth = session.read(AUTH_SESSION_KEY);
    return auth?.accessToken ? auth : null;
  }

  async function saveAuth(auth) {
    const { expiresAt, ...saved } = auth; // Older desktop builds used a local idle timer.
    await session.set({ [AUTH_SESSION_KEY]: saved });
    return saved;
  }

  async function authWithDeviceId(auth) {
    if (!auth || auth.deviceId) return auth;
    return saveAuth({ ...auth, deviceId: randomUUID() });
  }

  async function clearAuth() {
    authGeneration++;
    refreshInFlight = null;
    loginInFlight = null;
    await Promise.all([
      local.set({ [SIGNED_OUT_KEY]: true }),
      local.remove(AUTH_KEY),
      session.remove(AUTH_SESSION_KEY)
    ]);
  }

  async function restoreAuth() {
    const cached = await getAuth();
    if (cached) return cached;
    if (local.read(SIGNED_OUT_KEY)) return null;
    // Recover a sign-in already completed in this client's own official login window.
    try { return await syncOfficialLogin(); } catch { return null; }
  }

  function upstreamUrl(path) {
    const root = path.startsWith("/v1/auth/") ? UPSTREAM.auth : UPSTREAM.api;
    return `${root}${path.replace(/^\/auth/, "")}`;
  }

  function withAppHeaders(auth, extra = {}) {
    return {
      ...APP_HEADERS,
      "Local-Time": new Date().toISOString(),
      "Timezone": "Asia/Shanghai",
      ...(auth?.accessToken ? { "x-jike-access-token": auth.accessToken } : {}),
      ...(auth?.deviceId ? { "x-jike-device-id": auth.deviceId } : {}),
      ...extra
    };
  }

  function safeDownloadFilename(filename) {
    const fallback = "xiaoyuzhou-audio.m4a";
    const clean = String(filename || fallback)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    return clean ? clean.slice(0, 180) : fallback;
  }

  function transcriptBaseName(filename) {
    return safeDownloadFilename(filename)
      .replace(/\.(?:mp3|m4a|wav|ogg|flac|aac|aiff|wma|webm)$/i, "");
  }

  function normalizeDownloadFolder(folder) {
    const value = String(folder ?? "").trim().replace(/\\/g, "/");
    if (!value) return "";
    if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) {
      throw new Error("浏览器回退子目录必须使用相对路径");
    }
    const parts = value.split("/").filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === "..")) {
      throw new Error("下载目录不能包含 . 或 ..");
    }
    return parts.map((part) => part.replace(/[\\/:*?"<>|]/g, "_").trim()).filter(Boolean).join("/");
  }

  function normalizeAbsolutePath(path, label) {
    const value = String(path ?? "").trim();
    if (!value) return "";
    const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
    if (!value.startsWith("/") && !value.startsWith("~/") && !isWindowsPath) {
      throw new Error(`${label}必须是系统绝对路径`);
    }
    return isWindowsPath
      ? value.replace(/[\\/]+$/, "")
      : value.replace(/\/+$/, "") || "/";
  }

  async function getNativeHostStatus() {
    try {
      const details = await nativeRequest({ action: "ping" });
      return { ...details, platform: "windows", available: true, hostPath: nativeHostPath };
    } catch (error) {
      return { platform: "windows", available: false, hostPath: nativeHostPath, error: error.message };
    }
  }

  async function getSummaryHistory() {
    const value = local.read(SUMMARY_HISTORY_KEY, {});
    return Object.fromEntries(
      Object.entries(value || {})
        .filter(([eid, item]) => (
          /^[A-Za-z0-9_-]+$/.test(eid)
          && item
          && typeof item === "object"
          && String(item.markdown || "")
        ))
        .slice(-500)
    );
  }

  async function recordSummaryHistory(episodeId, result) {
    const eid = String(episodeId || "");
    if (!/^[A-Za-z0-9_-]+$/.test(eid)) return;
    const history = await getSummaryHistory();
    history[eid] = {
      markdown: String(result.markdown || ""),
      provider: String(result.provider || ""),
      model: String(result.model || ""),
      modelName: String(result.modelName || result.model || ""),
      createdAt: new Date().toISOString(),
      commentCount: Math.max(0, Number(result.commentCount) || 0)
    };
    const entries = Object.entries(history)
      .sort((left, right) => (
        String(left[1].createdAt).localeCompare(String(right[1].createdAt))
      ))
      .slice(-500);
    await local.set({
      [SUMMARY_HISTORY_KEY]: Object.fromEntries(entries)
    });
  }

  async function downloadAudio({ url, filename }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("音频地址无效");
    }
    if (parsed.protocol !== "https:") throw new Error("只支持下载 HTTPS 音频");
    const settings = await getSettings();
    const absolutePath = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径");
    if (absolutePath) {
      return nativeRequest({
        action: "download_audio",
        directory: absolutePath,
        url: parsed.toString(),
        filename: safeDownloadFilename(filename)
      });
    }
    const folder = normalizeDownloadFolder(settings.downloadFolder);
    const targetName = safeDownloadFilename(filename);
    return download({
      url: parsed.toString(),
      filename: folder ? `${folder}/${targetName}` : targetName,
      conflictAction: "uniquify",
      saveAs: Boolean(settings.downloadSaveAs)
    });
  }

  function transcriptDirectoryFromSettings(settings) {
    return normalizeAbsolutePath(settings.transcriptDownloadPath, "转写稿保存路径")
      || "~/Downloads/小宇宙转写稿";
  }

  function summaryDirectoryFromSettings(settings) {
    return normalizeAbsolutePath(settings.summaryDownloadPath, "AI 总结稿保存路径")
      || transcriptDirectoryFromSettings(settings);
  }

  async function transcribeAudio({
    url,
    filename,
    baseName,
    language = "zh",
    episodeId = "",
    episodeUrl = "",
    timeline = []
  }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("音频地址无效");
    }
    if (parsed.protocol !== "https:") throw new Error("只支持转写 HTTPS 音频");
    const settings = await getSettings();
    const audioDirectory = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径")
      || "~/Downloads/小宇宙音频";
    const transcriptDirectory = transcriptDirectoryFromSettings(settings);
    return nativeRequest({
      action: "transcribe_remote",
      provider: settings.asrProvider,
      url: parsed.toString(),
      audioFilename: safeDownloadFilename(filename),
      baseName: transcriptBaseName(baseName || filename),
      audioDirectory,
      transcriptDirectory,
      language,
      episodeId: String(episodeId || ""),
      episodeUrl: String(episodeUrl || ""),
      timeline: Array.isArray(timeline) ? timeline.slice(0, 100) : [],
      localQwenModel: settings.localQwenModel,
      qwenEndpoint: settings.qwenAsrEndpoint,
      qwenModel: settings.qwenAsrModel,
      doubaoEndpoint: settings.doubaoAsrEndpoint,
      doubaoResourceId: settings.doubaoAsrResourceId
    });
  }

  async function importSummaryTranscript() {
    const settings = await getSettings();
    return nativeRequest({
      action: "import_markdown_file",
      prompt: "请选择需要 AI 总结的 Markdown 转写稿",
      transcriptDirectory: transcriptDirectoryFromSettings(settings)
    });
  }

  async function findExistingTranscript(episodeId) {
    const settings = await getSettings();
    return nativeRequest({
      action: "find_existing_transcript",
      episodeId: String(episodeId || ""),
      transcriptDirectory: transcriptDirectoryFromSettings(settings)
    });
  }

  async function summarizeTranscript({ transcriptPath, episodeId = "" }) {
    const settings = await getSettings();
    const providerSettings = settings.summaryModels.find((item) => item.enabled);
    const prompt = settings.summaryPromptVersions.find(
      (item) => item.id === settings.activeSummaryPromptId
    );
    if (!providerSettings?.endpoint || !providerSettings?.model) {
      throw new Error("请先启用一个 AI 总结模型");
    }
    if (!prompt?.content) throw new Error("当前 AI 总结 Prompt 无效");
    const result = await nativeRequest({
      action: "summarize_transcript",
      transcriptPath: String(transcriptPath || ""),
      transcriptDirectory: transcriptDirectoryFromSettings(settings),
      summaryDirectory: summaryDirectoryFromSettings(settings),
      provider: providerSettings.provider,
      endpoint: providerSettings.endpoint,
      model: providerSettings.model,
      modelName: providerSettings.name,
      credentialId: providerSettings.id,
      prompt: prompt.content,
      promptId: prompt.id,
      comments: []
    });
    const output = {
      ...result,
      commentCount: 0,
      commentTotalCount: 0,
      commentFilteredCount: 0,
      commentWarning: ""
    };
    await recordSummaryHistory(episodeId, output);
    return output;
  }

  async function requestJson({ path, method = "POST", body, auth, retry = true }) {
    const directPath = API_ENDPOINTS[path] || path;
    const url = new URL(upstreamUrl(directPath));
    if (method === "GET" && body && typeof body === "object") {
      for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
    }
    if (path === "/discovery" && method === "POST") body = { returnAll: "false", ...(body || {}) };
    const headers = withAppHeaders(auth);
    if (auth?.refreshToken && path === "/app_auth_tokens.refresh") {
      headers["x-jike-refresh-token"] = auth.refreshToken;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {})
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (response.status === 401 && retry && auth?.refreshToken) {
      const refreshed = await refreshToken(auth);
      return requestJson({ path, method, body, auth: refreshed, retry: false });
    }
    if (!response.ok) {
      const error = new Error(data?.message || data?.msg || `请求失败（${response.status}）`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { data, headers: response.headers };
  }

  async function refreshToken(auth) {
    const current = await getAuth();
    if (!current || current.deviceId !== auth.deviceId) throw new Error("账号已切换");
    if (current.accessToken !== auth.accessToken || current.refreshToken !== auth.refreshToken) return current;
    if (refreshInFlight) return refreshInFlight;
    const job = renewToken(current, authGeneration);
    refreshInFlight = job;
    try { return await job; } finally { if (refreshInFlight === job) refreshInFlight = null; }
  }

  async function renewToken(auth, generation) {
    const url = upstreamUrl("/app_auth_tokens.refresh");
    const response = await fetch(url, {
      method: "POST",
      headers: withAppHeaders(auth, { "x-jike-refresh-token": auth.refreshToken })
    });
    if (generation !== authGeneration) throw new Error("账号已切换");
    if (response.status === 401 || response.status === 403) {
      await clearAuth();
      throw new Error("小宇宙登录已失效，请重新登录");
    }
    if (!response.ok) throw new Error("暂时无法续期，请稍后重试");
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (generation !== authGeneration) throw new Error("账号已切换");
    const next = {
      ...auth,
      accessToken: json?.data?.accessToken || json?.data?.access_token || json?.data?.["x-jike-access-token"] || json?.["x-jike-access-token"] || json?.accessToken || response.headers.get("x-jike-access-token"),
      refreshToken: json?.data?.refreshToken || json?.data?.refresh_token || json?.data?.["x-jike-refresh-token"] || json?.["x-jike-refresh-token"] || json?.refreshToken || response.headers.get("x-jike-refresh-token") || auth.refreshToken
    };
    if (!next.accessToken) throw new Error("登录续期暂未完成，请稍后重试");
    return saveAuth(next);
  }

  async function openOfficialLogin() {
    await officialLogin(OFFICIAL_LOGIN_URL);
    return { opened: true };
  }

  async function syncOfficialLogin() {
    if (loginInFlight) return loginInFlight;
    const job = validateOfficialLogin(authGeneration);
    loginInFlight = job;
    try { return await job; } finally { if (loginInFlight === job) loginInFlight = null; }
  }

  async function validateOfficialLogin(generation) {
    const cookies = await cookiesForDomain({ domain: "xiaoyuzhoufm.com" });
    const accessToken = cookies.find((cookie) => cookie.name === "x-jike-access-token")?.value;
    const refreshToken = cookies.find((cookie) => cookie.name === "x-jike-refresh-token")?.value;
    if (!accessToken || !refreshToken) {
      throw new Error("请先在小宇宙官方窗口完成登录");
    }

    const deviceId = randomUUID();
    const response = await fetch("https://podcaster-api.xiaoyuzhoufm.com/v1/profile/get", {
      headers: {
        ...APP_HEADERS,
        Origin: "https://podcaster.xiaoyuzhoufm.com",
        "x-jike-access-token": accessToken,
        "x-jike-device-id": deviceId
      }
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      throw new Error(data?.message || data?.msg || "未能验证登录状态，请在官方窗口重新登录");
    }
    if (generation !== authGeneration) throw new Error("账号已切换");
    authGeneration++;
    refreshInFlight = null;
    const auth = await saveAuth({
      user: data?.data?.user || data?.data?.data || data?.data || data?.user || null,
      accessToken,
      refreshToken,
      deviceId
    });
    await local.remove(SIGNED_OUT_KEY);
    return auth;
  }

  async function fetchApi({ endpoint, method = "POST", body = {} }) {
    if (!Object.hasOwn(API_ENDPOINTS, endpoint) || !["GET", "POST"].includes(method)) throw new Error("未知的小宇宙接口");
    const auth = await authWithDeviceId(await getAuth());
    if (!auth?.accessToken) throw new Error("请先登录小宇宙");
    const { data } = await requestJson({ path: endpoint, method, body, auth });
    return data;
  }

  async function updateSettings(next) {
    const requestedPrompts = next?.summaryPromptVersions;
    if (requestedPrompts && (!Array.isArray(requestedPrompts) || requestedPrompts.length > 20)) {
      throw new Error("AI 总结 Prompt 版本数量不能超过 20");
    }
    if (requestedPrompts?.some((prompt) => String(prompt?.content || "").length > 20_000)) {
      throw new Error("单个 AI 总结 Prompt 不能超过 20000 字符");
    }
    let settings = { ...DEFAULT_SETTINGS, ...(await getSettings()), ...next };
    delete settings.apiMode;
    delete settings.proxyBaseUrl;
    settings.asrSettingsVersion = ASR_SETTINGS_VERSION;
    settings.transcriptSourceSettingsVersion = TRANSCRIPT_SOURCE_SETTINGS_VERSION;
    settings = normalizeSummarySettings(settings);
    settings.downloadFolder = normalizeDownloadFolder(settings.downloadFolder);
    settings.transcriptFolder = normalizeDownloadFolder(settings.transcriptFolder);
    settings.audioDownloadPath = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径");
    settings.transcriptDownloadPath = normalizeAbsolutePath(settings.transcriptDownloadPath, "转写稿保存路径");
    settings.summaryDownloadPath = normalizeAbsolutePath(settings.summaryDownloadPath, "AI 总结稿保存路径");
    settings.downloadSaveAs = Boolean(settings.downloadSaveAs);
    settings.transcriptSource = "asr";
    settings.asrProvider = ["local_qwen", "qwen", "doubao"].includes(settings.asrProvider)
      ? settings.asrProvider
      : "qwen";
    settings.localQwenModel = [
      "Qwen/Qwen3-ASR-0.6B",
      "Qwen/Qwen3-ASR-1.7B"
    ].includes(settings.localQwenModel)
      ? settings.localQwenModel
      : "Qwen/Qwen3-ASR-0.6B";
    for (const config of settings.summaryModels) {
      let endpoint;
      try {
        endpoint = new URL(config.endpoint);
      } catch {
        throw new Error(`${config.name} 的 AI 总结接口地址无效`);
      }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
        throw new Error(`${config.name} 的 AI 总结接口必须使用无凭据的 HTTPS 地址`);
      }
      if (!String(config.model || "").trim()) throw new Error(`${config.name} 的模型 ID 不能为空`);
    }
    if (settings.audioDownloadPath || settings.transcriptDownloadPath || settings.summaryDownloadPath) {
      await nativeRequest({
        action: "ensure_directories",
        directories: [
          settings.audioDownloadPath,
          settings.transcriptDownloadPath,
          settings.summaryDownloadPath
        ].filter(Boolean)
      });
    }
    await local.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "open-app":
        showWindow();
        return { opened: true };
      case "get-auth":
        return getAuth();
      case "restore-auth":
        return restoreAuth();
      case "logout":
        await clearAuth();
        await clearOfficialLogin();
        return null;
      case "get-settings":
        return getSettings();
      case "get-summary-history":
        return getSummaryHistory();
      case "update-settings":
        return updateSettings(message.settings);
      case "open-official-login":
        return openOfficialLogin();
      case "sync-official-login":
        return syncOfficialLogin();
      case "api":
        return fetchApi(message.payload);
      case "download-audio":
        return downloadAudio(message.payload);
      case "transcribe-audio":
        return transcribeAudio(message.payload);
      case "find-existing-transcript":
        return findExistingTranscript(message.episodeId);
      case "get-native-host-status":
        return getNativeHostStatus();
      case "save-asr-credentials":
        return nativeRequest({
          action: "save_asr_credentials",
          credentials: message.credentials || {},
          clearKeys: message.clearKeys || []
        });
      case "save-summary-credentials":
        return nativeRequest({
          action: "save_summary_credentials",
          credentials: message.credentials || {},
          clearKeys: message.clearKeys || []
        });
      case "save-summary-model-credential":
        return nativeRequest({
          action: "save_summary_model_credential",
          modelId: message.modelId,
          apiKey: message.apiKey || "",
          clear: Boolean(message.clear)
        });
      case "get-summary-model-credential-status":
        return nativeRequest({
          action: "get_summary_model_credential_status",
          models: message.models || []
        });
      case "test-summary-model":
        return nativeRequest({
          action: "test_summary_model",
          provider: message.model?.provider,
          endpoint: message.model?.endpoint,
          model: message.model?.model,
          credentialId: message.model?.id,
          apiKey: message.apiKey || ""
        });
      case "import-summary-transcript":
        return importSummaryTranscript();
      case "summarize-transcript":
        return summarizeTranscript(message.payload || {});
      case "choose-native-directory":
        return nativeRequest({ action: "choose_directory", prompt: message.prompt || "请选择保存目录" });
      default:
        throw new Error("未知操作");
    }
  }

  return { request: handleMessage };
}

module.exports = { createBackend };
