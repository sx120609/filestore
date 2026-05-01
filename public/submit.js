const token = location.pathname.split("/").pop();
let task = null;

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function message(text, type = "") {
  const node = $("#submitMessage");
  node.textContent = text;
  node.className = `message submit-form ${type}`;
}

function renderTask() {
  const isClosed = task.status !== "open";
  document.title = `${task.siteTitle || "Filestore"} - ${task.title}`;
  $("#submitHeader").innerHTML = `
    <p class="eyebrow">${isClosed ? "CLOSED" : "FILE SUBMISSION"}</p>
    <h1>${escapeHtml(task.title)}</h1>
    <p>${escapeHtml(task.description || "请填写信息并上传要求的文件。")}</p>
    ${task.deadline ? `<p class="hint">截止时间：${new Date(task.deadline).toLocaleString()}</p>` : ""}
  `;

  if (isClosed) {
    message("该任务已停止提交。", "error");
    return;
  }

  $("#dynamicFields").innerHTML = task.fields.map((field) => `
    <label>${escapeHtml(field.label)}
      <input
        name="${escapeHtml(field.key)}"
        placeholder="${escapeHtml(field.placeholder || "")}"
        ${field.required ? "required" : ""}
        ${field.pattern ? `pattern="${escapeHtml(field.pattern)}"` : ""}
      >
    </label>
  `).join("");
  const rules = task.fileRules;
  $("#files").setAttribute("accept", rules.allowedTypes.map((item) => `.${item}`).join(","));
  $("#fileRules").textContent = `允许 ${rules.allowedTypes.join(", ") || "任意类型"}；单文件不超过 ${rules.maxSizeMb} MB；最多 ${rules.maxCount} 个。`;
  $("#submitForm").hidden = false;
}

async function loadTask() {
  try {
    const response = await fetch(`/api/public/tasks/${token}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "任务加载失败");
    task = payload;
    renderTask();
  } catch (error) {
    $("#submitHeader").innerHTML = `<p class="eyebrow">ERROR</p><h1>无法提交</h1><p>${escapeHtml(error.message)}</p>`;
  }
}

function validateFiles(files) {
  const rules = task.fileRules;
  if (!files.length) return "请上传文件";
  if (files.length > Number(rules.maxCount)) return `最多只能上传 ${rules.maxCount} 个文件`;
  const allowed = new Set(rules.allowedTypes);
  const maxBytes = Number(rules.maxSizeMb) * 1024 * 1024;
  for (const file of files) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (allowed.size && !allowed.has(ext)) return `${file.name} 类型不允许`;
    if (file.size > maxBytes) return `${file.name} 超过大小限制`;
  }
  return "";
}

$("#submitForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...$("#files").files];
  const fileError = validateFiles(files);
  if (fileError) {
    message(fileError, "error");
    return;
  }

  const formData = new FormData(form);
  const xhr = new XMLHttpRequest();
  $("#progress").hidden = false;
  $("#progress").value = 0;

  xhr.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) $("#progress").value = Math.round((event.loaded / event.total) * 100);
  });

  xhr.addEventListener("load", () => {
    const payload = JSON.parse(xhr.responseText || "{}");
    if (xhr.status >= 200 && xhr.status < 300) {
      form.reset();
      $("#progress").value = 100;
      message(`提交成功，编号 ${payload.submissionId}。文件：${payload.files.join("、")}`, "ok");
    } else {
      message(payload.details ? payload.details.join("；") : payload.error || "提交失败", "error");
    }
  });

  xhr.addEventListener("error", () => message("网络错误，提交失败", "error"));
  xhr.open("POST", `/api/submit/${token}`);
  xhr.send(formData);
  message("正在上传...");
});

loadTask();
