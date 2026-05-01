const state = {
  tasks: [],
  current: null,
  detail: null,
  mode: "create",
  templateKey: "builtin:student",
  settings: { siteUrl: "", siteTitle: "Filestore", taskTemplates: [] },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const builtInTemplates = {
  "builtin:student": {
    name: "学号模板",
    fields: [
      { label: "姓名", key: "name", required: true, pattern: "^[\\u4e00-\\u9fa5·]{2,20}$", placeholder: "请输入中文姓名" },
      { label: "学号", key: "student_id", required: true, pattern: "^2020\\d{6}$", placeholder: "例如 2020240444" },
    ],
    fileRules: { allowedTypes: ["pdf", "doc", "docx", "jpg", "png", "zip"], maxSizeMb: 20, maxCount: 1 },
    renameTemplate: "{name}-{student_id}",
  },
  "builtin:exam": {
    name: "考试号模板",
    fields: [
      { label: "姓名", key: "name", required: true, pattern: "^[\\u4e00-\\u9fa5·]{2,20}$", placeholder: "请输入中文姓名" },
      { label: "考试号", key: "student_id", required: true, pattern: "^24201505\\d{2}$", placeholder: "例如 2420150508" },
    ],
    fileRules: { allowedTypes: ["pdf", "doc", "docx", "jpg", "png", "zip"], maxSizeMb: 20, maxCount: 1 },
    renameTemplate: "{name}-{student_id}",
  },
};

window.addEventListener("error", (event) => {
  reportError(event.error || new Error(event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  reportError(event.reason || new Error("操作失败"));
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function headers() {
  return { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) setAuthed(false);
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function setAuthed(isAuthed) {
  document.body.classList.toggle("auth-pending", !isAuthed);
  $("#loginScreen").hidden = isAuthed;
}

function applyBranding() {
  const title = state.settings.siteTitle || "Filestore";
  document.title = `${title} 管理系统`;
  $$("[data-site-title]").forEach((node) => {
    node.textContent = title;
  });
}

async function checkSession() {
  try {
    const session = await api("/api/admin/me");
    state.settings = normalizeSettings(session.settings);
    applyBranding();
    renderTemplateSelect(state.templateKey);
    setAuthed(true);
    await loadTasks();
  } catch {
    setAuthed(false);
  }
}

async function login(password) {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "登录失败");
  state.settings = normalizeSettings(payload.settings);
  applyBranding();
  renderTemplateSelect(state.templateKey);
  setAuthed(true);
  await loadTasks();
}

async function logout() {
  await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
  state.tasks = [];
  state.current = null;
  state.detail = null;
  $("#taskList").innerHTML = "";
  $("#dashboard").hidden = true;
  $("#emptyDashboard").hidden = false;
  $("#activeTitle").textContent = "请选择或新建任务";
  $("#activeMeta").textContent = "任务链接、统计、提交记录和缺交名单会集中显示在这里。";
  setAuthed(false);
}

function toast(text, type = "") {
  const inline = $("#createMessage");
  if (inline) {
    inline.textContent = text;
    inline.className = `message ${type}`;
  }
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = text;
  $("#toastHost").appendChild(item);
  setTimeout(() => item.remove(), type === "error" ? 5200 : 2800);
}

function reportError(error, fallback = "操作失败") {
  toast(error?.message || fallback, "error");
}

function safe(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      reportError(error);
    }
  };
}

function confirmInApp({ title = "确认操作", body = "", okText = "确认", danger = true } = {}) {
  return new Promise((resolve) => {
    const dialog = $("#confirmDialog");
    $("#confirmTitle").textContent = title;
    $("#confirmBody").textContent = body;
    $("#confirmOk").textContent = okText;
    $("#confirmOk").className = danger ? "danger" : "primary";

    const cleanup = (value) => {
      $("#confirmOk").onclick = null;
      $("#confirmCancel").onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };

    $("#confirmOk").onclick = () => cleanup(true);
    $("#confirmCancel").onclick = () => cleanup(false);
    dialog.onclose = () => cleanup(false);
    dialog.showModal();
  });
}

function promptInApp({ title = "输入名称", body = "", label = "名称", value = "", okText = "保存" } = {}) {
  return new Promise((resolve) => {
    const dialog = $("#promptDialog");
    $("#promptTitle").textContent = title;
    $("#promptBody").textContent = body;
    $("#promptLabel").firstChild.textContent = label;
    $("#promptInput").value = value;
    $("#promptOk").textContent = okText;

    const cleanup = (result) => {
      $("#promptOk").onclick = null;
      $("#promptCancel").onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };

    $("#promptOk").onclick = () => cleanup($("#promptInput").value.trim());
    $("#promptCancel").onclick = () => cleanup(null);
    dialog.onclose = () => cleanup(null);
    dialog.showModal();
    $("#promptInput").focus();
  });
}

function normalizeSettings(settings = {}) {
  return {
    siteUrl: settings.siteUrl || "",
    siteTitle: settings.siteTitle || "Filestore",
    taskTemplates: Array.isArray(settings.taskTemplates) ? settings.taskTemplates : [],
  };
}

function normalizeAllowedTypes(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function absoluteSubmitUrl(task) {
  if (!task) return "";
  const base = (state.settings.siteUrl || location.origin).replace(/\/+$/, "");
  return `${base}${task.submitUrl}`;
}

function defaultTemplate() {
  return builtInTemplates["builtin:student"];
}

function defaultFields() {
  return defaultTemplate().fields;
}

function currentTemplateOptions() {
  return [
    ...Object.entries(builtInTemplates).map(([key, template]) => ({ key, template, builtin: true })),
    ...state.settings.taskTemplates.map((template) => ({ key: `custom:${template.id}`, template, builtin: false })),
  ];
}

function selectedTemplate() {
  const key = $("#templateSelect").value || state.templateKey;
  return currentTemplateOptions().find((item) => item.key === key);
}

function renderTemplateSelect(selectedKey = state.templateKey) {
  const options = currentTemplateOptions();
  $("#templateSelect").innerHTML = options.map((item) => `
    <option value="${escapeHtml(item.key)}">${item.builtin ? "内置：" : "自定义："}${escapeHtml(item.template.name)}</option>
  `).join("");
  const hasSelected = options.some((item) => item.key === selectedKey);
  state.templateKey = hasSelected ? selectedKey : "builtin:student";
  $("#templateSelect").value = state.templateKey;
  $("#deleteTemplate").disabled = state.templateKey.startsWith("builtin:");
}

function addField(field = {}) {
  const row = document.createElement("div");
  row.className = "field-card";
  row.innerHTML = `
    <div class="field-top">
      <input class="field-label" value="${escapeHtml(field.label || "")}" placeholder="字段名">
      <input class="field-key" value="${escapeHtml(field.key || "")}" placeholder="key">
      <button class="icon-button remove-field" type="button" title="删除">×</button>
    </div>
    <input class="field-pattern" value="${escapeHtml(field.pattern || "")}" placeholder="正则规则，例如 \\d{11}">
    <div class="field-bottom">
      <input class="field-placeholder" value="${escapeHtml(field.placeholder || "")}" placeholder="输入提示">
      <label class="checkline"><input class="field-required" type="checkbox" ${field.required === false ? "" : "checked"}> 必填</label>
    </div>
  `;
  row.querySelector(".remove-field").addEventListener("click", () => row.remove());
  $("#fields").appendChild(row);
}

function setFields(fields) {
  $("#fields").innerHTML = "";
  fields.forEach(addField);
}

function applyTemplate(template = selectedTemplate()?.template) {
  if (!template) throw new Error("请选择模板");
  setFields(template.fields || defaultFields());
  $("#allowedTypes").value = normalizeAllowedTypes(template.fileRules?.allowedTypes).join(",") || "pdf,doc,docx,jpg,png,zip";
  $("#maxSizeMb").value = template.fileRules?.maxSizeMb || 20;
  $("#maxCount").value = template.fileRules?.maxCount || 1;
  $("#renameTemplate").value = template.renameTemplate || "{name}-{student_id}";
  toast("模板已应用", "ok");
}

function collectFields() {
  return $$(".field-card").map((row) => ({
    label: row.querySelector(".field-label").value.trim(),
    key: row.querySelector(".field-key").value.trim(),
    pattern: row.querySelector(".field-pattern").value.trim(),
    placeholder: row.querySelector(".field-placeholder").value.trim(),
    required: row.querySelector(".field-required").checked,
  }));
}

function editorPayload() {
  const deadlineValue = $("#deadline").value;
  return {
    title: $("#title").value.trim(),
    description: $("#description").value.trim(),
    deadline: deadlineValue ? new Date(deadlineValue).toISOString() : "",
    status: $("#taskStatus").value,
    fields: collectFields(),
    fileRules: {
      allowedTypes: $("#allowedTypes").value.trim(),
      maxSizeMb: $("#maxSizeMb").value,
      maxCount: $("#maxCount").value,
    },
    renameTemplate: $("#renameTemplate").value.trim(),
    expectedEntries: $("#expectedEntries").value,
  };
}

function templatePayload() {
  const payload = editorPayload();
  return {
    fields: payload.fields,
    fileRules: {
      allowedTypes: normalizeAllowedTypes(payload.fileRules.allowedTypes),
      maxSizeMb: Number(payload.fileRules.maxSizeMb || 20),
      maxCount: Number(payload.fileRules.maxCount || 1),
    },
    renameTemplate: payload.renameTemplate,
  };
}

function fillEditor(task) {
  $("#editorTitle").textContent = task ? "编辑任务" : "新建任务";
  renderTemplateSelect(state.templateKey);
  $("#title").value = task?.title || "";
  $("#description").value = task?.description || "";
  $("#deadline").value = localDateTime(task?.deadline);
  $("#taskStatus").value = task?.status || "open";
  $("#allowedTypes").value = normalizeAllowedTypes(task?.fileRules?.allowedTypes || defaultTemplate().fileRules.allowedTypes).join(",");
  $("#maxSizeMb").value = task?.fileRules?.maxSizeMb || 20;
  $("#maxCount").value = task?.fileRules?.maxCount || 1;
  $("#renameTemplate").value = task?.renameTemplate || "{name}-{student_id}";
  $("#expectedEntries").value = task?.expectedEntries || "";
  setFields(task?.fields?.length ? task.fields : defaultFields());
  $("#deleteTask").disabled = !task;
  state.mode = task ? "edit" : "create";
}

function openEditor(task = null) {
  fillEditor(task);
  $("#editorDrawer").classList.add("open");
  $("#editorDrawer").setAttribute("aria-hidden", "false");
  $("#drawerScrim").classList.add("open");
}

function closeEditor() {
  $("#editorDrawer").classList.remove("open");
  $("#editorDrawer").setAttribute("aria-hidden", "true");
  $("#drawerScrim").classList.remove("open");
}

async function saveTask() {
  toast("正在保存...");
  try {
    const payload = editorPayload();
    const path = state.mode === "edit" && state.current ? `/api/tasks/${state.current.id}` : "/api/tasks";
    const method = state.mode === "edit" ? "PATCH" : "POST";
    const task = await api(path, { method, body: JSON.stringify(payload) });
    toast(state.mode === "edit" ? "任务已更新" : "任务已创建", "ok");
    await loadTasks();
    await selectTask(task.id);
    closeEditor();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadTasks() {
  $("#taskList").innerHTML = "<p class='muted-pad'>加载任务...</p>";
  try {
    state.tasks = await api("/api/tasks");
    renderTaskList();
  } catch (error) {
    $("#taskList").innerHTML = `<p class="message error">${escapeHtml(error.message)}</p>`;
  }
}

async function saveSettings(siteUrl) {
  const settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ siteUrl, siteTitle: $("#siteTitle").value }),
  });
  state.settings = normalizeSettings(settings);
  renderTemplateSelect(state.templateKey);
  applyBranding();
  if (state.current) renderDetail(state.current);
  return settings;
}

async function changePassword() {
  const currentPassword = $("#currentPassword").value;
  const newPassword = $("#newPassword").value;
  const confirmPassword = $("#confirmPassword").value;
  if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
  const ok = await confirmInApp({
    title: "修改管理员密码",
    body: "修改成功后当前登录会失效，需要用新密码重新登录。",
    okText: "修改密码",
  });
  if (!ok) return;
  const response = await fetch("/api/admin/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "修改密码失败");
  $("#currentPassword").value = "";
  $("#newPassword").value = "";
  $("#confirmPassword").value = "";
  $("#settingsDialog").close();
  toast("密码已修改，请重新登录", "ok");
  setAuthed(false);
}

async function saveTemplate() {
  const name = await promptInApp({
    title: "保存当前模板",
    body: "输入模板名称，保存后会出现在模板下拉列表中。",
    label: "模板名称",
    okText: "保存模板",
  });
  if (!name) return;
  const existing = state.settings.taskTemplates.find((item) => item.name === name);
  let templates = state.settings.taskTemplates;
  if (existing) {
    const ok = await confirmInApp({
      title: "覆盖模板",
      body: `已存在名为「${name}」的模板，是否覆盖？`,
      okText: "覆盖",
      danger: false,
    });
    if (!ok) return;
    templates = templates.filter((item) => item.id !== existing.id);
  }
  const template = {
    id: existing?.id || `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    ...templatePayload(),
  };
  const settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      siteUrl: state.settings.siteUrl || "",
      siteTitle: state.settings.siteTitle || "Filestore",
      taskTemplates: [...templates, template],
    }),
  });
  state.settings = normalizeSettings(settings);
  renderTemplateSelect(`custom:${template.id}`);
  toast(`模板「${name}」已保存`, "ok");
}

async function deleteSelectedTemplate() {
  const selected = selectedTemplate();
  if (!selected) throw new Error("请选择模板");
  if (selected.builtin) {
    toast("内置模板不能删除", "error");
    return;
  }
  const ok = await confirmInApp({
    title: "删除模板",
    body: `删除自定义模板「${selected.template.name}」？`,
    okText: "删除模板",
  });
  if (!ok) return;
  const templates = state.settings.taskTemplates.filter((item) => item.id !== selected.template.id);
  const settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      siteUrl: state.settings.siteUrl || "",
      siteTitle: state.settings.siteTitle || "Filestore",
      taskTemplates: templates,
    }),
  });
  state.settings = normalizeSettings(settings);
  renderTemplateSelect("builtin:student");
  toast("模板已删除", "ok");
}

function renderTaskList() {
  const query = $("#taskSearch").value.trim().toLowerCase();
  const tasks = state.tasks.filter((task) => `${task.title} ${task.description}`.toLowerCase().includes(query));
  if (!tasks.length) {
    $("#taskList").innerHTML = "<p class='muted-pad'>没有匹配任务。</p>";
    return;
  }
  $("#taskList").innerHTML = tasks.map((task) => {
    const active = state.current?.id === task.id ? " active" : "";
    return `
      <button class="task-card${active}" data-task="${task.id}">
        <span class="status-dot ${task.status}"></span>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${task.status === "open" ? "开放提交" : "停止提交"} · ${task.deadline ? new Date(task.deadline).toLocaleDateString() : "无截止时间"}</small>
      </button>
    `;
  }).join("");
  $$("[data-task]").forEach((button) => button.addEventListener("click", () => selectTask(Number(button.dataset.task))));
}

async function selectTask(id) {
  try {
    const task = await api(`/api/tasks/${id}`);
    state.current = task;
    state.detail = task;
    renderTaskList();
    renderDetail(task);
  } catch (error) {
    toast(error.message, "error");
  }
}

function fileTotal(task) {
  return task.submissions.reduce((sum, item) => sum + item.files.length, 0);
}

function formatBytes(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function allTaskFiles(task = state.detail) {
  if (!task) return [];
  return task.submissions.flatMap((submission) => {
    const owner = submission.data.name || `#${submission.id}`;
    const identifier = submission.data.student_id || "";
    return submission.files.map((file) => ({
      ...file,
      submissionId: submission.id,
      owner,
      identifier,
      submittedAt: submission.createdAt,
      data: submission.data,
    }));
  });
}

function fileSearchText(file) {
  return `${file.storedName} ${file.originalName} ${file.owner} ${file.identifier} ${JSON.stringify(file.data)}`.toLowerCase();
}

function fileActions(file) {
  return `
    <div class="file-actions">
      <button data-file-preview="${file.id}">查看</button>
      <button data-file-download="${file.id}">下载</button>
      <button class="danger" data-file-delete="${file.id}">删除</button>
    </div>
  `;
}

function renderMetrics(task) {
  const stats = task.stats;
  const rate = stats.expected ? Math.round((stats.submitted / stats.expected) * 100) : 0;
  $("#metrics").innerHTML = `
    <div class="metric"><span>已提交</span><b>${stats.submitted}</b><small>${stats.expected ? `完成率 ${rate}%` : "未设置名单"}</small></div>
    <div class="metric"><span>应提交</span><b>${stats.expected || "-"}</b><small>来自名单行数</small></div>
    <div class="metric"><span>未提交</span><b>${stats.missing.length}</b><small>${stats.missing.length ? "可复制催交通知" : "暂无缺交"}</small></div>
    <div class="metric"><span>文件数</span><b>${fileTotal(task)}</b><small>已上传文件总数</small></div>
  `;
}

function renderRules(task) {
  const rules = task.fileRules;
  $("#ruleList").innerHTML = `
    <dt>字段</dt><dd>${task.fields.map((field) => escapeHtml(field.label)).join("、")}</dd>
    <dt>文件类型</dt><dd>${normalizeAllowedTypes(rules.allowedTypes).join(", ") || "不限"}</dd>
    <dt>大小/数量</dt><dd>${rules.maxSizeMb} MB · 最多 ${rules.maxCount} 个</dd>
    <dt>命名</dt><dd>${escapeHtml(task.renameTemplate)}</dd>
    <dt>截止</dt><dd>${task.deadline ? new Date(task.deadline).toLocaleString() : "未设置"}</dd>
  `;
}

function renderMissing(task) {
  const missing = task.stats.missing;
  $("#copyMissing").disabled = !missing.length;
  $("#missingList").innerHTML = missing.length
    ? missing.map((item) => `<span>${escapeHtml(item)}</span>`).join("")
    : "<p class='muted-pad compact'>没有缺交记录。</p>";
}

function renderDetail(task) {
  $("#emptyDashboard").hidden = true;
  $("#dashboard").hidden = false;
  $("#activeTitle").textContent = task.title;
  $("#activeMeta").textContent = `${task.status === "open" ? "开放提交" : "停止提交"} · ${task.deadline ? `截止 ${new Date(task.deadline).toLocaleString()}` : "未设置截止时间"}`;
  $("#shareLink").value = absoluteSubmitUrl(task);
  ["editTask", "copyLink", "showQr", "openFileManager", "exportCsv", "downloadZip"].forEach((id) => $(`#${id}`).disabled = false);
  renderMetrics(task);
  renderRules(task);
  renderMissing(task);
  renderSubmissionTable();
}

function filteredSubmissions() {
  if (!state.detail) return [];
  const query = $("#submissionSearch").value.trim().toLowerCase();
  return state.detail.submissions.filter((item) => {
    const blob = `${JSON.stringify(item.data)} ${item.files.map((file) => file.storedName).join(" ")}`.toLowerCase();
    return !query || blob.includes(query);
  });
}

function renderSubmissionTable() {
  const task = state.detail;
  if (!task) return;
  const rows = filteredSubmissions();
  const fields = task.fields;
  if (!rows.length) {
    $("#submissionTable").innerHTML = `
      <div class="table-empty">
        <strong>${task.submissions.length ? "没有匹配结果" : "暂无提交"}</strong>
        <span>${task.submissions.length ? "换个关键词再试。" : "提交者上传后会自动出现在这里。"}</span>
      </div>
    `;
    return;
  }
  $("#submissionTable").innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>提交人</th>
            ${fields.filter((field) => field.key !== "name").map((field) => `<th>${escapeHtml(field.label)}</th>`).join("")}
            <th>文件</th>
            <th>提交时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => `
            <tr>
              <td><strong>${escapeHtml(item.data.name || `#${item.id}`)}</strong><span class="cell-sub">IP ${escapeHtml(item.ip)}</span></td>
              ${fields.filter((field) => field.key !== "name").map((field) => `<td>${escapeHtml(item.data[field.key] || "")}</td>`).join("")}
              <td class="file-cell">${item.files.map((file) => `
                <div class="file-row">
                  <div>
                    <strong>${escapeHtml(file.storedName)}</strong>
                    <span class="cell-sub">${escapeHtml(file.originalName)} · ${formatBytes(file.size)}</span>
                  </div>
                  ${fileActions(file)}
                </div>
              `).join("")}</td>
              <td>${new Date(item.createdAt).toLocaleString()}</td>
              <td><button class="icon-button danger" data-delete="${item.id}" title="删除">×</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  $$("[data-delete]").forEach((button) => {
    button.addEventListener("click", safe(() => deleteSubmission(button.dataset.delete)));
  });
  bindFileActionButtons();
}

function bindFileActionButtons() {
  $$("[data-file-preview]").forEach((button) => {
    button.onclick = safe(() => previewFile(button.dataset.filePreview));
  });
  $$("[data-file-download]").forEach((button) => {
    button.onclick = safe(() => downloadFile(button.dataset.fileDownload));
  });
  $$("[data-file-delete]").forEach((button) => {
    button.onclick = safe(() => deleteFile(button.dataset.fileDelete));
  });
}

function previewFile(id) {
  window.open(`/api/files/${id}/preview`, "_blank", "noopener");
}

function downloadFile(id) {
  window.open(`/api/files/${id}/download`, "_blank", "noopener");
}

async function deleteFile(id) {
  const ok = await confirmInApp({
    title: "删除文件",
    body: "提交记录会保留，但该文件会从服务器移除。",
    okText: "删除文件",
  });
  if (!ok) return;
  await api(`/api/files/${id}`, { method: "DELETE" });
  await selectTask(state.current.id);
  if ($("#fileDialog").open) renderFileManager();
  toast("文件已删除", "ok");
}

function openFileManager() {
  if (!state.detail) return;
  $("#fileSearch").value = "";
  renderFileManager();
  $("#fileDialog").showModal();
}

function renderFileManager() {
  const files = allTaskFiles();
  const query = $("#fileSearch").value.trim().toLowerCase();
  const filtered = files.filter((file) => !query || fileSearchText(file).includes(query));
  $("#fileDialogMeta").textContent = `${state.detail.title} · 共 ${files.length} 个文件`;
  if (!filtered.length) {
    $("#fileManager").innerHTML = `
      <div class="table-empty">
        <strong>${files.length ? "没有匹配文件" : "暂无文件"}</strong>
        <span>${files.length ? "换个关键词再试。" : "提交者上传后会出现在这里。"}</span>
      </div>
    `;
    return;
  }
  $("#fileManager").innerHTML = `
    <div class="file-manager-list">
      ${filtered.map((file) => `
        <article class="file-card" data-file-card="${file.id}">
          <div>
            <strong>${escapeHtml(file.storedName)}</strong>
            <span>${escapeHtml(file.originalName)} · ${formatBytes(file.size)}</span>
          </div>
          <dl>
            <dt>提交人</dt><dd>${escapeHtml(file.owner)}</dd>
            <dt>编号</dt><dd>${escapeHtml(file.identifier || "-")}</dd>
            <dt>时间</dt><dd>${new Date(file.submittedAt).toLocaleString()}</dd>
          </dl>
          ${fileActions(file)}
        </article>
      `).join("")}
    </div>
  `;
  bindFileActionButtons();
}

async function deleteSubmission(id) {
  const ok = await confirmInApp({
    title: "删除提交记录",
    body: "这会同时删除该提交记录下的所有文件。",
    okText: "删除提交",
  });
  if (!ok) return;
  await api(`/api/submissions/${id}`, { method: "DELETE" });
  await selectTask(state.current.id);
  toast("提交记录已删除", "ok");
}

async function deleteTask() {
  if (!state.current) return;
  const ok = await confirmInApp({
    title: "删除任务",
    body: `删除任务「${state.current.title}」及所有提交文件？此操作不可恢复。`,
    okText: "删除任务",
  });
  if (!ok) return;
  await api(`/api/tasks/${state.current.id}`, { method: "DELETE" });
  state.current = null;
  state.detail = null;
  $("#activeTitle").textContent = "请选择或新建任务";
  $("#activeMeta").textContent = "任务链接、统计、提交记录和缺交名单会集中显示在这里。";
  $("#dashboard").hidden = true;
  $("#emptyDashboard").hidden = false;
  ["editTask", "copyLink", "showQr", "openFileManager", "exportCsv", "downloadZip"].forEach((id) => $(`#${id}`).disabled = true);
  await loadTasks();
  closeEditor();
  toast("任务已删除", "ok");
}

async function download(path, filename) {
  const response = await fetch(path, { credentials: "same-origin" });
  if (response.status === 401) {
    setAuthed(false);
    throw new Error("登录已过期，请重新登录");
  }
  if (!response.ok) throw new Error("下载失败");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text, done = "已复制") {
  if (!text) throw new Error("没有可复制的内容");
  if (!navigator.clipboard) throw new Error("当前浏览器不允许访问剪贴板");
  await navigator.clipboard.writeText(text);
  toast(done, "ok");
}

function missingClipboardText() {
  const missing = state.detail?.stats?.missing || [];
  return missing.map((item, index) => `${index + 1}. ${item}`).join("\r\n");
}

function bind() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#loginMessage").textContent = "正在登录...";
    $("#loginMessage").className = "message";
    try {
      await login($("#loginPassword").value);
      $("#loginPassword").value = "";
      $("#loginMessage").textContent = "";
    } catch (error) {
      $("#loginMessage").textContent = error.message;
      $("#loginMessage").className = "message error";
    }
  });
  $("#logout").addEventListener("click", safe(logout));
  $("#openSettings").addEventListener("click", safe(() => {
    $("#siteTitle").value = state.settings.siteTitle || "Filestore";
    $("#siteUrl").value = state.settings.siteUrl || "";
    $("#settingsMessage").textContent = "";
    $("#passwordMessage").textContent = "";
    $("#currentPassword").value = "";
    $("#newPassword").value = "";
    $("#confirmPassword").value = "";
    $("#settingsDialog").showModal();
  }));
  $("#closeSettings").addEventListener("click", () => $("#settingsDialog").close());
  $("#clearSiteUrl").addEventListener("click", () => {
    $("#siteUrl").value = "";
  });
  $("#saveSettings").addEventListener("click", safe(async () => {
    $("#settingsMessage").textContent = "正在保存...";
    $("#settingsMessage").className = "message";
    const settings = await saveSettings($("#siteUrl").value);
    $("#siteTitle").value = settings.siteTitle || "Filestore";
    $("#siteUrl").value = settings.siteUrl || "";
    $("#settingsMessage").textContent = "设置已保存";
    $("#settingsMessage").className = "message ok";
    toast("系统设置已保存", "ok");
  }));
  $("#changePassword").addEventListener("click", safe(async () => {
    $("#passwordMessage").textContent = "正在修改...";
    $("#passwordMessage").className = "message";
    await changePassword();
  }));
  $("#newTask").addEventListener("click", safe(() => openEditor(null)));
  $("#emptyNewTask").addEventListener("click", safe(() => openEditor(null)));
  $("#editTask").addEventListener("click", safe(() => openEditor(state.current)));
  $("#closeEditor").addEventListener("click", closeEditor);
  $("#drawerScrim").addEventListener("click", closeEditor);
  $("#taskSearch").addEventListener("input", renderTaskList);
  $("#submissionSearch").addEventListener("input", renderSubmissionTable);
  $("#addField").addEventListener("click", safe(() => addField({ required: true })));
  $("#templateSelect").addEventListener("change", () => {
    state.templateKey = $("#templateSelect").value;
    $("#deleteTemplate").disabled = state.templateKey.startsWith("builtin:");
  });
  $("#applyTemplate").addEventListener("click", safe(() => applyTemplate()));
  $("#deleteTemplate").addEventListener("click", safe(deleteSelectedTemplate));
  $("#saveTask").addEventListener("click", safe(saveTask));
  $("#saveTemplate").addEventListener("click", safe(saveTemplate));
  $("#resetEditor").addEventListener("click", safe(() => fillEditor(state.mode === "edit" ? state.current : null)));
  $("#deleteTask").addEventListener("click", safe(deleteTask));
  $("#copyLink").addEventListener("click", safe(() => copyText(absoluteSubmitUrl(state.current), "提交链接已复制")));
  $("#copyLinkInline").addEventListener("click", safe(() => copyText(absoluteSubmitUrl(state.current), "提交链接已复制")));
  $("#copyMissing").addEventListener("click", safe(() => copyText(missingClipboardText(), "缺交名单已复制")));
  $("#showQr").addEventListener("click", safe(() => {
    const url = absoluteSubmitUrl(state.current);
    if (!url) throw new Error("请先选择任务");
    $("#qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(url)}`;
    $("#qrLink").textContent = url;
    $("#qrDialog").showModal();
  }));
  $("#closeQr").addEventListener("click", () => $("#qrDialog").close());
  $("#openFileManager").addEventListener("click", safe(openFileManager));
  $("#openFileManagerInline").addEventListener("click", safe(openFileManager));
  $("#closeFileDialog").addEventListener("click", () => $("#fileDialog").close());
  $("#fileSearch").addEventListener("input", renderFileManager);
  $("#exportCsv").addEventListener("click", safe(() => download(`/api/tasks/${state.current.id}/export.csv`, `${state.current.title}.csv`)));
  $("#downloadZip").addEventListener("click", safe(() => download(`/api/tasks/${state.current.id}/download.zip`, `${state.current.title}.zip`)));
}

fillEditor(null);
bind();
checkSession();
