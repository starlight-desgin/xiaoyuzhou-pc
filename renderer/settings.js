function summaryProviderMeta(providerId) {
  return SUMMARY_PROVIDERS.find((provider) => provider.id === providerId)
    || SUMMARY_PROVIDERS[0];
}

function summaryModelById(id) {
  return state.summaryModelDrafts.find((model) => model.id === id);
}

function summaryModelHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "接口地址无效";
  }
}

function renderSummaryModelStatus() {
  const node = $("#summary-provider-status");
  if (!node) return;
  const enabled = state.summaryModelDrafts.filter((model) => model.enabled);
  const configured = enabled.filter((model) => state.summaryModelCredentialStatus[model.id]);
  node.classList.toggle("is-ready", enabled.length > 0 && configured.length > 0);
  node.textContent = !enabled.length
    ? "尚未启用模型，AI 总结暂不可用"
    : `已启用 ${enabled.length} 个模型 · ${configured.length} 个已有凭据 · 默认：${enabled[0].name}`;
}

function renderSummaryModelList() {
  const holder = $("#summary-model-list");
  if (!holder) return;
  const defaultModel = state.summaryModelDrafts.find((model) => model.enabled);
  holder.innerHTML = state.summaryModelDrafts.length
    ? state.summaryModelDrafts.map((model, index) => {
        const provider = summaryProviderMeta(model.provider);
        const configured = Boolean(state.summaryModelCredentialStatus[model.id]);
        return `<article class="summary-model-row${model.enabled ? "" : " is-disabled"}" draggable="true" data-summary-model-id="${esc(model.id)}">
          <span class="summary-model-drag" aria-hidden="true">⠿</span>
          <button class="summary-model-main" type="button" data-edit-summary-model="${esc(model.id)}">
            <strong>${esc(model.name)}${defaultModel?.id === model.id ? '<span class="default-model-badge">默认</span>' : ""}</strong>
            <span>${esc(provider.label)} · ${esc(model.model)} · ${esc(summaryModelHost(model.endpoint))}</span>
          </button>
          <span class="model-key-state${configured ? " is-ready" : ""}">${configured ? "已配置" : "缺少 Key"}</span>
          <label class="model-toggle" aria-label="${esc(`${model.name}启用状态`)}">
            <input type="checkbox" data-toggle-summary-model="${esc(model.id)}" ${model.enabled ? "checked" : ""} />
            <span></span>
          </label>
          <div class="model-order-actions">
            <button type="button" data-move-summary-model="${esc(model.id)}" data-direction="-1" aria-label="上移" ${index === 0 ? "disabled" : ""}>↑</button>
            <button type="button" data-move-summary-model="${esc(model.id)}" data-direction="1" aria-label="下移" ${index === state.summaryModelDrafts.length - 1 ? "disabled" : ""}>↓</button>
          </div>
          <button class="model-delete-button" type="button" data-delete-summary-model="${esc(model.id)}" aria-label="删除模型">×</button>
        </article>`;
      }).join("")
    : `<div class="empty">还没有 AI 总结模型。点击“添加模型”开始配置。</div>`;
  renderSummaryModelStatus();
  bindSummaryModelList();
}

async function persistSummaryModels() {
  state.settings = await send("update-settings", {
    settings: {
      summaryModels: state.summaryModelDrafts.map((model) => ({ ...model }))
    }
  });
  state.summaryModelDrafts = state.settings.summaryModels.map((model) => ({ ...model }));
}

function snapshotSummaryModels() {
  return state.summaryModelDrafts.map((model) => ({ ...model }));
}

async function commitSummaryModelMutation(previousModels) {
  if (state.summaryModelMutationPending) {
    throw new Error("模型配置正在保存，请稍后再试");
  }
  state.summaryModelMutationPending = true;
  try {
    await persistSummaryModels();
  } catch (error) {
    state.summaryModelDrafts = previousModels;
    throw error;
  } finally {
    state.summaryModelMutationPending = false;
    renderSummaryModelList();
  }
}

