from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import string
import warnings
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

warnings.filterwarnings("ignore", message="'cgi' is deprecated.*", category=DeprecationWarning)
from cgi import FieldStorage


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "filestore.db"
ADMIN_PASSWORD = os.environ.get("FILESTORE_ADMIN_PASSWORD", "admin123")
MAX_REQUEST_BYTES = 1024 * 1024 * 1024
SESSIONS: set[str] = set()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_filename(value: str) -> str:
    allowed = f"-_.() {string.ascii_letters}{string.digits}"
    cleaned = "".join(ch if ch in allowed or "\u4e00" <= ch <= "\u9fff" else "_" for ch in value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:140] or "file"


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    if length > MAX_REQUEST_BYTES:
        raise ValueError("请求体过大")
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                deadline TEXT,
                fields_json TEXT NOT NULL,
                file_rules_json TEXT NOT NULL,
                rename_template TEXT NOT NULL DEFAULT '{name}-{student_id}',
                folder_template TEXT NOT NULL DEFAULT '{name}-{student_id}',
                expected_entries TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                data_json TEXT NOT NULL,
                ip TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'submitted',
                created_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_id INTEGER NOT NULL,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                path TEXT NOT NULL,
                FOREIGN KEY(submission_id) REFERENCES submissions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        task_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        if "folder_template" not in task_columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN folder_template TEXT NOT NULL DEFAULT '{name}-{student_id}'")


def task_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "token": row["token"],
        "title": row["title"],
        "description": row["description"],
        "deadline": row["deadline"],
        "fields": json.loads(row["fields_json"]),
        "fileRules": json.loads(row["file_rules_json"]),
        "renameTemplate": row["rename_template"],
        "folderTemplate": row["folder_template"],
        "expectedEntries": row["expected_entries"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "submitUrl": f"/submit/{row['token']}",
    }


def get_setting(key: str, default: str = "") -> str:
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def admin_password() -> str:
    return get_setting("admin_password", ADMIN_PASSWORD)


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO settings (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )


