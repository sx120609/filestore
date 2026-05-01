const state = {
  tasks: [],
  current: null,
  detail: null,
  mode: "create",
  identifierType: "student",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const identifierRules = {
  student: { label: "学号", pattern: "^2020\\d{6}$", placeholder: "例如 2020240444" },
  exam: { label: "考试号", pattern: "^24201505\\d{2}$", placeholder: "例如 2420150508" },
};

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

async function checkSession() {
  try {
    await api("/api/admin/me");
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
  $("#createMessage").textContent = text;
  $("#createMessage").className = `message ${type}`;
}

function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function absoluteSubmitUrl(task) {
  return task ? `${location.origin}${task.submitUrl}` : "";
}

function defaultFields(identifierType = state.identifierType) {
  const identifier = identifierRules[identifierType] || identifierRules.student;
  return [
    { label: "姓名", key: "name", required: true, pattern: "^[\\u4e00-\\u9fa5·]{2,20}$", placeholder: "请输入中文姓名" },
    { label: identifier.label, key: "student_id", required: true, pattern: identifier.pattern, placeholder: identifier.placeholder },
  ];
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

function inferIdentifierType(fields) {
  const identifier = fields.find((field) => field.key === "student_id");
  state.identifierType = identifier?.label === "考试号" || identifier?.pattern === identifierRules.exam.pattern ? "exam" : "student";
  $("#identifierType").value = state.identifierType;
}

function fillEditor(task) {
  $("#editorTitle").textContent = task ? "编辑任务" : "新建任务";
  $("#title").value = task?.title || "";
  $("#description").value = task?.description || "";
  $("#deadline").value = localDateTime(task?.deadline);
  $("#taskStatus").value = task?.status || "open";
  $("#allowedTypes").value = task?.fileRules?.allowedTypes?.join(",") || "pdf,doc,docx,jpg,png,zip";
  $("#maxSizeMb").value = task?.fileRules?.maxSizeMb || 20;
  $("#maxCount").value = task?.fileRules?.maxCount || 1;
  $("#renameTemplate").value = task?.renameTemplate || "{name}-{student_id}";
  $("#expectedEntries").value = task?.expectedEntries || "";
  setFields(task?.fields?.length ? task.fields : defaultFields());
  inferIdentifierType(task?.fields || []);
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
    <dt>文件类型</dt><dd>${rules.allowedTypes.join(", ") || "不限"}</dd>
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
    button.addEventListener("click", () => deleteSubmission(button.dataset.delete));
  });
  bindFileActionButtons();
}

function bindFileActionButtons() {
  $$("[data-file-preview]").forEach((button) => {
    button.onclick = () => previewFile(button.dataset.filePreview);
  });
  $$("[data-file-download]").forEach((button) => {
    button.onclick = () => downloadFile(button.dataset.fileDownload);
  });
  $$("[data-file-delete]").forEach((button) => {
    button.onclick = () => deleteFile(button.dataset.fileDelete);
  });
}

function previewFile(id) {
  window.open(`/api/files/${id}/preview`, "_blank", "noopener");
}

function downloadFile(id) {
  window.open(`/api/files/${id}/download`, "_blank", "noopener");
}

async function deleteFile(id) {
  if (!confirm("删除这个文件？提交记录会保留，但该文件会从服务器移除。")) return;
  await api(`/api/files/${id}`, { method: "DELETE" });
  await selectTask(state.current.id);
  if ($("#fileDialog").open) renderFileManager();
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
  if (!confirm("删除这条提交记录及文件？")) return;
  await api(`/api/submissions/${id}`, { method: "DELETE" });
  await selectTask(state.current.id);
}

async function deleteTask() {
  if (!state.current || !confirm(`删除任务「${state.current.title}」及所有提交文件？`)) return;
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
  await navigator.clipboard.writeText(text);
  toast(done, "ok");
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
  $("#logout").addEventListener("click", logout);
  $("#newTask").addEventListener("click", () => openEditor(null));
  $("#emptyNewTask").addEventListener("click", () => openEditor(null));
  $("#editTask").addEventListener("click", () => openEditor(state.current));
  $("#closeEditor").addEventListener("click", closeEditor);
  $("#drawerScrim").addEventListener("click", closeEditor);
  $("#taskSearch").addEventListener("input", renderTaskList);
  $("#submissionSearch").addEventListener("input", renderSubmissionTable);
  $("#addField").addEventListener("click", () => addField({ required: true }));
  $("#identifierType").addEventListener("change", () => {
    state.identifierType = $("#identifierType").value;
    if (state.mode === "create") setFields(defaultFields());
  });
  $("[data-preset='student']").addEventListener("click", () => setFields(defaultFields()));
  $("#saveTask").addEventListener("click", saveTask);
  $("#resetEditor").addEventListener("click", () => fillEditor(state.mode === "edit" ? state.current : null));
  $("#deleteTask").addEventListener("click", deleteTask);
  $("#copyLink").addEventListener("click", () => copyText(absoluteSubmitUrl(state.current), "提交链接已复制"));
  $("#copyLinkInline").addEventListener("click", () => copyText(absoluteSubmitUrl(state.current), "提交链接已复制"));
  $("#copyMissing").addEventListener("click", () => copyText(state.detail.stats.missing.join("\n"), "缺交名单已复制"));
  $("#showQr").addEventListener("click", () => {
    const url = absoluteSubmitUrl(state.current);
    $("#qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(url)}`;
    $("#qrLink").textContent = url;
    $("#qrDialog").showModal();
  });
  $("#closeQr").addEventListener("click", () => $("#qrDialog").close());
  $("#openFileManager").addEventListener("click", openFileManager);
  $("#openFileManagerInline").addEventListener("click", openFileManager);
  $("#closeFileDialog").addEventListener("click", () => $("#fileDialog").close());
  $("#fileSearch").addEventListener("input", renderFileManager);
  $("#exportCsv").addEventListener("click", () => download(`/api/tasks/${state.current.id}/export.csv`, `${state.current.title}.csv`).catch((error) => toast(error.message, "error")));
  $("#downloadZip").addEventListener("click", () => download(`/api/tasks/${state.current.id}/download.zip`, `${state.current.title}.zip`).catch((error) => toast(error.message, "error")));
}

fillEditor(null);
bind();
checkSession();