async function refreshSummaryModelCredentialStatus() {
  if (!state.summaryModelDrafts.length) {
    state.summaryModelCredentialStatus = {};
    renderSummaryModelList();
    return;
  }
  try {
    const result = await send("get-summary-model-credential-status", {
      models: state.summaryModelDrafts.map(({ id, provider }) => ({ id, provider }))
    });
    state.summaryModelCredentialStatus = result.configured || {};
  } catch {
    state.summaryModelCredentialStatus = {};
  }
  renderSummaryModelList();
}

function openSummaryModelEditor(modelId = "") {
  if (!modelId && state.summaryModelDrafts.length >= 20) {
    notify("最多配置 20 个 AI 总结模型");
    return;
  }
  const existing = summaryModelById(modelId);
  const provider = existing?.provider || "qwen";
  const defaults = SUMMARY_PROVIDER_DEFAULTS[provider];
  const model = existing || {
    id: `model-${crypto.randomUUID()}`,
    name: "新模型",
    provider,
    endpoint: defaults.endpoint,
    model: defaults.model,
    enabled: true
  };
  state.summaryModelEditorId = model.id;
  $("#summary-model-dialog-title").textContent = existing ? "编辑模型" : "添加模型";
  $("#summary-model-id").value = model.id;
  $("#summary-model-name").value = model.name;
  $("#summary-model-provider").value = model.provider;
  $("#summary-model-endpoint").value = model.endpoint;
  $("#summary-model-model").value = model.model;
  $("#summary-model-api-key").value = "";
  $("#summary-model-enabled").checked = model.enabled;
  $("#summary-model-status").className = "code-status";
  $("#summary-model-status").textContent = state.summaryModelCredentialStatus[model.id]
    ? "API Key 已安全保存；留空不会覆盖。"
    : "尚未保存 API Key。";
  $("#clear-summary-model-key").disabled = !state.summaryModelCredentialStatus[model.id];
  $("#summary-model-dialog").showModal();
}

function summaryModelFromEditor() {
  const provider = $("#summary-model-provider").value;
  return {
    id: $("#summary-model-id").value,
    name: $("#summary-model-name").value.trim(),
    provider,
    endpoint: $("#summary-model-endpoint").value.trim(),
    model: $("#summary-model-model").value.trim(),
    enabled: $("#summary-model-enabled").checked
  };
}

function validatedSummaryModelFromEditor() {
  const model = summaryModelFromEditor();
  if (!model.name) throw new Error("请输入模型名称");
  if (!model.endpoint) throw new Error("请输入 Base URL");
  if (!model.model) throw new Error("请输入 Model ID");
  let endpoint;
  try {
    endpoint = new URL(model.endpoint);
  } catch {
    throw new Error("Base URL 格式无效");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("Base URL 必须使用无凭据的 HTTPS 地址");
  }
  return model;
}

async function saveSummaryModelEditor({ close = true } = {}) {
  const model = validatedSummaryModelFromEditor();
  const apiKey = $("#summary-model-api-key").value.trim();
  const previousModels = snapshotSummaryModels();
  const index = state.summaryModelDrafts.findIndex((item) => item.id === model.id);
  if (index >= 0) state.summaryModelDrafts[index] = model;
  else state.summaryModelDrafts.push(model);
  await commitSummaryModelMutation(previousModels);
  if (apiKey) {
    try {
      const result = await send("save-summary-model-credential", {
        modelId: model.id,
        apiKey
      });
      state.summaryModelCredentialStatus[model.id] = Boolean(result.configured);
    } catch (error) {
      const failedModels = snapshotSummaryModels();
      state.summaryModelDrafts = previousModels;
      try {
        await commitSummaryModelMutation(failedModels);
      } catch (rollbackError) {
        throw new Error(`${error.message}；恢复原模型配置失败：${rollbackError.message}`);
      }
      throw error;
    }
  }
  renderSummaryModelList();
  if (close) $("#summary-model-dialog").close();
  return model;
}