def normalize_site_url(value: str) -> str:
    site_url = str(value or "").strip().rstrip("/")
    if not site_url:
        return ""
    parsed = urlparse(site_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("站点地址必须是完整 URL，例如 https://files.example.com")
    if parsed.path not in {"", "/"}:
        raise ValueError("站点地址只填写域名根地址，不要包含路径")
    return site_url


def app_settings() -> dict:
    raw_template = get_setting("task_template")
    legacy_template = json.loads(raw_template) if raw_template else None
    raw_templates = get_setting("task_templates")
    templates = json.loads(raw_templates) if raw_templates else []
    if legacy_template and not templates:
        legacy_template["id"] = "legacy-template"
        legacy_template["name"] = "已保存模板"
        templates = [legacy_template]
    return {
        "siteUrl": get_setting("site_url"),
        "siteTitle": get_setting("site_title", "Filestore"),
        "taskTemplates": templates,
    }


def validate_task_template(template: dict) -> dict:
    fields = template.get("fields") or []
    if not isinstance(fields, list) or not fields:
        raise ValueError("模板至少需要一个字段")
    normalized = normalize_task_payload(
        {
            "title": "template",
            "fields": fields,
            "fileRules": template.get("fileRules") or {},
            "renameTemplate": template.get("renameTemplate", "{name}-{student_id}"),
            "folderTemplate": template.get("folderTemplate", "{name}-{student_id}"),
            "expectedEntries": "",
        }
    )
    return {
        "id": str(template.get("id") or secrets.token_urlsafe(8)),
        "name": str(template.get("name") or "未命名模板").strip()[:40] or "未命名模板",
        "fields": normalized["fields"],
        "fileRules": normalized["fileRules"],
        "renameTemplate": normalized["renameTemplate"],
        "folderTemplate": normalized["folderTemplate"],
    }


def cookie_value(handler: SimpleHTTPRequestHandler, name: str) -> str:
    cookie = handler.headers.get("Cookie", "")
    for part in cookie.split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return ""


def current_session(handler: SimpleHTTPRequestHandler) -> str:
    return cookie_value(handler, "filestore_session")


def require_admin(handler: SimpleHTTPRequestHandler) -> bool:
    session = current_session(handler)
    if not session or session not in SESSIONS:
        send_json(handler, {"error": "请先登录"}, HTTPStatus.UNAUTHORIZED)
        return False
    return True


def send_json(
    handler: SimpleHTTPRequestHandler,
    payload: dict | list,
    status: HTTPStatus = HTTPStatus.OK,
    extra_headers: dict[str, str] | None = None,
) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for key, value in (extra_headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def send_text(handler: SimpleHTTPRequestHandler, text: str, status: HTTPStatus = HTTPStatus.OK) -> None:
    body = text.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def normalize_task_payload(payload: dict) -> dict:
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("任务标题不能为空")

    fields = payload.get("fields") or []
    if not isinstance(fields, list) or not fields:
        raise ValueError("至少需要一个表单字段")

    normalized_fields = []
    keys = set()
    for field in fields:
        key = re.sub(r"[^a-zA-Z0-9_]", "_", str(field.get("key", "")).strip())
        label = str(field.get("label", "")).strip()
        if not key or not label:
            raise ValueError("字段 key 和名称不能为空")
        if key in keys:
            raise ValueError(f"字段 key 重复：{key}")
        pattern = str(field.get("pattern", "")).strip()
        if pattern:
            re.compile(pattern)
        keys.add(key)
        normalized_fields.append(
            {
                "key": key,
                "label": label,
                "required": bool(field.get("required", True)),
                "pattern": pattern,
                "placeholder": str(field.get("placeholder", "")).strip(),
            }
        )

    rules = payload.get("fileRules") or {}
    raw_allowed_types = rules.get("allowedTypes", "")
    if isinstance(raw_allowed_types, list):
        allowed_types = [str(item).strip().lower() for item in raw_allowed_types if str(item).strip()]
    else:
        allowed_types = [item.strip().lower() for item in str(raw_allowed_types).split(",") if item.strip()]
    max_size_mb = float(rules.get("maxSizeMb") or 20)
    max_count = int(rules.get("maxCount") or 1)
    if max_size_mb <= 0 or max_count <= 0:
        raise ValueError("文件大小和数量限制必须大于 0")

    return {
        "title": title,
        "description": str(payload.get("description", "")).strip(),
        "deadline": str(payload.get("deadline", "")).strip() or None,
        "fields": normalized_fields,
        "fileRules": {
            "allowedTypes": allowed_types,
            "maxSizeMb": max_size_mb,
            "maxCount": max_count,
        },
        "renameTemplate": str(payload.get("renameTemplate", "{name}-{student_id}")).strip() or "{name}",
        "folderTemplate": str(payload.get("folderTemplate", "{name}-{student_id}")).strip() or "{name}",
        "expectedEntries": str(payload.get("expectedEntries", "")).strip(),
        "status": str(payload.get("status", "open")).strip() or "open",
    }


def validate_submission(task: dict, data: dict, files: list[FieldStorage]) -> list[str]:
    errors = []
    if task["status"] != "open":
        errors.append("任务未开放提交")
    if task["deadline"]:
        try:
            deadline = datetime.fromisoformat(task["deadline"])
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > deadline.astimezone(timezone.utc):
                errors.append("已超过截止时间")
        except ValueError:
            pass

    for field in task["fields"]:
        value = str(data.get(field["key"], "")).strip()
        if field["required"] and not value:
            errors.append(f"{field['label']}不能为空")
        if value and field["pattern"] and not re.fullmatch(field["pattern"], value):
            errors.append(f"{field['label']}格式不正确")

    rules = task["fileRules"]
    if not files:
        errors.append("至少需要上传一个文件")
    if len(files) > int(rules["maxCount"]):
        errors.append(f"最多只能上传 {rules['maxCount']} 个文件")

    allowed = set(rules["allowedTypes"])
    max_bytes = int(float(rules["maxSizeMb"]) * 1024 * 1024)
    for item in files:
        original = item.filename or ""
        ext = Path(original).suffix.lower().lstrip(".")
        item.file.seek(0, os.SEEK_END)
        size = item.file.tell()
        item.file.seek(0)
        if allowed and ext not in allowed:
            errors.append(f"{original} 类型不允许")
        if size > max_bytes:
            errors.append(f"{original} 超过 {rules['maxSizeMb']} MB")
    return errors


def clean_rendered_name(value: str) -> str:
    value = safe_filename(value)
    value = re.sub(r"[-_ ]{2,}", "-", value)
    return value.strip(" -_.") or "file"


def render_template_base(template: str, data: dict, original_name: str = "", index: int = 1, total_count: int = 1) -> str:
    values = {key: safe_filename(str(value)) for key, value in data.items()}
    values.update({
        "index": str(index) if total_count > 1 else "",
        "original": safe_filename(Path(original_name).stem),
    })

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        op = match.group(2)
        arg = match.group(3)
        value = values.get(key, "")
        if op == "last":
            count = int(arg or "0")
            return value[-count:] if count > 0 else ""
        if op == "first":
            count = int(arg or "0")
            return value[:count] if count > 0 else ""
        return value

    rendered = re.sub(r"\{([a-zA-Z0-9_]+)(?:\|(last|first):(\d{1,2}))?\}", repl, template)
    return clean_rendered_name(rendered)


def render_name(template: str, data: dict, original_name: str, index: int, total_count: int = 1) -> str:
    ext = Path(original_name).suffix
    rendered = render_template_base(template, data, original_name, index, total_count)
    if total_count > 1 and "{index}" not in template:
        rendered = f"{rendered}-{index}"
    return f"{rendered}{ext.lower()}"


def submission_folder_name(task: dict, submission: dict) -> str:
    data = submission.get("data") or {}
    template = task.get("folderTemplate") or "{name}-{student_id}"
    return render_template_base(template, data) or clean_rendered_name(f"submission-{submission.get('id', '')}")


def get_task_by_token(token: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE token = ?", (token,)).fetchone()
    return task_to_dict(row) if row else None


def build_task_detail(task_id: int) -> dict | None:
    with connect() as conn:
        task_row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not task_row:
            return None
        rows = conn.execute(
            """
            SELECT s.*, COALESCE(
                json_group_array(json_object(
                    'id', f.id,
                    'originalName', f.original_name,
                    'storedName', f.stored_name,
                    'mimeType', f.mime_type,
                    'size', f.size
                )) FILTER (WHERE f.id IS NOT NULL),
                '[]'
            ) AS files_json
            FROM submissions s
            LEFT JOIN files f ON f.submission_id = s.id
            WHERE s.task_id = ?
            GROUP BY s.id
            ORDER BY s.created_at DESC
            """,
            (task_id,),
        ).fetchall()
    task = task_to_dict(task_row)
    submissions = []
    for row in rows:
        submissions.append(
            {
                "id": row["id"],
                "data": json.loads(row["data_json"]),
                "ip": row["ip"],
                "status": row["status"],
                "createdAt": row["created_at"],
                "files": json.loads(row["files_json"]),
            }
        )
    task["submissions"] = submissions
    expected = [line.strip() for line in task["expectedEntries"].splitlines() if line.strip()]
    expected_keys = set(expected)
    matched_submitted_keys = set()
    unexpected = []
    for item in submissions:
        identity = (item["data"].get("student_id") or item["data"].get("name") or "").strip()
        if expected_keys and identity in expected_keys:
            matched_submitted_keys.add(identity)
        elif expected_keys:
            unexpected.append(
                {
                    "id": item["id"],
                    "name": item["data"].get("name") or "",
                    "identity": identity,
                    "createdAt": item["createdAt"],
                }
            )
    task["stats"] = {
        "submitted": len(submissions),
        "inListSubmitted": len(matched_submitted_keys) if expected else len(submissions),
        "expected": len(expected),
        "missing": [item for item in expected if item not in matched_submitted_keys],
        "unexpected": unexpected,
    }
    return task


def build_public_status(token: str) -> dict | None:
    task = get_task_by_token(token)
    if not task:
        return None
    detail = build_task_detail(task["id"])
    if not detail:
        return None

    field_keys = [field["key"] for field in detail["fields"]]
    submissions = []
    for item in detail["submissions"]:
        data = item["data"]
        display_name = str(data.get("name") or "").strip()
        identity = str(data.get("student_id") or "").strip()
        if not display_name and field_keys:
            display_name = str(data.get(field_keys[0]) or "").strip()
        if not identity:
            for key in field_keys:
                value = str(data.get(key) or "").strip()
                if value and value != display_name:
                    identity = value
                    break
        submissions.append(
            {
                "id": item["id"],
                "displayName": display_name or f"提交 #{item['id']}",
                "identity": identity,
                "createdAt": item["createdAt"],
                "files": [
                    {
                        "storedName": file["storedName"],
                        "size": file["size"],
                    }
                    for file in item["files"]
                ],
            }
        )

    return {
        "title": detail["title"],
        "deadline": detail["deadline"],
        "status": detail["status"],
        "siteTitle": get_setting("site_title", "Filestore"),
        "stats": {
            "submitted": detail["stats"]["submitted"],
            "expected": detail["stats"]["expected"],
            "missing": len(detail["stats"]["missing"]),
        },
        "submissions": submissions,
    }


def delete_task_files(task_id: int) -> None:
    task_dir = UPLOAD_DIR / str(task_id)
    if task_dir.exists() and task_dir.is_dir():
        shutil.rmtree(task_dir)


def delete_submission_files(conn: sqlite3.Connection, submission_id: int) -> None:
    rows = conn.execute("SELECT path FROM files WHERE submission_id = ?", (submission_id,)).fetchall()
    conn.execute("DELETE FROM files WHERE submission_id = ?", (submission_id,))
    conn.execute("DELETE FROM submissions WHERE id = ?", (submission_id,))
    for row in rows:
        path = ROOT / row["path"]
        if path.exists():
            path.unlink()


def submission_identity(data: dict) -> str:
    return str(data.get("student_id") or data.get("name") or "").strip()


def get_file_row(file_id: int) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            """
            SELECT
                f.*,
                s.task_id,
                s.data_json,
                s.created_at AS submission_created_at,
                t.title AS task_title
            FROM files f
            JOIN submissions s ON s.id = f.submission_id
            JOIN tasks t ON t.id = s.task_id
            WHERE f.id = ?
            """,
            (file_id,),
        ).fetchone()


def file_row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "submissionId": row["submission_id"],
        "taskId": row["task_id"],
        "originalName": row["original_name"],
        "storedName": row["stored_name"],
        "mimeType": row["mime_type"],
        "size": row["size"],
        "path": row["path"],
        "taskTitle": row["task_title"],
        "submissionData": json.loads(row["data_json"]),
        "submissionCreatedAt": row["submission_created_at"],
    }


def resolve_stored_file(row: sqlite3.Row) -> Path | None:
    source = (ROOT / row["path"]).resolve()
    uploads_root = UPLOAD_DIR.resolve()
    if uploads_root not in source.parents:
        return None
    return source if source.exists() and source.is_file() else None


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "Filestore/0.1"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        if parsed.path == "/":
            return str(PUBLIC / "admin.html")
        if parsed.path.startswith("/submit/"):
            return str(PUBLIC / "submit.html")
        if parsed.path.startswith("/status/"):
            return str(PUBLIC / "status.html")
        return str(PUBLIC / parsed.path.lstrip("/"))

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            send_json(self, {"ok": True, "time": now_iso()})
            return
        if path == "/api/admin/me":
            if not require_admin(self):
                return
            send_json(self, {"ok": True, "role": "admin", "settings": app_settings()})
            return
        if path == "/api/settings":
            if not require_admin(self):
                return
            send_json(self, app_settings())
            return
        if path == "/api/tasks":
            if not require_admin(self):
                return
            with connect() as conn:
                rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
            send_json(self, [task_to_dict(row) for row in rows])
            return
        match = re.fullmatch(r"/api/tasks/(\d+)", path)
        if match:
            if not require_admin(self):
                return
            task = build_task_detail(int(match.group(1)))
            if not task:
                send_json(self, {"error": "任务不存在"}, HTTPStatus.NOT_FOUND)
                return
            send_json(self, task)
            return
        match = re.fullmatch(r"/api/public/tasks/([A-Za-z0-9_-]+)", path)
        if match:
            task = get_task_by_token(match.group(1))
            if not task:
                send_json(self, {"error": "提交链接不存在"}, HTTPStatus.NOT_FOUND)
                return
            public_task = {key: task[key] for key in ["title", "description", "deadline", "fields", "fileRules", "renameTemplate", "folderTemplate", "status"]}
            public_task["siteTitle"] = get_setting("site_title", "Filestore")
            send_json(self, public_task)
            return
        match = re.fullmatch(r"/api/public/status/([A-Za-z0-9_-]+)", path)
        if match:
            status = build_public_status(match.group(1))
            if not status:
                send_json(self, {"error": "成功名单不存在"}, HTTPStatus.NOT_FOUND)
                return
            send_json(self, status)
            return
        match = re.fullmatch(r"/api/tasks/(\d+)/export.csv", path)
        if match:
            if not require_admin(self):
                return
            self.export_csv(int(match.group(1)))
            return
        match = re.fullmatch(r"/api/tasks/(\d+)/download.zip", path)
        if match:
            if not require_admin(self):
                return
            send_json(self, {"error": "ZIP 已改为浏览器端打包，请在管理界面点击下载 ZIP"}, HTTPStatus.GONE)
            return
        match = re.fullmatch(r"/api/files/(\d+)", path)
        if match:
            if not require_admin(self):
                return
            row = get_file_row(int(match.group(1)))
            if not row:
                send_json(self, {"error": "文件不存在"}, HTTPStatus.NOT_FOUND)
                return
            send_json(self, file_row_to_dict(row))
            return
        match = re.fullmatch(r"/api/files/(\d+)/(download|preview)", path)
        if match:
            if not require_admin(self):
                return
            self.send_file(int(match.group(1)), inline=match.group(2) == "preview")
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/admin/login":
            payload = read_json_body(self)
            if secrets.compare_digest(str(payload.get("password", "")), admin_password()):
                session = secrets.token_urlsafe(32)
                SESSIONS.add(session)
                send_json(
                    self,
                    {"ok": True, "role": "admin", "settings": app_settings()},
                    extra_headers={
                        "Set-Cookie": f"filestore_session={session}; Path=/; HttpOnly; SameSite=Lax"
                    },
                )
            else:
                send_json(self, {"error": "管理员密码错误"}, HTTPStatus.UNAUTHORIZED)
            return
        if path == "/api/admin/password":
            if not require_admin(self):
                return
            payload = read_json_body(self)
            current = str(payload.get("currentPassword", ""))
            new_password = str(payload.get("newPassword", ""))
            if not secrets.compare_digest(current, admin_password()):
                send_json(self, {"error": "当前密码错误"}, HTTPStatus.BAD_REQUEST)
                return
            if len(new_password) < 6:
                send_json(self, {"error": "新密码至少需要 6 位"}, HTTPStatus.BAD_REQUEST)
                return
            set_setting("admin_password", new_password)
            SESSIONS.clear()
            send_json(
                self,
                {"ok": True},
                extra_headers={
                    "Set-Cookie": "filestore_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
                },
            )
            return
        if path == "/api/admin/logout":
            session = current_session(self)
            if session:
                SESSIONS.discard(session)
            send_json(
                self,
                {"ok": True},
                extra_headers={
                    "Set-Cookie": "filestore_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
                },
            )
            return
        if path == "/api/settings":
            if not require_admin(self):
                return
            try:
                payload = read_json_body(self)
                site_url = normalize_site_url(str(payload.get("siteUrl", "")))
                site_title = str(payload.get("siteTitle", "Filestore")).strip()[:60] or "Filestore"
                templates_value = None
                should_update_templates = "taskTemplates" in payload
                if should_update_templates:
                    templates = payload.get("taskTemplates") or []
                    if not isinstance(templates, list):
                        raise ValueError("模板数据格式不正确")
                    templates_value = json.dumps(
                        [validate_task_template(item) for item in templates],
                        ensure_ascii=False,
                    )
            except Exception as exc:
                send_json(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            set_setting("site_url", site_url)
            set_setting("site_title", site_title)
            if should_update_templates:
                set_setting("task_templates", templates_value or "[]")
                set_setting("task_template", "")
            send_json(self, app_settings())
            return
        if path == "/api/tasks":
            if not require_admin(self):
                return
            try:
                payload = normalize_task_payload(read_json_body(self))
            except Exception as exc:
                send_json(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            token = secrets.token_urlsafe(12)
            with connect() as conn:
                conn.execute(
                    """
                    INSERT INTO tasks (
                        token, title, description, deadline, fields_json, file_rules_json,
                        rename_template, folder_template, expected_entries, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        token,
                        payload["title"],
                        payload["description"],
                        payload["deadline"],
                        json.dumps(payload["fields"], ensure_ascii=False),
                        json.dumps(payload["fileRules"], ensure_ascii=False),
                        payload["renameTemplate"],
                        payload["folderTemplate"],
                        payload["expectedEntries"],
                        payload["status"],
                        now_iso(),
                    ),
                )
                task_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            send_json(self, build_task_detail(task_id), HTTPStatus.CREATED)
            return
        match = re.fullmatch(r"/api/submit/([A-Za-z0-9_-]+)", path)
        if match:
            self.handle_submit(match.group(1))
            return
        send_json(self, {"error": "接口不存在"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:
        if not require_admin(self):
            return
        path = urlparse(self.path).path
        task_match = re.fullmatch(r"/api/tasks/(\d+)", path)
        if task_match:
            try:
                payload = normalize_task_payload(read_json_body(self))
            except Exception as exc:
                send_json(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return
            task_id = int(task_match.group(1))
            with connect() as conn:
                cursor = conn.execute(
                    """
                    UPDATE tasks
                    SET title = ?, description = ?, deadline = ?, fields_json = ?,
                        file_rules_json = ?, rename_template = ?, folder_template = ?, expected_entries = ?, status = ?
                    WHERE id = ?
                    """,
                    (
                        payload["title"],
                        payload["description"],
                        payload["deadline"],
                        json.dumps(payload["fields"], ensure_ascii=False),
                        json.dumps(payload["fileRules"], ensure_ascii=False),
                        payload["renameTemplate"],
                        payload["folderTemplate"],
                        payload["expectedEntries"],
                        payload["status"],
                        task_id,
                    ),
                )
            if cursor.rowcount == 0:
                send_json(self, {"error": "任务不存在"}, HTTPStatus.NOT_FOUND)
                return
            send_json(self, build_task_detail(task_id))
            return

        send_json(self, {"error": "接口不存在"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        if not require_admin(self):
            return
        path = urlparse(self.path).path
        task_match = re.fullmatch(r"/api/tasks/(\d+)", path)
        if task_match:
            task_id = int(task_match.group(1))
            with connect() as conn:
                submission_rows = conn.execute("SELECT id FROM submissions WHERE task_id = ?", (task_id,)).fetchall()
                submission_ids = [row["id"] for row in submission_rows]
                if submission_ids:
                    marks = ",".join("?" for _ in submission_ids)
                    conn.execute(f"DELETE FROM files WHERE submission_id IN ({marks})", submission_ids)
                    conn.execute(f"DELETE FROM submissions WHERE id IN ({marks})", submission_ids)
                cursor = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            delete_task_files(task_id)
            if cursor.rowcount == 0:
                send_json(self, {"error": "任务不存在"}, HTTPStatus.NOT_FOUND)
                return
            send_json(self, {"ok": True})
            return

        match = re.fullmatch(r"/api/submissions/(\d+)", path)
        if match:
            submission_id = int(match.group(1))
            with connect() as conn:
                files = conn.execute("SELECT path FROM files WHERE submission_id = ?", (submission_id,)).fetchall()
                conn.execute("DELETE FROM files WHERE submission_id = ?", (submission_id,))
                conn.execute("DELETE FROM submissions WHERE id = ?", (submission_id,))
            for row in files:
                path = ROOT / row["path"]
                if path.exists():
                    path.unlink()
            send_json(self, {"ok": True})
            return

        file_match = re.fullmatch(r"/api/files/(\d+)", path)
        if not file_match:
            send_json(self, {"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
            return
        file_id = int(file_match.group(1))
        with connect() as conn:
            row = conn.execute("SELECT path FROM files WHERE id = ?", (file_id,)).fetchone()
            if not row:
                send_json(self, {"error": "文件不存在"}, HTTPStatus.NOT_FOUND)
                return
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        path = ROOT / row["path"]
        if path.exists():
            path.unlink()
        send_json(self, {"ok": True})

    def handle_submit(self, token: str) -> None:
        task = get_task_by_token(token)
        if not task:
            send_json(self, {"error": "提交链接不存在"}, HTTPStatus.NOT_FOUND)
            return

        form = FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST"})
        data = {}
        upload_items = []
        for key in form.keys():
            item = form[key]
            items = item if isinstance(item, list) else [item]
            for entry in items:
                if entry.filename:
                    upload_items.append(entry)
                else:
                    data[key] = entry.value

        errors = validate_submission(task, data, upload_items)
        if errors:
            send_json(self, {"error": "提交校验失败", "details": errors}, HTTPStatus.BAD_REQUEST)
            return

        task_dir = UPLOAD_DIR / str(task["id"])
        task_dir.mkdir(parents=True, exist_ok=True)
        with connect() as conn:
            identity = submission_identity(data)
            if identity:
                existing = conn.execute(
                    "SELECT id, data_json FROM submissions WHERE task_id = ?",
                    (task["id"],),
                ).fetchall()
                for row in existing:
                    old_data = json.loads(row["data_json"])
                    if submission_identity(old_data) == identity:
                        delete_submission_files(conn, row["id"])
            cursor = conn.execute(
                "INSERT INTO submissions (task_id, data_json, ip, status, created_at) VALUES (?, ?, ?, ?, ?)",
                (task["id"], json.dumps(data, ensure_ascii=False), self.client_address[0], "submitted", now_iso()),
            )
            submission_id = cursor.lastrowid
            saved_files = []
            total_files = len(upload_items)
            for index, item in enumerate(upload_items, start=1):
                stored_name = render_name(task["renameTemplate"], data, item.filename or "file", index, total_files)
                unique_name = f"{submission_id}-{stored_name}"
                relative = Path("uploads") / str(task["id"]) / unique_name
                target = ROOT / relative
                with target.open("wb") as out:
                    shutil.copyfileobj(item.file, out)
                size = target.stat().st_size
                conn.execute(
                    """
                    INSERT INTO files (submission_id, original_name, stored_name, mime_type, size, path)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (submission_id, item.filename or "file", stored_name, item.type or "", size, str(relative)),
                )
                saved_files.append(stored_name)
        send_json(self, {"ok": True, "submissionId": submission_id, "files": saved_files}, HTTPStatus.CREATED)

    def export_csv(self, task_id: int) -> None:
        task = build_task_detail(task_id)
        if not task:
            send_json(self, {"error": "任务不存在"}, HTTPStatus.NOT_FOUND)
            return
        output = io.StringIO()
        writer = csv.writer(output)
        field_labels = [field["label"] for field in task["fields"]]
        field_keys = [field["key"] for field in task["fields"]]
        writer.writerow(["提交ID", *field_labels, "提交时间", "IP", "文件"])
        for item in task["submissions"]:
            writer.writerow(
                [
                    item["id"],
                    *[item["data"].get(key, "") for key in field_keys],
                    item["createdAt"],
                    item["ip"],
                    "; ".join(file["storedName"] for file in item["files"]),
                ]
            )
        body = ("\ufeff" + output.getvalue()).encode("utf-8")
        filename = safe_filename(task["title"]) + ".csv"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def download_zip(self, task_id: int) -> None:
        task = build_task_detail(task_id)
        if not task:
            send_json(self, {"error": "任务不存在"}, HTTPStatus.NOT_FOUND)
            return
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in task["submissions"]:
                files = item["files"]
                folder = submission_folder_name(task, item) if len(files) > 1 else ""
                for file in item["files"]:
                    row = None
                    with connect() as conn:
                        row = conn.execute("SELECT path FROM files WHERE id = ?", (file["id"],)).fetchone()
                    if row:
                        source = ROOT / row["path"]
                        if source.exists():
                            arcname = str(Path(folder) / file["storedName"]) if folder else file["storedName"]
                            archive.write(source, arcname=arcname)
        body = buffer.getvalue()
        filename = safe_filename(task["title"]) + ".zip"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file_id: int, inline: bool) -> None:
        row = get_file_row(file_id)
        if not row:
            send_json(self, {"error": "文件不存在"}, HTTPStatus.NOT_FOUND)
            return
        source = resolve_stored_file(row)
        if not source:
            send_json(self, {"error": "文件已丢失"}, HTTPStatus.NOT_FOUND)
            return
        stored_name = row["stored_name"]
        mime_type = row["mime_type"] or mimetypes.guess_type(stored_name)[0] or "application/octet-stream"
        disposition = "inline" if inline else "attachment"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(stored_name)}")
        self.send_header("Content-Length", str(source.stat().st_size))
        self.end_headers()
        with source.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile)


def main() -> None:
    init_db()
    port = int(os.environ.get("PORT", "8964"))
    server = ThreadingHTTPServer(("127.0.0.1", port), AppHandler)
    print(f"Filestore running at http://127.0.0.1:{port}")
    print(f"Default admin password: {ADMIN_PASSWORD}")
    server.serve_forever()


if __name__ == "__main__":
    main()