function bindSummaryModelList() {
  $$("[data-edit-summary-model]").forEach((button) => button.addEventListener("click", () => {
    openSummaryModelEditor(button.dataset.editSummaryModel);
  }));
  $$("[data-toggle-summary-model]").forEach((input) => input.addEventListener("change", async () => {
    if (state.summaryModelMutationPending) return renderSummaryModelList();
    const previousModels = snapshotSummaryModels();
    const model = summaryModelById(input.dataset.toggleSummaryModel);
    if (!model) return;
    model.enabled = input.checked;
    try {
      await commitSummaryModelMutation(previousModels);
    } catch (error) {
      notify(error.message);
    }
  }));
  $$("[data-move-summary-model]").forEach((button) => button.addEventListener("click", async () => {
    if (state.summaryModelMutationPending) return;
    const previousModels = snapshotSummaryModels();
    const index = state.summaryModelDrafts.findIndex((item) => item.id === button.dataset.moveSummaryModel);
    const target = index + Number(button.dataset.direction);
    if (index < 0 || target < 0 || target >= state.summaryModelDrafts.length) return;
    [state.summaryModelDrafts[index], state.summaryModelDrafts[target]] = [
      state.summaryModelDrafts[target],
      state.summaryModelDrafts[index]
    ];
    try {
      await commitSummaryModelMutation(previousModels);
    } catch (error) {
      notify(error.message);
    }
  }));
  $$("[data-delete-summary-model]").forEach((button) => button.addEventListener("click", async () => {
    if (state.summaryModelMutationPending) return;
    const model = summaryModelById(button.dataset.deleteSummaryModel);
    if (state.summaryModelDrafts.length === 1) return notify("至少保留一个模型配置");
    if (!model || !confirm(`确认删除模型“${model.name}”？`)) return;
    const previousModels = snapshotSummaryModels();
    state.summaryModelDrafts = state.summaryModelDrafts.filter((item) => item.id !== model.id);
    try {
      await commitSummaryModelMutation(previousModels);
      try {
        await send("save-summary-model-credential", { modelId: model.id, clear: true });
      } catch (error) {
        const deletedModels = snapshotSummaryModels();
        state.summaryModelDrafts = previousModels;
        try {
          await commitSummaryModelMutation(deletedModels);
        } catch (rollbackError) {
          throw new Error(`${error.message}；恢复模型配置失败：${rollbackError.message}`);
        }
        throw error;
      }
      delete state.summaryModelCredentialStatus[model.id];
      renderSummaryModelList();
    } catch (error) {
      notify(error.message);
    }
  }));
  $$(".summary-model-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", row.dataset.summaryModelId));
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      if (state.summaryModelMutationPending) return;
      const sourceId = event.dataTransfer.getData("text/plain");
      const targetId = row.dataset.summaryModelId;
      const source = state.summaryModelDrafts.findIndex((item) => item.id === sourceId);
      const target = state.summaryModelDrafts.findIndex((item) => item.id === targetId);
      if (source < 0 || target < 0 || source === target) return;
      const previousModels = snapshotSummaryModels();
      const [model] = state.summaryModelDrafts.splice(source, 1);
      state.summaryModelDrafts.splice(target, 0, model);
      try {
        await commitSummaryModelMutation(previousModels);
      } catch (error) {
        notify(error.message);
      }
    });
  });
}

function initializeSummaryModelDialog() {
  $("#summary-model-provider").addEventListener("change", (event) => {
    const defaults = SUMMARY_PROVIDER_DEFAULTS[event.target.value];
    $("#summary-model-endpoint").value = defaults.endpoint;
    $("#summary-model-model").value = defaults.model;
  });
  $("#summary-model-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#save-summary-model");
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      await saveSummaryModelEditor();
      notify("模型配置已保存");
    } catch (error) {
      $("#summary-model-status").className = "code-status is-error";
      $("#summary-model-status").textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "完成";
    }
  });
  $("#clear-summary-model-key").addEventListener("click", async (event) => {
    const modelId = $("#summary-model-id").value;
    if (!confirm("确认清除这个模型的 API Key？")) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await send("save-summary-model-credential", {
        modelId,
        clear: true
      });
      state.summaryModelCredentialStatus[modelId] = Boolean(result.configured);
      $("#summary-model-status").className = "code-status";
      $("#summary-model-status").textContent = "API Key 已清除。";
      renderSummaryModelList();
    } catch (error) {
      $("#summary-model-status").className = "code-status is-error";
      $("#summary-model-status").textContent = error.message;
    } finally {
      button.disabled = !state.summaryModelCredentialStatus[modelId];
    }
  });
  $("#test-summary-model").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "测试中…";
    $("#summary-model-status").className = "code-status is-pending";
    $("#summary-model-status").textContent = "正在连接模型服务…";
    try {
      const model = validatedSummaryModelFromEditor();
      const apiKey = $("#summary-model-api-key").value.trim();
      await send("test-summary-model", { model, apiKey });
      $("#summary-model-status").className = "code-status is-success";
      $("#summary-model-status").textContent = "连接成功。点击“完成”后保存配置。";
    } catch (error) {
      $("#summary-model-status").className = "code-status is-error";
      $("#summary-model-status").textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "测试连接";
    }
  });
}

function renderSettingsPage(root) {
  const settings = state.settings || {};
  const allowedTabs = new Set(["files", "asr", "summary", "account"]);
  const activeSettingsTab = allowedTabs.has(state.settingsTab) ? state.settingsTab : "files";
  state.settingsTab = activeSettingsTab;
  const panelHidden = (id) => activeSettingsTab === id ? "" : "hidden";
  const audioPath = String(settings.audioDownloadPath || "");
  const transcriptPath = String(settings.transcriptDownloadPath || "");
  const summaryPath = String(settings.summaryDownloadPath || "");
  state.summaryModelDrafts = (settings.summaryModels || []).map((model) => ({ ...model }));
  state.summaryPromptDrafts = (settings.summaryPromptVersions || []).map((prompt) => ({ ...prompt }));
  root.innerHTML = `
    <section class="settings-page">
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "files"}" data-settings-tab="files" class="${activeSettingsTab === "files" ? "is-active" : ""}">文件与助手</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "asr"}" data-settings-tab="asr" class="${activeSettingsTab === "asr" ? "is-active" : ""}">文字稿与 ASR</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "summary"}" data-settings-tab="summary" class="${activeSettingsTab === "summary" ? "is-active" : ""}">AI 总结</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "account"}" data-settings-tab="account" class="${activeSettingsTab === "account" ? "is-active" : ""}">账号</button>
      </nav>
      <form id="settings-form" class="settings-form">
        <section class="settings-section settings-panel" data-settings-panel="files" ${panelHidden("files")}>
          <div class="settings-section-heading"><h3>文件与本地助手</h3></div>
          <label>音频保存目录
            <div class="path-input-row"><input id="audio-download-path" type="text" value="${esc(audioPath)}" placeholder="留空使用系统默认下载目录/小宇宙音频" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="audio-download-path">选择目录</button></div>
          </label>
          <label>文字稿保存目录
            <div class="path-input-row"><input id="transcript-download-path" type="text" value="${esc(transcriptPath)}" placeholder="留空使用系统默认下载目录/小宇宙转写稿" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="transcript-download-path">选择目录</button></div>
          </label>
          <label>AI 总结稿保存目录
            <div class="path-input-row"><input id="summary-download-path" type="text" value="${esc(summaryPath)}" placeholder="留空使用文字稿保存目录" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="summary-download-path">选择目录</button></div>
          </label>
          <label class="checkbox-row"><input id="download-save-as" type="checkbox" ${settings.downloadSaveAs ? "checked" : ""} /><span>使用系统默认目录时，每次下载询问保存位置</span></label>
          <div id="native-host-status" class="native-host-status">正在检测本地文件助手……</div>
          <p id="native-helper-path" class="field-hint" hidden></p>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="asr" ${panelHidden("asr")}>
          <div class="settings-section-heading"><h3>文字稿与 ASR</h3></div>
          <div id="asr-settings-wrap">
          <label>ASR 服务<select id="asr-provider"><option value="qwen">Qwen API</option><option value="doubao">豆包 API</option></select></label>
          <div class="provider-settings" data-asr-provider-settings="qwen">
            <label>Qwen API Key<input id="qwen-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>API Base URL 或完整地址<input id="qwen-asr-endpoint" type="url" value="${esc(settings.qwenAsrEndpoint || "")}" placeholder="https://dashscope.aliyuncs.com/api/v1" /></label>
            <label>模型<input id="qwen-asr-model" type="text" list="qwen-asr-model-options" value="${esc(settings.qwenAsrModel || "qwen-audio-3.0-asr-flash-filetrans")}" /></label>
            <datalist id="qwen-asr-model-options">
              <option value="qwen-audio-3.0-asr-flash-filetrans"></option>
              <option value="fun-asr"></option>
              <option value="fun-asr-flash-2026-06-15"></option>
              <option value="qwen3-asr-flash-filetrans"></option>
              <option value="qwen3-asr-flash"></option>
            </datalist>
            <p class="field-hint">程序会按模型自动选择异步文件转写、DashScope 同步或 OpenAI-compatible 路径。长播客推荐 <code>qwen-audio-3.0-asr-flash-filetrans</code>；Fun-ASR-Flash 单次最多 5 分钟。</p>
          </div>
          <div class="provider-settings" data-asr-provider-settings="doubao">
            <label>豆包 API Key<input id="doubao-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>接口地址<input id="doubao-asr-endpoint" type="url" value="${esc(settings.doubaoAsrEndpoint || "")}" /></label>
            <label>Resource ID<input id="doubao-asr-resource-id" type="text" value="${esc(settings.doubaoAsrResourceId || "volc.bigasr.auc_turbo")}" /></label>
          </div>
          <div id="asr-provider-status" class="native-host-status">正在检查 API 配置……</div>
          <p class="field-hint">转写稿优先保留模型返回的完整标点；模型未返回标点时，会依据语音片段停顿补充基础逗号和句号。</p>
          <p class="field-hint">API Key 由本地助手保存在 <span id="credential-storage-label">系统安全凭据存储</span>，客户端只显示配置状态。转写会将音频 URL 或音频内容发送至所选服务。</p>
          </div>
        </section>
        <section class="settings-section settings-panel summary-settings-section" data-settings-panel="summary" ${panelHidden("summary")}>
          <div class="settings-section-heading model-list-heading">
            <h3>AI 总结模型</h3>
            <button id="add-summary-model" class="secondary-button" type="button">添加模型</button>
          </div>
          <div id="summary-model-list" class="summary-model-list"></div>
          <div id="summary-provider-status" class="native-host-status">正在检查模型凭据……</div>
          <div class="summary-run-row">
            <button id="choose-summary-transcript" class="secondary-button" type="button">选择已有转写稿并总结</button>
            <span id="summary-action-status" class="field-hint">长转写稿会自动分段汇总。</span>
          </div>
          <div class="prompt-manager">
            <div class="prompt-manager-heading">
              <strong>总结 Prompt 版本</strong>
              <span id="active-prompt-badge" class="prompt-badge"></span>
            </div>
            <label>选择版本<select id="summary-prompt-select"></select></label>
            <div class="prompt-meta-grid">
              <label>名称<input id="summary-prompt-name" type="text" maxlength="80" /></label>
              <label>版本<input id="summary-prompt-version" type="text" maxlength="32" /></label>
            </div>
            <label>Prompt<textarea id="summary-prompt-content" rows="18" maxlength="20000"></textarea></label>
            <div class="prompt-actions">
              <button id="clone-summary-prompt" class="secondary-button" type="button">复制为新版本</button>
              <button id="activate-summary-prompt" class="mini-button" type="button">设为当前</button>
              <button id="delete-summary-prompt" class="mini-button is-danger" type="button">删除版本</button>
            </div>
            <p class="field-hint">内置版本只读；自定义版本保存在 这台电脑的加密设置中。支持占位符 <code>{{title}}</code>。</p>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="account" ${panelHidden("account")}>
          <div class="settings-section-heading"><h3>账号与会话</h3></div>
          <div class="account-setting-row">
            <div><strong>${esc(state.auth?.user?.nickname || state.auth?.user?.name || "小宇宙账号")}</strong><span>${state.auth ? "已登录 · 下次打开自动恢复" : "当前未登录"}</span></div>
            ${state.auth ? '<button id="settings-logout-button" class="danger-button" type="button">退出登录</button>' : '<button id="settings-login-button" class="secondary-button" type="button">登录</button>'}
          </div>
        </section>
        <button class="primary-button settings-save" type="submit" ${activeSettingsTab === "account" ? "hidden" : ""}>保存设置</button>
      </form>
    </section>`;
  $$("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    state.settingsTab = button.dataset.settingsTab;
    $(".settings-save").hidden = state.settingsTab === "account";
    $$("[data-settings-tab]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    $$("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== state.settingsTab;
    });
  }));
  $("#asr-provider").value = settings.asrProvider === "doubao" ? "doubao" : "qwen";
  const updateAsrProviderSettings = () => {
    $$("[data-asr-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.asrProviderSettings !== $("#asr-provider").value;
    });
  };
  updateAsrProviderSettings();
  $("#asr-provider").addEventListener("change", updateAsrProviderSettings);
  renderSummaryModelList();
  $("#add-summary-model").addEventListener("click", () => openSummaryModelEditor());
  $("#settings-logout-button")?.addEventListener("click", openLogoutConfirmation);
  $("#settings-login-button")?.addEventListener("click", openLogin);
  initializeSummaryPromptManager(settings.activeSummaryPromptId);
  const updatePreview = () => {
    const audioValue = $("#audio-download-path").value.trim();
    $("#download-save-as").disabled = Boolean(audioValue);
  };
  updatePreview();
  $("#audio-download-path").addEventListener("input", updatePreview);
  $("#transcript-download-path").addEventListener("input", updatePreview);
  $("#summary-download-path").addEventListener("input", updatePreview);
  $$("[data-choose-directory]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const prompts = {
        "audio-download-path": "请选择音频保存目录",
        "transcript-download-path": "请选择文字稿保存目录",
        "summary-download-path": "请选择 AI 总结稿保存目录"
      };
      const prompt = prompts[button.dataset.chooseDirectory] || "请选择保存目录";
      const data = await send("choose-native-directory", { prompt });
      if (!data.path) return;
      $(`#${button.dataset.chooseDirectory}`).value = data.path;
      updatePreview();
    } catch (error) {
      notify(error.message);
    }
  }));
  $("#choose-summary-transcript").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      button.textContent = "选择中…";
      const selected = await send("import-summary-transcript");
      if (!selected.path) return;
      await summarizeTranscriptPath(selected.path, button, $("#summary-action-status"));
    } catch (error) {
      $("#summary-action-status").textContent = error.message;
      notify(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "选择已有转写稿并总结";
    }
  });
  $("#settings-form").addEventListener("submit", saveSettings);
  const settingsForm = $("#settings-form");
  send("get-native-host-status").then((status) => {
    if (!settingsForm.isConnected) return;
    const node = $("#native-host-status");
    if (!node) return;
    node.classList.toggle("is-ready", status.available);
    node.textContent = status.available
      ? `本地文件助手已连接 · ${status.version || "可用"}`
      : `本地文件助手未连接，目录选择、ASR 和 AI 总结不可用。${status.error || ""}`;
    const isWindows = status.platform === "windows";
    const helperPath = $("#native-helper-path");
    helperPath.hidden = status.available;
    helperPath.textContent = status.hostPath ? "助手位置 " + status.hostPath : "";
    $("#credential-storage-label").textContent = status.credentialStorage
      || (isWindows ? "Windows DPAPI" : "macOS Keychain");
    $$("[data-choose-directory]").forEach((button) => {
      button.disabled = !status.available;
      button.title = status.available ? "" : "请检查客户端的本地文件助手";
    });
    $("#choose-summary-transcript").disabled = !status.available;
    const providerNode = $("#asr-provider-status");
    if (!providerNode) return;
    providerNode.classList.toggle("is-ready", status.qwenConfigured || status.doubaoConfigured || status.localQwen?.available);
    providerNode.textContent = `Qwen API：${status.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${status.doubaoConfigured ? "已配置" : "未配置"}`;
    refreshSummaryModelCredentialStatus();
  });
}

function incrementPromptVersion(value) {
  const parts = String(value || "1.0.0").split(".");
  const last = Number(parts[parts.length - 1]);
  if (Number.isInteger(last)) {
    parts[parts.length - 1] = String(last + 1);
    return parts.join(".");
  }
  return `${value || "1.0.0"}.1`;
}

function summaryPromptById(id) {
  return state.summaryPromptDrafts.find((prompt) => prompt.id === id);
}

function syncSummaryPromptEditor() {
  const prompt = summaryPromptById(state.summaryPromptEditorId);
  if (!prompt || prompt.builtin || !$("#summary-prompt-content")) return;
  prompt.name = $("#summary-prompt-name").value.trim() || "自定义总结 Prompt";
  prompt.version = $("#summary-prompt-version").value.trim() || "1.0.0";
  prompt.content = $("#summary-prompt-content").value.trim();
}

function refreshSummaryPromptSelect(selectedId) {
  const select = $("#summary-prompt-select");
  select.innerHTML = state.summaryPromptDrafts.map((prompt) =>
    `<option value="${esc(prompt.id)}">${esc(prompt.name)} · v${esc(prompt.version)}${prompt.builtin ? "（内置）" : ""}</option>`
  ).join("");
  select.value = selectedId;
}

function loadSummaryPromptEditor(id) {
  const prompt = summaryPromptById(id) || state.summaryPromptDrafts[0];
  if (!prompt) return;
  state.summaryPromptEditorId = prompt.id;
  $("#summary-prompt-select").value = prompt.id;
  $("#summary-prompt-name").value = prompt.name;
  $("#summary-prompt-version").value = prompt.version;
  $("#summary-prompt-content").value = prompt.content;
  $("#summary-prompt-name").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-version").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-content").readOnly = Boolean(prompt.builtin);
  $("#delete-summary-prompt").disabled = Boolean(prompt.builtin);
  $("#activate-summary-prompt").disabled = prompt.id === state.settings.activeSummaryPromptId;
  const active = summaryPromptById(state.settings.activeSummaryPromptId) || state.summaryPromptDrafts[0];
  $("#active-prompt-badge").textContent = active
    ? `当前：${active.name} v${active.version}`
    : "未选择";
}

function initializeSummaryPromptManager(activeId) {
  if (!state.summaryPromptDrafts.length) return;
  state.settings.activeSummaryPromptId = activeId || state.summaryPromptDrafts[0].id;
  refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
  loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  $("#summary-prompt-select").addEventListener("change", (event) => {
    syncSummaryPromptEditor();
    loadSummaryPromptEditor(event.target.value);
  });
  $("#clone-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    const source = summaryPromptById(state.summaryPromptEditorId) || state.summaryPromptDrafts[0];
    const copy = {
      id: `custom-${crypto.randomUUID()}`,
      name: `${source.name} 副本`,
      version: incrementPromptVersion(source.version),
      content: source.content,
      builtin: false
    };
    state.summaryPromptDrafts.push(copy);
    refreshSummaryPromptSelect(copy.id);
    loadSummaryPromptEditor(copy.id);
  });
  $("#activate-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    state.settings.activeSummaryPromptId = state.summaryPromptEditorId;
    loadSummaryPromptEditor(state.summaryPromptEditorId);
    notify("已设为当前 Prompt，保存设置后生效");
  });
  $("#delete-summary-prompt").addEventListener("click", () => {
    const prompt = summaryPromptById(state.summaryPromptEditorId);
    if (!prompt || prompt.builtin || !confirm(`确认删除 Prompt 版本“${prompt.name}”？`)) return;
    state.summaryPromptDrafts = state.summaryPromptDrafts.filter((item) => item.id !== prompt.id);
    if (state.settings.activeSummaryPromptId === prompt.id) {
      state.settings.activeSummaryPromptId = state.summaryPromptDrafts[0].id;
    }
    refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
    loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  });
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    syncSummaryPromptEditor();
    if (state.summaryPromptDrafts.some((prompt) => !String(prompt.content || "").trim())) {
      throw new Error("AI 总结 Prompt 内容不能为空");
    }
    const asrCredentialStatus = await send("save-asr-credentials", {
      credentials: {
        qwenApiKey: $("#qwen-api-key").value.trim(),
        doubaoApiKey: $("#doubao-api-key").value.trim()
      }
    });
    const keepConsent = Boolean(state.settings.summaryConsentAccepted);
    state.settings = await send("update-settings", {
      settings: {
        downloadFolder: "小宇宙音频",
        transcriptFolder: "小宇宙转写稿",
        audioDownloadPath: $("#audio-download-path").value.trim(),
        transcriptDownloadPath: $("#transcript-download-path").value.trim(),
        summaryDownloadPath: $("#summary-download-path").value.trim(),
        downloadSaveAs: $("#download-save-as").checked,
        transcriptSource: "asr",
        asrProvider: $("#asr-provider").value,
        qwenAsrEndpoint: $("#qwen-asr-endpoint").value.trim(),
        qwenAsrModel: $("#qwen-asr-model").value.trim(),
        doubaoAsrEndpoint: $("#doubao-asr-endpoint").value.trim(),
        doubaoAsrResourceId: $("#doubao-asr-resource-id").value.trim(),
        summaryModels: state.summaryModelDrafts.map((model) => ({ ...model })),
        summaryPromptVersions: state.summaryPromptDrafts.map((prompt) => ({ ...prompt })),
        activeSummaryPromptId: state.settings.activeSummaryPromptId,
        summaryConsentAccepted: keepConsent,
        summaryIncludeComments: false
      }
    });
    $("#qwen-api-key").value = "";
    $("#doubao-api-key").value = "";
    const providerNode = $("#asr-provider-status");
    if (providerNode) {
      providerNode.classList.toggle("is-ready", asrCredentialStatus.qwenConfigured || asrCredentialStatus.doubaoConfigured || asrCredentialStatus.localQwen?.available);
      providerNode.textContent = `Qwen API：${asrCredentialStatus.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${asrCredentialStatus.doubaoConfigured ? "已配置" : "未配置"}`;
    }
    refreshSummaryModelCredentialStatus();
    $("#audio-download-path").value = state.settings.audioDownloadPath;
    $("#transcript-download-path").value = state.settings.transcriptDownloadPath;
    $("#summary-download-path").value = state.settings.summaryDownloadPath;
    $("#audio-path-preview").textContent = state.settings.audioDownloadPath || "系统默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = state.settings.transcriptDownloadPath || "系统默认下载目录/小宇宙转写稿";
    $("#summary-path-preview").textContent = state.settings.summaryDownloadPath
      || state.settings.transcriptDownloadPath
      || "系统默认下载目录/小宇宙转写稿";
    updatePlayerLinkButtons(state.current);
    notify("设置已保存");
  } catch (error) {
    notify(error.message);
  }
}
