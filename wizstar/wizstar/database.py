"""MySQL 持久化层 — 邮箱库 / 账号库 / 任务记录。

连接信息全部由 ``WIZSTAR_MYSQL_*`` 环境变量提供。旧的本地
``~/.wizstar/wizstar.db`` 不会被删除，可使用迁移工具一次性导入。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any

from .app_paths import get_wizstar_data_dir

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:  # pragma: no cover - surfaced with a clearer runtime message below
    pymysql = None
    DictCursor = None


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _load_mysql_env_file() -> None:
    """Load the first available local env file without overriding OS variables."""
    configured = os.getenv("WIZSTAR_ENV_FILE", "").strip()
    candidates = [
        Path(configured).expanduser() if configured else None,
        Path.cwd() / ".env",
        Path(__file__).resolve().parents[2] / ".env",
        Path(get_wizstar_data_dir()) / "mysql.env",
    ]
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        if not candidate.is_file():
            continue
        for raw_line in candidate.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("\"'")
            if key.startswith("WIZSTAR_MYSQL_") and key not in os.environ:
                os.environ[key] = value
        return


_load_mysql_env_file()

MYSQL_HOST = os.getenv("WIZSTAR_MYSQL_HOST", "127.0.0.1").strip() or "127.0.0.1"
MYSQL_PORT = _env_int("WIZSTAR_MYSQL_PORT", 3306)
MYSQL_DATABASE = os.getenv("WIZSTAR_MYSQL_DATABASE", "wizstar").strip() or "wizstar"
MYSQL_USER = os.getenv("WIZSTAR_MYSQL_USER", "root").strip() or "root"
MYSQL_PASSWORD = os.getenv("WIZSTAR_MYSQL_PASSWORD", "")
MYSQL_CONNECT_TIMEOUT = _env_int("WIZSTAR_MYSQL_CONNECT_TIMEOUT", 10)
MYSQL_AUTOCREATE_DATABASE = os.getenv("WIZSTAR_MYSQL_AUTOCREATE_DATABASE", "1").strip().lower() not in {
    "0",
    "false",
    "no",
}

_DATABASE_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")
_database_ready = False
_database_ready_lock = threading.Lock()


def _mysql_connect(*, include_database: bool):
    if pymysql is None:
        raise RuntimeError(
            "缺少 MySQL 驱动 PyMySQL；请执行 pip install -r wizstar/wizstar/requirements.txt"
        )
    if not _DATABASE_NAME_RE.fullmatch(MYSQL_DATABASE):
        raise RuntimeError("WIZSTAR_MYSQL_DATABASE 只能包含字母、数字和下划线")
    options: dict[str, Any] = {
        "host": MYSQL_HOST,
        "port": MYSQL_PORT,
        "user": MYSQL_USER,
        "password": MYSQL_PASSWORD,
        "charset": "utf8mb4",
        "cursorclass": DictCursor,
        "autocommit": False,
        "connect_timeout": MYSQL_CONNECT_TIMEOUT,
        "read_timeout": 60,
        "write_timeout": 60,
    }
    unix_socket = os.getenv("WIZSTAR_MYSQL_UNIX_SOCKET", "").strip()
    if unix_socket:
        options["unix_socket"] = unix_socket
    if include_database:
        options["database"] = MYSQL_DATABASE
    return pymysql.connect(**options)


def _ensure_mysql_database() -> None:
    global _database_ready
    if _database_ready:
        return
    with _database_ready_lock:
        if _database_ready:
            return
        if MYSQL_AUTOCREATE_DATABASE:
            connection = _mysql_connect(include_database=False)
            try:
                connection.autocommit(True)
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"CREATE DATABASE IF NOT EXISTS `{MYSQL_DATABASE}` "
                        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                    )
            finally:
                connection.close()
        _database_ready = True


def _translate_sql(sql: str) -> str:
    stripped = sql.strip()
    if stripped.upper() == "BEGIN IMMEDIATE":
        return "START TRANSACTION"
    sql = re.sub(
        r"strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)",
        "CURRENT_TIMESTAMP(6)",
        sql,
        flags=re.IGNORECASE,
    )
    sql = re.sub(r"\bINSERT\s+OR\s+IGNORE\b", "INSERT IGNORE", sql, flags=re.IGNORECASE)
    sql = re.sub(r"\bINSERT\s+OR\s+REPLACE\b", "REPLACE", sql, flags=re.IGNORECASE)
    return sql.replace("?", "%s")


def _normalize_db_value(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    return value


def _normalize_db_row(row: dict | None) -> dict | None:
    if row is None:
        return None
    return {key: _normalize_db_value(value) for key, value in row.items()}


class _CursorResult:
    def __init__(self, cursor):
        self._cursor = cursor

    @property
    def rowcount(self) -> int:
        return int(self._cursor.rowcount or 0)

    def fetchone(self) -> dict | None:
        return _normalize_db_row(self._cursor.fetchone())

    def fetchall(self) -> list[dict]:
        return [_normalize_db_row(row) for row in self._cursor.fetchall()]


class MySQLConnection:
    """Small compatibility wrapper matching the old sqlite connection API."""

    def __init__(self, connection):
        self._connection = connection
        with self._connection.cursor() as cursor:
            cursor.execute("SET time_zone = '+00:00'")

    def execute(self, sql: str, params: tuple | list = ()) -> _CursorResult:
        cursor = self._connection.cursor()
        cursor.execute(_translate_sql(sql), tuple(params))
        return _CursorResult(cursor)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()

    def close(self) -> None:
        self._connection.close()


def get_connection() -> MySQLConnection:
    _ensure_mysql_database()
    return MySQLConnection(_mysql_connect(include_database=True))


_TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"

_SCHEMA = [
    f"""
    CREATE TABLE IF NOT EXISTS mailboxes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password LONGTEXT NULL,
        client_id VARCHAR(512) NOT NULL,
        refresh_token LONGTEXT NULL,
        google_password LONGTEXT NULL,
        provider VARCHAR(32) NOT NULL DEFAULT 'unknown',
        status VARCHAR(64) NOT NULL DEFAULT 'unknown',
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_mailboxes_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS mailbox_channel_usage (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        mailbox_id BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'reserved',
        account_email VARCHAR(255) NULL,
        last_error TEXT NULL,
        failure_count INT NOT NULL DEFAULT 0,
        retry_after DATETIME(6) NULL,
        lease_expires_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_mailbox_channel_usage (mailbox_id, channel),
        KEY idx_mailbox_channel_status (channel, status),
        CONSTRAINT fk_mailbox_channel_usage_mailbox
            FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password LONGTEXT NULL,
        uid BIGINT NOT NULL DEFAULT 0,
        display_name TEXT NULL,
        osduss LONGTEXT NULL,
        refresh_token LONGTEXT NULL,
        auth_token LONGTEXT NULL,
        cookies_json LONGTEXT NULL,
        pass_os_refresh_tk LONGTEXT NULL,
        points_balance BIGINT NOT NULL DEFAULT 0,
        max_concurrency INT NOT NULL DEFAULT 1,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        daily_limit_date VARCHAR(10) NOT NULL DEFAULT '',
        last_verified_at DOUBLE NOT NULL DEFAULT 0,
        last_error TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS tasks (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL,
        account_id BIGINT NULL,
        task_type INT NULL,
        prompt LONGTEXT NULL,
        model VARCHAR(255) NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'pending',
        video_url LONGTEXT NULL,
        video_duration INT NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        KEY idx_tasks_task_id (task_id),
        KEY idx_tasks_account_status (account_id, status)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS qf_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        cs_session LONGTEXT NULL,
        bearer LONGTEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_qf_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS dola_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        env_file TEXT NULL,
        profile_dir TEXT NULL,
        cookie_masked TEXT NULL,
        user_agent TEXT NULL,
        device_id_masked TEXT NULL,
        web_id_masked TEXT NULL,
        fp_masked TEXT NULL,
        max_concurrency INT NOT NULL DEFAULT 1,
        daily_video_quota INT NOT NULL DEFAULT 6,
        daily_video_used INT NOT NULL DEFAULT 0,
        daily_video_date VARCHAR(10) NOT NULL DEFAULT '',
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_dola_accounts_name (name)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS lovart_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        cookie_masked TEXT NULL,
        user_agent TEXT NULL,
        location TEXT NULL,
        cookies_json LONGTEXT NULL,
        local_storage_json LONGTEXT NULL,
        session_storage_json LONGTEXT NULL,
        indexed_db_json LONGTEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_lovart_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS oreateai_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password LONGTEXT NULL,
        cookie_masked TEXT NULL,
        cookies_json LONGTEXT NULL,
        user_agent TEXT NULL,
        location TEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_oreateai_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS framia_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password LONGTEXT NULL,
        access_token LONGTEXT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        cookie_masked TEXT NULL,
        cookie LONGTEXT NULL,
        user_agent TEXT NULL,
        user_id VARCHAR(255) NULL,
        location TEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_framia_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS happyhorse_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        password LONGTEXT NULL,
        access_token LONGTEXT NULL,
        refresh_token LONGTEXT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        cookie_masked TEXT NULL,
        cookie LONGTEXT NULL,
        user_agent TEXT NULL,
        user_id VARCHAR(255) NULL,
        device_id VARCHAR(128) NULL,
        bx_umidtoken TEXT NULL,
        location TEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_happyhorse_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS tensorart_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        access_token LONGTEXT NULL,
        token_masked TEXT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        device_id VARCHAR(128) NULL,
        user_agent TEXT NULL,
        user_id VARCHAR(255) NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_tensorart_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS insmind_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        access_token LONGTEXT NULL,
        refresh_token LONGTEXT NULL,
        token_masked TEXT NULL,
        cookie LONGTEXT NULL,
        cookie_masked TEXT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        user_id VARCHAR(255) NULL,
        org_id VARCHAR(255) NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'active',
        note TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE KEY uq_insmind_accounts_email (email)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        title TEXT NOT NULL,
        date VARCHAR(64) NOT NULL DEFAULT '',
        time VARCHAR(64) NOT NULL DEFAULT '',
        status VARCHAR(64) NOT NULL DEFAULT '未生成',
        progress VARCHAR(64) NOT NULL DEFAULT '0/0',
        collection VARCHAR(255) NOT NULL DEFAULT '',
        thumbnail LONGTEXT NULL,
        editable TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) {_TABLE_OPTIONS}
    """,
    f"""
    CREATE TABLE IF NOT EXISTS project_payloads (
        project_id VARCHAR(191) NOT NULL PRIMARY KEY,
        segments_json LONGTEXT NULL,
        character_assets_json LONGTEXT NULL,
        scene_assets_json LONGTEXT NULL,
        item_assets_json LONGTEXT NULL,
        generation_tasks_json LONGTEXT NULL,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        CONSTRAINT fk_project_payloads_project
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) {_TABLE_OPTIONS}
    """,
]


def _column_names(conn: MySQLConnection, table_name: str) -> set[str]:
    rows = conn.execute(
        """SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?""",
        (MYSQL_DATABASE, table_name),
    ).fetchall()
    return {str(row["COLUMN_NAME"]) for row in rows}


def _ensure_column(conn: MySQLConnection, table_name: str, column_name: str, definition: str) -> None:
    if column_name not in _column_names(conn, table_name):
        conn.execute(f"ALTER TABLE `{table_name}` ADD COLUMN `{column_name}` {definition}")


# channel -> (account_table, email_column)，用于占用同步 / 领取时排除已登录账号
CHANNEL_ACCOUNT_TABLES = {
    "wizstar": ("accounts", "email"),
    "quickframe": ("qf_accounts", "email"),
    "dola": ("dola_accounts", "name"),
    "lovart": ("lovart_accounts", "email"),
    "oreateai": ("oreateai_accounts", "email"),
    "framia": ("framia_accounts", "email"),
    "happyhorse": ("happyhorse_accounts", "email"),
    "tensorart": ("tensorart_accounts", "email"),
    "insmind": ("insmind_accounts", "email"),
}


def init_db():
    conn = get_connection()
    try:
        for statement in _SCHEMA:
            conn.execute(statement)

        _ensure_column(conn, "mailboxes", "password", "LONGTEXT NULL")
        _ensure_column(conn, "mailboxes", "google_password", "LONGTEXT NULL")
        _ensure_column(conn, "mailboxes", "provider", "VARCHAR(32) NOT NULL DEFAULT 'unknown'")
        _ensure_column(conn, "mailbox_channel_usage", "failure_count", "INT NOT NULL DEFAULT 0")
        _ensure_column(conn, "mailbox_channel_usage", "retry_after", "DATETIME(6) NULL")
        conn.execute(
            """UPDATE mailboxes
               SET password = google_password
               WHERE (password IS NULL OR password = '')
                 AND google_password IS NOT NULL
                 AND google_password != ''"""
        )
        conn.execute(
            """UPDATE mailboxes
               SET provider = 'microsoft'
               WHERE client_id != ''
                 AND refresh_token IS NOT NULL
                 AND refresh_token != ''"""
        )
        conn.execute(
            """UPDATE mailboxes
               SET provider = 'google'
               WHERE provider IN ('', 'unknown')
                 AND COALESCE(NULLIF(password, ''), NULLIF(google_password, '')) IS NOT NULL"""
        )
        _ensure_column(conn, "project_payloads", "scene_assets_json", "LONGTEXT NULL")
        _ensure_column(conn, "project_payloads", "item_assets_json", "LONGTEXT NULL")
        _ensure_column(conn, "project_payloads", "generation_tasks_json", "LONGTEXT NULL")
        _ensure_column(conn, "dola_accounts", "max_concurrency", "INT NOT NULL DEFAULT 1")
        _ensure_column(conn, "dola_accounts", "daily_video_quota", "INT NOT NULL DEFAULT 6")
        _ensure_column(conn, "dola_accounts", "daily_video_used", "INT NOT NULL DEFAULT 0")
        _ensure_column(conn, "dola_accounts", "daily_video_date", "VARCHAR(10) NOT NULL DEFAULT ''")
        _ensure_column(conn, "accounts", "daily_limit_date", "VARCHAR(10) NOT NULL DEFAULT ''")
        _ensure_column(conn, "accounts", "auth_token", "LONGTEXT NULL")
        _ensure_column(conn, "accounts", "cookies_json", "LONGTEXT NULL")
        _ensure_column(conn, "accounts", "last_verified_at", "DOUBLE NOT NULL DEFAULT 0")
        _ensure_column(conn, "accounts", "last_error", "TEXT NULL")
        _ensure_column(conn, "tasks", "video_duration", "INT NOT NULL DEFAULT 0")

        for channel, (table_name, email_column) in CHANNEL_ACCOUNT_TABLES.items():
            conn.execute(
                f"""INSERT INTO mailbox_channel_usage
                        (mailbox_id, channel, status, account_email, last_error,
                         lease_expires_at, created_at, updated_at)
                    SELECT m.id, ?, 'registered', a.`{email_column}`, '', NULL,
                           CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)
                    FROM mailboxes m
                    INNER JOIN `{table_name}` a
                            ON LOWER(a.`{email_column}`) = LOWER(m.email)
                    ON DUPLICATE KEY UPDATE
                        status = 'registered',
                        account_email = VALUES(account_email),
                        last_error = '',
                        failure_count = 0,
                        retry_after = NULL,
                        lease_expires_at = NULL,
                        updated_at = CURRENT_TIMESTAMP(6)""",
                (channel,),
            )

        today = time.strftime("%Y-%m-%d")
        conn.execute(
            """UPDATE accounts
               SET status = 'active', daily_limit_date = ''
               WHERE status = 'daily_limit' AND daily_limit_date != ?""",
            (today,),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


class MailboxDB:
    SENSITIVE_FIELDS = {"password", "google_password", "refresh_token"}
    _CHANNEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

    @staticmethod
    def public(data: dict) -> dict:
        result = {key: value for key, value in data.items() if key not in MailboxDB.SENSITIVE_FIELDS}
        password = data.get("password") or data.get("google_password")
        result["has_password"] = bool(password)
        result["has_google_password"] = bool(password)
        result["has_refresh_token"] = bool(data.get("refresh_token"))
        result["has_oauth"] = bool(data.get("client_id") and data.get("refresh_token"))
        result["provider"] = str(data.get("provider") or "unknown")
        return result

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM mailboxes ORDER BY created_at DESC").fetchall()
        usage_rows = conn.execute(
            """SELECT mailbox_id, channel, status, account_email, last_error,
                      failure_count, retry_after, lease_expires_at, created_at, updated_at
               FROM mailbox_channel_usage
               ORDER BY channel"""
        ).fetchall()
        conn.close()
        usage_by_mailbox: dict[int, list[dict]] = {}
        for usage in usage_rows:
            usage_by_mailbox.setdefault(int(usage["mailbox_id"]), []).append(dict(usage))
        result = []
        for row in rows:
            mailbox = dict(row)
            mailbox["channel_usage"] = usage_by_mailbox.get(int(mailbox["id"]), [])
            result.append(MailboxDB.public(mailbox))
        return result

    @staticmethod
    def add(
        email: str,
        client_id: str = "",
        refresh_token: str = "",
        google_password: str = "",
        password: str = "",
        provider: str = "",
    ) -> dict:
        normalized_email = str(email or "").strip()
        if not normalized_email:
            raise ValueError("email is required")
        resolved_password = str(password or google_password or "")
        normalized_provider = str(provider or "").strip().lower()
        if str(client_id or "").strip() and str(refresh_token or "").strip():
            # 这里的 OAuth 字段专用于 Microsoft/小苹果取件，不能被标记成 Google 登录账号。
            normalized_provider = "microsoft"
        elif not normalized_provider:
            normalized_provider = (
                "google" if resolved_password else "unknown"
            )
        if normalized_provider not in {"google", "microsoft", "generic", "unknown"}:
            raise ValueError("provider must be google, microsoft, generic or unknown")
        conn = get_connection()
        conn.execute(
            """INSERT INTO mailboxes
                   (email, password, client_id, refresh_token, google_password, provider)
               VALUES (?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                   password = IF(VALUES(password) != '', VALUES(password), password),
                   client_id = IF(VALUES(client_id) != '', VALUES(client_id), client_id),
                   refresh_token = IF(VALUES(refresh_token) != '', VALUES(refresh_token), refresh_token),
                   google_password = IF(VALUES(google_password) != '', VALUES(google_password), google_password),
                   provider = CASE
                       WHEN VALUES(provider) = 'microsoft' THEN 'microsoft'
                       WHEN provider IN ('', 'unknown') THEN VALUES(provider)
                       ELSE provider
                   END""",
            (
                normalized_email,
                resolved_password,
                client_id,
                refresh_token,
                resolved_password,
                normalized_provider,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM mailboxes WHERE email = ?", (normalized_email,)).fetchone()
        conn.close()
        return dict(row)

    @staticmethod
    def delete(mailbox_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM mailboxes WHERE id = ?", (mailbox_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def update_status(mailbox_id: int, status: str):
        conn = get_connection()
        conn.execute("UPDATE mailboxes SET status = ? WHERE id = ?", (status, mailbox_id))
        conn.commit()
        conn.close()

    @staticmethod
    def get(mailbox_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM mailboxes WHERE id = ?", (mailbox_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def get_by_email(email: str) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM mailboxes WHERE email = ?", (email,)).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def _normalize_channel(channel: str) -> str:
        normalized = str(channel or "").strip().lower()
        if not MailboxDB._CHANNEL_RE.fullmatch(normalized):
            raise ValueError("channel must contain only letters, numbers, underscores or hyphens")
        return normalized

    @staticmethod
    def claim_for_channel(
        channel: str,
        *,
        count: int = 1,
        mailbox_ids: list[int] | None = None,
        credential_type: str = "any",
        provider: str = "any",
        lease_seconds: int = 900,
    ) -> list[dict]:
        normalized_channel = MailboxDB._normalize_channel(channel)
        normalized_type = str(credential_type or "any").strip().lower()
        if normalized_type not in {"any", "oauth", "password"}:
            raise ValueError("credential_type must be any, oauth or password")
        normalized_provider = str(provider or "any").strip().lower()
        if normalized_provider not in {"any", "google", "microsoft", "generic"}:
            raise ValueError("provider must be any, google, microsoft or generic")
        selected_ids = []
        for value in mailbox_ids or []:
            try:
                mailbox_id = int(value)
            except (TypeError, ValueError):
                continue
            if mailbox_id > 0 and mailbox_id not in selected_ids:
                selected_ids.append(mailbox_id)
        requested_count = len(selected_ids) if selected_ids else max(1, min(int(count or 1), 100))
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        lease_expires_at = now + timedelta(
            seconds=max(60, min(int(lease_seconds or 900), 7 * 86400))
        )

        credential_sql = {
            "oauth": "m.client_id != '' AND COALESCE(m.refresh_token, '') != ''",
            "password": "COALESCE(NULLIF(m.password, ''), NULLIF(m.google_password, '')) IS NOT NULL",
            "any": """(
                (m.client_id != '' AND COALESCE(m.refresh_token, '') != '')
                OR COALESCE(NULLIF(m.password, ''), NULLIF(m.google_password, '')) IS NOT NULL
            )""",
        }[normalized_type]
        id_sql = ""
        params: list[Any] = []
        provider_sql = ""
        if normalized_provider != "any":
            provider_sql = "AND m.provider = ?"
            params.append(normalized_provider)
        if selected_ids:
            id_sql = f"AND m.id IN ({','.join('?' for _ in selected_ids)})"
            params.extend(selected_ids)
        # 已在对应渠道账号库中的邮箱，领取时直接排除，避免重复登录
        account_exclude_sql = ""
        account_table = CHANNEL_ACCOUNT_TABLES.get(normalized_channel)
        if account_table:
            table_name, email_column = account_table
            account_exclude_sql = f"""
                      AND NOT EXISTS (
                          SELECT 1
                          FROM `{table_name}` a
                          WHERE LOWER(a.`{email_column}`) = LOWER(m.email)
                      )"""
        params.extend((normalized_channel, now, now, requested_count))

        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                f"""SELECT m.*
                    FROM mailboxes m
                    WHERE m.status != 'disabled'
                      AND {credential_sql}
                      {provider_sql}
                      {id_sql}
                      {account_exclude_sql}
                      AND NOT EXISTS (
                          SELECT 1
                          FROM mailbox_channel_usage u
                          WHERE u.mailbox_id = m.id
                            AND (
                                (
                                    u.channel = ?
                                    AND (
                                        u.status = 'registered'
                                        OR (
                                            u.status = 'failed'
                                            AND u.retry_after IS NOT NULL
                                            AND u.retry_after >= ?
                                        )
                                    )
                                )
                                OR (
                                    u.status = 'reserved'
                                    AND (
                                        u.lease_expires_at IS NULL
                                        OR u.lease_expires_at >= ?
                                    )
                                )
                            )
                      )
                    ORDER BY m.created_at ASC
                    LIMIT ?
                    FOR UPDATE""",
                tuple(params),
            ).fetchall()
            if len(rows) < requested_count:
                raise ValueError(
                    f"邮箱库中只有 {len(rows)} 个可供 {normalized_channel} 使用的"
                    f" {normalized_provider} {normalized_type} 邮箱，需要 {requested_count} 个"
                )
            for row in rows:
                conn.execute(
                    """INSERT INTO mailbox_channel_usage
                           (mailbox_id, channel, status, account_email, last_error,
                            lease_expires_at, created_at, updated_at)
                       VALUES (?, ?, 'reserved', '', '', ?, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
                       ON DUPLICATE KEY UPDATE
                           status = 'reserved',
                           account_email = '',
                           last_error = '',
                           retry_after = NULL,
                           lease_expires_at = VALUES(lease_expires_at),
                           updated_at = CURRENT_TIMESTAMP(6)""",
                    (row["id"], normalized_channel, lease_expires_at),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

        result = []
        for raw in rows:
            mailbox = dict(raw)
            password = mailbox.get("password") or mailbox.get("google_password") or ""
            mailbox["password"] = password
            mailbox["google_password"] = password
            mailbox["claimed_channel"] = normalized_channel
            mailbox["lease_expires_at"] = lease_expires_at.timestamp()
            result.append(mailbox)
        return result

    @staticmethod
    def mark_channel_usage(
        mailbox_id: int,
        channel: str,
        status: str,
        *,
        account_email: str = "",
        error: str = "",
    ) -> dict:
        normalized_channel = MailboxDB._normalize_channel(channel)
        normalized_status = str(status or "").strip().lower()
        if normalized_status not in {"reserved", "registered", "failed", "released"}:
            raise ValueError("invalid mailbox channel status")
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        lease_expires_at = (
            now + timedelta(minutes=15)
            if normalized_status == "reserved"
            else None
        )
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                """SELECT failure_count
                   FROM mailbox_channel_usage
                   WHERE mailbox_id = ? AND channel = ?
                   FOR UPDATE""",
                (int(mailbox_id), normalized_channel),
            ).fetchone()
            previous_failures = int((existing or {}).get("failure_count") or 0)
            if normalized_status == "failed":
                failure_count = previous_failures + 1
                cooldown_seconds = min(300 * (2 ** min(failure_count - 1, 8)), 86400)
                retry_after = now + timedelta(seconds=cooldown_seconds)
            elif normalized_status == "reserved":
                failure_count = previous_failures
                retry_after = None
            else:
                failure_count = 0
                retry_after = None
            conn.execute(
                """INSERT INTO mailbox_channel_usage
                       (mailbox_id, channel, status, account_email, last_error,
                        failure_count, retry_after, lease_expires_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
                   ON DUPLICATE KEY UPDATE
                       status = VALUES(status),
                       account_email = VALUES(account_email),
                       last_error = VALUES(last_error),
                       failure_count = VALUES(failure_count),
                       retry_after = VALUES(retry_after),
                       lease_expires_at = VALUES(lease_expires_at),
                       updated_at = CURRENT_TIMESTAMP(6)""",
                (
                    int(mailbox_id),
                    normalized_channel,
                    normalized_status,
                    str(account_email or "")[:255],
                    str(error or "")[:2000],
                    failure_count,
                    retry_after,
                    lease_expires_at,
                ),
            )
            conn.commit()
            row = conn.execute(
                """SELECT mailbox_id, channel, status, account_email, last_error,
                          failure_count, retry_after, lease_expires_at, created_at, updated_at
                   FROM mailbox_channel_usage
                   WHERE mailbox_id = ? AND channel = ?""",
                (int(mailbox_id), normalized_channel),
            ).fetchone()
            return dict(row or {})
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def clear_channel_failure(mailbox_id: int, channel: str) -> bool:
        normalized_channel = MailboxDB._normalize_channel(channel)
        conn = get_connection()
        try:
            result = conn.execute(
                """DELETE FROM mailbox_channel_usage
                   WHERE mailbox_id = ? AND channel = ? AND status IN ('failed', 'released')""",
                (int(mailbox_id), normalized_channel),
            )
            conn.commit()
            return result.rowcount > 0
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


class AccountDB:
    SENSITIVE_FIELDS = {
        "password",
        "osduss",
        "refresh_token",
        "auth_token",
        "cookies_json",
        "pass_os_refresh_tk",
    }

    @staticmethod
    def public(data: dict) -> dict:
        result = {key: value for key, value in data.items() if key not in AccountDB.SENSITIVE_FIELDS}
        result["has_session"] = any(
            bool(data.get(field))
            for field in ("auth_token", "osduss", "pass_os_refresh_tk")
        ) or (data.get("cookies_json") not in (None, "", "{}"))
        return result

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM accounts ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add(email: str, password: str = "", uid: int = 0, display_name: str = "",
            osduss: str = "", refresh_token: str = "", pass_os_refresh_tk: str = "",
            auth_token: str = "", cookies: dict | None = None,
            points_balance: int = 0, max_concurrency: int = 1) -> dict:
        conn = get_connection()
        conn.execute(
            """INSERT INTO accounts
               (email, password, uid, display_name, osduss, refresh_token, auth_token,
                cookies_json, pass_os_refresh_tk, points_balance, max_concurrency,
                status, last_verified_at, last_error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '')
               ON DUPLICATE KEY UPDATE
                   password = IF(VALUES(password) != '', VALUES(password), password),
                   uid = VALUES(uid),
                   display_name = VALUES(display_name),
                   osduss = VALUES(osduss),
                   refresh_token = VALUES(refresh_token),
                   auth_token = VALUES(auth_token),
                   cookies_json = VALUES(cookies_json),
                   pass_os_refresh_tk = VALUES(pass_os_refresh_tk),
                   points_balance = VALUES(points_balance),
                   max_concurrency = VALUES(max_concurrency),
                   status = 'active',
                   last_verified_at = VALUES(last_verified_at),
                   last_error = ''""",
            (email, password, uid, display_name, osduss, refresh_token, auth_token,
             json.dumps(cookies or {}, ensure_ascii=False), pass_os_refresh_tk,
             points_balance, max_concurrency, time.time()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return dict(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def update_points(account_id: int, points: int):
        conn = get_connection()
        conn.execute(
            """UPDATE accounts
               SET points_balance = ?, status = 'active', last_verified_at = ?, last_error = ''
               WHERE id = ?""",
            (points, time.time(), account_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def update_status(account_id: int, status: str):
        conn = get_connection()
        conn.execute("UPDATE accounts SET status = ? WHERE id = ?", (status, account_id))
        conn.commit()
        conn.close()

    @staticmethod
    def update_session_status(account_id: int, status: str, error: str = ""):
        conn = get_connection()
        verified_at = time.time() if status == "active" else 0
        conn.execute(
            """UPDATE accounts
               SET status = ?, last_verified_at = CASE WHEN ? > 0 THEN ? ELSE last_verified_at END,
                   last_error = ?
               WHERE id = ?""",
            (status, verified_at, verified_at, str(error or "")[:1000], account_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def mark_daily_limit(account_id: int) -> None:
        """Mark a Wizstar account as daily-limited for today.
        Auto-resets to 'active' the next day via init_db migration check."""
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        conn.execute(
            "UPDATE accounts SET status = 'daily_limit', daily_limit_date = ? WHERE id = ?",
            (today, account_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def mark_quota_exhausted(account_id: int) -> None:
        conn = get_connection()
        conn.execute(
            "UPDATE accounts SET status = 'quota_exhausted', last_error = ? WHERE id = ?",
            ("15s video quota exhausted", account_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def update_concurrency(account_id: int, max_concurrency: int):
        conn = get_connection()
        conn.execute("UPDATE accounts SET max_concurrency = ? WHERE id = ?", (max_concurrency, account_id))
        conn.commit()
        conn.close()

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def get_by_email(email: str) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return dict(row) if row else None


class QfAccountDB:
    """QuickFrame 账号库（独立于 Wizstar 账号池）。"""

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM qf_accounts ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add(email: str, cs_session: str = "", bearer: str = "",
            status: str = "active", note: str = "") -> dict:
        conn = get_connection()
        conn.execute(
            """INSERT INTO qf_accounts
               (email, cs_session, bearer, status, note, updated_at)
               VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
               ON DUPLICATE KEY UPDATE
                   cs_session = VALUES(cs_session),
                   bearer = VALUES(bearer),
                   status = VALUES(status),
                   note = VALUES(note),
                   updated_at = VALUES(updated_at)""",
            (email, cs_session, bearer, status, note),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM qf_accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return dict(row)

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM qf_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def update_tokens(account_id: int, cs_session: str | None = None, bearer: str | None = None,
                      status: str | None = None):
        existing = QfAccountDB.get(account_id)
        if not existing:
            return None
        conn = get_connection()
        conn.execute(
            """UPDATE qf_accounts
               SET cs_session = ?, bearer = ?, status = ?, updated_at = strftime('%s','now')
               WHERE id = ?""",
            (
                cs_session if cs_session is not None else existing["cs_session"],
                bearer if bearer is not None else existing["bearer"],
                status if status is not None else existing["status"],
                account_id,
            ),
        )
        conn.commit()
        conn.close()
        return QfAccountDB.get(account_id)

    @staticmethod
    def update_status(account_id: int, status: str):
        conn = get_connection()
        conn.execute(
            "UPDATE qf_accounts SET status = ?, updated_at = strftime('%s','now') WHERE id = ?",
            (status, account_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM qf_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()


class DolaAccountDB:
    """Dola 渠道六采集账号库。"""

    @staticmethod
    def _normalize_quota(row: dict) -> dict:
        today = time.strftime("%Y-%m-%d")
        quota = int(row.get("daily_video_quota") or 6)
        quota = max(0, quota)
        used = int(row.get("daily_video_used") or 0)
        quota_date = row.get("daily_video_date") or ""
        if quota_date != today:
            used = 0
            quota_date = today
        used = max(0, min(used, quota))
        row["daily_video_quota"] = quota
        row["daily_video_used"] = used
        row["daily_video_remaining"] = max(0, quota - used)
        row["daily_video_date"] = quota_date
        return row

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM dola_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [DolaAccountDB._normalize_quota(dict(r)) for r in rows]

    @staticmethod
    def upsert(
        name: str,
        env_file: str = "",
        profile_dir: str = "",
        cookie_masked: str = "",
        user_agent: str = "",
        device_id_masked: str = "",
        web_id_masked: str = "",
        fp_masked: str = "",
        status: str = "active",
        note: str = "",
    ) -> dict:
        conn = get_connection()
        existing = conn.execute("SELECT * FROM dola_accounts WHERE name = ?", (name,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE dola_accounts
                   SET env_file = ?, profile_dir = ?, cookie_masked = ?, user_agent = ?,
                       device_id_masked = ?, web_id_masked = ?, fp_masked = ?, status = ?,
                       note = ?, updated_at = strftime('%s','now')
                   WHERE name = ?""",
                (env_file, profile_dir, cookie_masked, user_agent, device_id_masked,
                 web_id_masked, fp_masked, status, note, name),
            )
        else:
            conn.execute(
                """INSERT INTO dola_accounts
                   (name, env_file, profile_dir, cookie_masked, user_agent, device_id_masked,
                    web_id_masked, fp_masked, status, note, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))""",
                (name, env_file, profile_dir, cookie_masked, user_agent, device_id_masked,
                 web_id_masked, fp_masked, status, note),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM dola_accounts WHERE name = ?", (name,)).fetchone()
        conn.close()
        return DolaAccountDB._normalize_quota(dict(row))

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM dola_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return DolaAccountDB._normalize_quota(dict(row)) if row else None

    @staticmethod
    def reserve_daily_video_quota(account_id: int, cost: int) -> dict:
        cost = max(1, int(cost or 1))
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM dola_accounts WHERE id = ? FOR UPDATE",
                (account_id,),
            ).fetchone()
            if not row:
                raise ValueError("dola account not found")
            data = dict(row)
            quota = max(0, int(data.get("daily_video_quota") or 6))
            used = int(data.get("daily_video_used") or 0)
            if (data.get("daily_video_date") or "") != today:
                used = 0
            remaining = max(0, quota - used)
            if remaining < cost:
                raise ValueError(f"渠道六账号今日额度不足：剩余 {remaining}，本次需要 {cost}")
            used += cost
            conn.execute(
                """UPDATE dola_accounts
                   SET daily_video_quota = ?, daily_video_used = ?, daily_video_date = ?, updated_at = strftime('%s','now')
                   WHERE id = ?""",
                (quota, used, today, account_id),
            )
            conn.commit()
            data.update({
                "daily_video_quota": quota,
                "daily_video_used": used,
                "daily_video_date": today,
            })
            return DolaAccountDB._normalize_quota(data)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def release_daily_video_quota(account_id: int, cost: int) -> dict | None:
        cost = max(1, int(cost or 1))
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM dola_accounts WHERE id = ? FOR UPDATE",
                (account_id,),
            ).fetchone()
            if not row:
                conn.commit()
                return None
            data = dict(row)
            quota = max(0, int(data.get("daily_video_quota") or 6))
            used = int(data.get("daily_video_used") or 0)
            if (data.get("daily_video_date") or "") != today:
                used = 0
            used = max(0, used - cost)
            conn.execute(
                """UPDATE dola_accounts
                   SET daily_video_quota = ?, daily_video_used = ?, daily_video_date = ?, updated_at = strftime('%s','now')
                   WHERE id = ?""",
                (quota, used, today, account_id),
            )
            conn.commit()
            data.update({
                "daily_video_quota": quota,
                "daily_video_used": used,
                "daily_video_date": today,
            })
            return DolaAccountDB._normalize_quota(data)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def reserve_best_daily_video_quota(cost: int) -> dict | None:
        cost = max(1, int(cost or 1))
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT * FROM dola_accounts WHERE status = 'active' FOR UPDATE"
            ).fetchall()
            candidates = []
            for row in rows:
                data = dict(row)
                quota = max(0, int(data.get("daily_video_quota") or 6))
                used = int(data.get("daily_video_used") or 0)
                if (data.get("daily_video_date") or "") != today:
                    used = 0
                used = max(0, min(used, quota))
                remaining = max(0, quota - used)
                if remaining >= cost:
                    candidates.append((remaining, used, float(data.get("updated_at") or 0), int(data.get("id") or 0), quota, data))
            if not candidates:
                conn.commit()
                return None
            candidates.sort(key=lambda item: (-item[0], item[1], item[2], item[3]))
            _, used, _, account_id, quota, data = candidates[0]
            used += cost
            conn.execute(
                """UPDATE dola_accounts
                   SET daily_video_quota = ?, daily_video_used = ?, daily_video_date = ?, updated_at = strftime('%s','now')
                   WHERE id = ?""",
                (quota, used, today, account_id),
            )
            conn.commit()
            data.update({
                "daily_video_quota": quota,
                "daily_video_used": used,
                "daily_video_date": today,
            })
            return DolaAccountDB._normalize_quota(data)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM dola_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def mark_daily_limit_reached(account_id: int) -> None:
        """Mark a Dola account as having hit its daily generation limit.
        Sets daily_video_used = daily_video_quota for today so remaining = 0.
        _normalize_quota will auto-reset used=0 when the date changes."""
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT daily_video_quota FROM dola_accounts WHERE id = ? FOR UPDATE",
                (account_id,),
            ).fetchone()
            if not row:
                conn.commit()
                return
            quota = max(0, int(dict(row).get("daily_video_quota") or 6))
            conn.execute(
                """UPDATE dola_accounts
                   SET daily_video_used = ?, daily_video_date = ?, updated_at = strftime('%s','now')
                   WHERE id = ?""",
                (quota, today, account_id),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        cursor = conn.execute("DELETE FROM dola_accounts")
        conn.commit()
        deleted = int(cursor.rowcount or 0)
        conn.close()
        return deleted


class LovartAccountDB:
    """Lovart 渠道七账号库。"""

    @staticmethod
    def _json_load(value: str, fallback):
        try:
            return json.loads(value or "")
        except Exception:
            return fallback

    @staticmethod
    def _field_name(value) -> str:
        return "".join(ch for ch in str(value or "").strip().lower() if ch.isalnum())

    @staticmethod
    def _jsonish(value):
        text = str(value or "").strip()
        if not text or text[0] not in "[{":
            return None
        try:
            return json.loads(text)
        except Exception:
            return None

    @staticmethod
    def _walk_named_values(value):
        if isinstance(value, dict):
            for key, item in value.items():
                yield key, item
                yield from LovartAccountDB._walk_named_values(item)
        elif isinstance(value, list):
            for item in value:
                yield from LovartAccountDB._walk_named_values(item)
        elif isinstance(value, str):
            parsed = LovartAccountDB._jsonish(value)
            if parsed is not None:
                yield from LovartAccountDB._walk_named_values(parsed)

    @staticmethod
    def _has_login_token(data: dict) -> bool:
        wanted = {LovartAccountDB._field_name(name) for name in ("usertoken", "userToken", "user_token", "accessToken", "access_token")}
        for cookie in data.get("cookies") or []:
            if isinstance(cookie, dict) and LovartAccountDB._field_name(cookie.get("name")) in wanted and str(cookie.get("value") or "").strip():
                return True
        for root_key in ("local_storage", "session_storage", "indexed_db"):
            root = data.get(root_key)
            if not isinstance(root, (dict, list)):
                continue
            for key, value in LovartAccountDB._walk_named_values(root):
                if LovartAccountDB._field_name(key) in wanted and str(value or "").strip():
                    return True
        return False

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        data = dict(row)
        data["cookies"] = LovartAccountDB._json_load(data.pop("cookies_json", "[]"), [])
        data["local_storage"] = LovartAccountDB._json_load(data.pop("local_storage_json", "{}"), {})
        data["session_storage"] = LovartAccountDB._json_load(data.pop("session_storage_json", "{}"), {})
        data["indexed_db"] = LovartAccountDB._json_load(data.pop("indexed_db_json", "[]"), [])
        data["configured"] = LovartAccountDB._has_login_token(data)
        return data

    @staticmethod
    def _mask_cookie(cookie: str = "", cookies: list | None = None) -> str:
        if cookie:
            names = [part.split("=", 1)[0].strip() for part in cookie.split(";") if part.strip()]
        else:
            names = [str(item.get("name") or "").strip() for item in (cookies or []) if isinstance(item, dict)]
        names = [name for name in names if name]
        if not names:
            return ""
        preview = ",".join(names[:3])
        suffix = f" +{len(names) - 3}" if len(names) > 3 else ""
        return f"{preview}{suffix}"

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM lovart_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [LovartAccountDB._row_to_account(r) for r in rows]

    @staticmethod
    def upsert(
        email: str,
        cookie: str = "",
        cookies: list | None = None,
        user_agent: str = "",
        location: str = "",
        local_storage: dict | None = None,
        session_storage: dict | None = None,
        indexed_db: list | None = None,
        status: str = "active",
        note: str = "",
    ) -> dict:
        email = (email or "").strip()
        if not email:
            raise ValueError("email is required")
        cookies = cookies if isinstance(cookies, list) else []
        if cookie and not cookies:
            parsed_cookies = []
            for part in cookie.split(";"):
                if "=" not in part:
                    continue
                name, value = part.split("=", 1)
                name = name.strip()
                value = value.strip()
                if name:
                    parsed_cookies.append({"name": name, "value": value})
            cookies = parsed_cookies
        local_storage = local_storage if isinstance(local_storage, dict) else {}
        session_storage = session_storage if isinstance(session_storage, dict) else {}
        indexed_db = indexed_db if isinstance(indexed_db, list) else []
        cookie_masked = LovartAccountDB._mask_cookie(cookie, cookies)
        conn = get_connection()
        existing = conn.execute("SELECT * FROM lovart_accounts WHERE email = ?", (email,)).fetchone()
        payload = (
            cookie_masked,
            user_agent or "",
            location or "",
            json.dumps(cookies, ensure_ascii=False),
            json.dumps(local_storage, ensure_ascii=False),
            json.dumps(session_storage, ensure_ascii=False),
            json.dumps(indexed_db, ensure_ascii=False),
            status or "active",
            note or "",
        )
        if existing:
            conn.execute(
                """UPDATE lovart_accounts
                   SET cookie_masked = ?, user_agent = ?, location = ?, cookies_json = ?,
                       local_storage_json = ?, session_storage_json = ?, indexed_db_json = ?,
                       status = ?, note = ?, updated_at = strftime('%s','now')
                   WHERE email = ?""",
                (*payload, email),
            )
        else:
            conn.execute(
                """INSERT INTO lovart_accounts
                   (email, cookie_masked, user_agent, location, cookies_json, local_storage_json,
                    session_storage_json, indexed_db_json, status, note, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))""",
                (email, *payload),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM lovart_accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return LovartAccountDB._row_to_account(row)

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM lovart_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return LovartAccountDB._row_to_account(row) if row else None

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM lovart_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        cursor = conn.execute("DELETE FROM lovart_accounts")
        conn.commit()
        deleted = int(cursor.rowcount or 0)
        conn.close()
        return deleted


class OreateAIAccountDB:
    """OreateAI 渠道八账号库，只由真实浏览器登录流程写入。"""

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        data = dict(row)
        try:
            data["cookies"] = json.loads(data.pop("cookies_json", "[]") or "[]")
        except Exception:
            data["cookies"] = []
        return data

    @staticmethod
    def _mask_cookies(cookies: list) -> str:
        names = [str(item.get("name") or "").strip() for item in cookies if isinstance(item, dict)]
        names = [name for name in names if name]
        if not names:
            return ""
        return ",".join(names[:3]) + (f" +{len(names) - 3}" if len(names) > 3 else "")

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM oreateai_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [OreateAIAccountDB._row_to_account(row) for row in rows]

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM oreateai_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return OreateAIAccountDB._row_to_account(row) if row else None

    @staticmethod
    def upsert(email: str, password: str, cookies: list, user_agent: str = "", location: str = "", status: str = "active", note: str = "") -> dict:
        email = (email or "").strip()
        password = (password or "").strip()
        if not email:
            raise ValueError("email is required")
        if not 8 <= len(password) <= 16 or not any(char.isdigit() for char in password) or not any(char.isalpha() for char in password) or not any(not char.isalnum() for char in password):
            raise ValueError("password must be 8-16 characters with at least one digit, letter and special symbol")
        cookies = cookies if isinstance(cookies, list) else []
        if not cookies:
            raise ValueError("OreateAI cookies are required")
        payload = (
            password,
            OreateAIAccountDB._mask_cookies(cookies),
            json.dumps(cookies, ensure_ascii=False),
            user_agent or "",
            location or "",
            status or "active",
            note or "",
        )
        conn = get_connection()
        existing = conn.execute("SELECT id FROM oreateai_accounts WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE oreateai_accounts
                   SET password = ?, cookie_masked = ?, cookies_json = ?, user_agent = ?, location = ?,
                       status = ?, note = ?, updated_at = strftime('%s','now') WHERE email = ?""",
                (*payload, email),
            )
        else:
            conn.execute(
                """INSERT INTO oreateai_accounts
                   (email, password, cookie_masked, cookies_json, user_agent, location, status, note, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))""",
                (email, *payload),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM oreateai_accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return OreateAIAccountDB._row_to_account(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM oreateai_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()


class FramiaAccountDB:
    """Framia 渠道九账号库。"""

    SENSITIVE_FIELDS = {"password", "access_token", "cookie"}

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        return dict(row) if row else {}

    @staticmethod
    def _public(data: dict) -> dict:
        public = {k: v for k, v in data.items() if k not in FramiaAccountDB.SENSITIVE_FIELDS}
        public["has_token"] = bool(data.get("access_token"))
        public["token_expired"] = FramiaAccountDB._is_token_expired(data)
        public["configured"] = public["has_token"] and not public["token_expired"]
        return public

    @staticmethod
    def _is_token_expired(account: dict) -> bool:
        expires_at = int(account.get("expires_at") or 0)
        if not expires_at:
            return False
        return expires_at < int(time.time() * 1000)

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM framia_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [FramiaAccountDB._public(FramiaAccountDB._row_to_account(row)) for row in rows]

    @staticmethod
    def list_all_internal() -> list[dict]:
        """返回完整数据（含 access_token），仅供后端内部使用"""
        conn = get_connection()
        rows = conn.execute("SELECT * FROM framia_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [FramiaAccountDB._row_to_account(row) for row in rows]

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM framia_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return FramiaAccountDB._row_to_account(row) if row else None

    @staticmethod
    def get_public(account_id: int) -> dict | None:
        account = FramiaAccountDB.get(account_id)
        return FramiaAccountDB._public(account) if account else None

    @staticmethod
    def upsert(
        email: str,
        password: str = "",
        access_token: str = "",
        expires_at: int = 0,
        cookie: str = "",
        user_agent: str = "",
        user_id: str = "",
        location: str = "",
        status: str = "active",
        note: str = "",
    ) -> dict:
        email = (email or "").strip()
        if not email:
            raise ValueError("email is required")
        cookie_masked = cookie[:20] + "..." if len(cookie) > 23 else (cookie[:8] + "..." if cookie else "")
        token_masked = access_token[:20] + "..." if len(access_token) > 23 else ""
        conn = get_connection()
        existing = conn.execute("SELECT id FROM framia_accounts WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE framia_accounts
                   SET password = ?, access_token = ?, expires_at = ?, cookie_masked = ?, cookie = ?,
                       user_agent = ?, user_id = ?, location = ?, status = ?, note = ?,
                       updated_at = strftime('%s','now')
                   WHERE email = ?""",
                (password, access_token, expires_at, cookie_masked, cookie,
                 user_agent, user_id, location, status, note, email),
            )
        else:
            conn.execute(
                """INSERT INTO framia_accounts
                   (email, password, access_token, expires_at, cookie_masked, cookie,
                    user_agent, user_id, location, status, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))""",
                (email, password, access_token, expires_at, cookie_masked, cookie,
                 user_agent, user_id, location, status, note),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM framia_accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return FramiaAccountDB._row_to_account(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM framia_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        count_row = conn.execute("SELECT COUNT(*) AS cnt FROM framia_accounts").fetchone()
        count = int(count_row["cnt"] if count_row else 0)
        conn.execute("DELETE FROM framia_accounts")
        conn.commit()
        conn.close()
        return count


class HappyhorseAccountDB:
    """HappyHorse 渠道十一账号库。"""

    SENSITIVE_FIELDS = {"password", "access_token", "refresh_token", "cookie", "bx_umidtoken"}

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        return dict(row) if row else {}

    @staticmethod
    def _public(data: dict) -> dict:
        public = {k: v for k, v in data.items() if k not in HappyhorseAccountDB.SENSITIVE_FIELDS}
        public["has_token"] = bool(data.get("access_token"))
        public["token_expired"] = HappyhorseAccountDB._is_token_expired(data)
        public["configured"] = public["has_token"] and not public["token_expired"]
        return public

    @staticmethod
    def _is_token_expired(account: dict) -> bool:
        expires_at = int(account.get("expires_at") or 0)
        if not expires_at:
            return False
        return expires_at < int(time.time() * 1000)

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM happyhorse_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [HappyhorseAccountDB._public(HappyhorseAccountDB._row_to_account(row)) for row in rows]

    @staticmethod
    def list_all_internal() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM happyhorse_accounts ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [HappyhorseAccountDB._row_to_account(row) for row in rows]

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM happyhorse_accounts WHERE id = ?", (account_id,)).fetchone()
        conn.close()
        return HappyhorseAccountDB._row_to_account(row) if row else None

    @staticmethod
    def get_by_email(email: str) -> dict | None:
        normalized = str(email or "").strip()
        if not normalized:
            return None
        conn = get_connection()
        row = conn.execute(
            "SELECT * FROM happyhorse_accounts WHERE LOWER(email) = LOWER(?) LIMIT 1",
            (normalized,),
        ).fetchone()
        conn.close()
        return HappyhorseAccountDB._row_to_account(row) if row else None

    @staticmethod
    def get_many(account_ids: list[int]) -> list[dict]:
        ids = []
        seen = set()
        for raw in account_ids or []:
            try:
                account_id = int(raw)
            except (TypeError, ValueError):
                continue
            if account_id <= 0 or account_id in seen:
                continue
            seen.add(account_id)
            ids.append(account_id)
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        conn = get_connection()
        rows = conn.execute(
            f"SELECT * FROM happyhorse_accounts WHERE id IN ({placeholders}) ORDER BY updated_at DESC, created_at DESC",
            ids,
        ).fetchall()
        conn.close()
        by_id = {int(row["id"]): HappyhorseAccountDB._row_to_account(row) for row in rows}
        return [by_id[account_id] for account_id in ids if account_id in by_id]

    @staticmethod
    def get_public(account_id: int) -> dict | None:
        account = HappyhorseAccountDB.get(account_id)
        return HappyhorseAccountDB._public(account) if account else None

    @staticmethod
    def upsert(
        email: str,
        password: str = "",
        access_token: str = "",
        refresh_token: str = "",
        expires_at: int = 0,
        cookie: str = "",
        user_agent: str = "",
        user_id: str = "",
        device_id: str = "",
        bx_umidtoken: str = "",
        location: str = "",
        status: str = "active",
        note: str = "",
    ) -> dict:
        email = (email or "").strip()
        if not email:
            raise ValueError("email is required")
        cookie_masked = cookie[:20] + "..." if len(cookie) > 23 else (cookie[:8] + "..." if cookie else "")
        conn = get_connection()
        existing = conn.execute("SELECT id FROM happyhorse_accounts WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.execute(
                """UPDATE happyhorse_accounts
                   SET password = ?, access_token = ?, refresh_token = ?, expires_at = ?,
                       cookie_masked = ?, cookie = ?, user_agent = ?, user_id = ?,
                       device_id = ?, bx_umidtoken = ?, location = ?, status = ?, note = ?,
                       updated_at = strftime('%s','now')
                   WHERE email = ?""",
                (password, access_token, refresh_token, expires_at, cookie_masked, cookie,
                 user_agent, user_id, device_id, bx_umidtoken, location, status, note, email),
            )
        else:
            conn.execute(
                """INSERT INTO happyhorse_accounts
                   (email, password, access_token, refresh_token, expires_at, cookie_masked, cookie,
                    user_agent, user_id, device_id, bx_umidtoken, location, status, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))""",
                (email, password, access_token, refresh_token, expires_at, cookie_masked, cookie,
                 user_agent, user_id, device_id, bx_umidtoken, location, status, note),
            )
        conn.commit()
        row = conn.execute("SELECT * FROM happyhorse_accounts WHERE email = ?", (email,)).fetchone()
        conn.close()
        return HappyhorseAccountDB._row_to_account(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM happyhorse_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        count_row = conn.execute("SELECT COUNT(*) AS cnt FROM happyhorse_accounts").fetchone()
        count = int(count_row["cnt"] if count_row else 0)
        conn.execute("DELETE FROM happyhorse_accounts")
        conn.commit()
        conn.close()
        return count


class TensorArtAccountDB:
    """Tensor.Art 渠道十账号库。"""

    SENSITIVE_FIELDS = {"access_token", "device_id", "token_masked"}

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        return dict(row) if row else {}

    @staticmethod
    def _is_token_expired(account: dict) -> bool:
        expires_at = int(account.get("expires_at") or 0)
        return bool(expires_at and expires_at < int(time.time() * 1000))

    @staticmethod
    def _public(data: dict) -> dict:
        public = {
            key: value
            for key, value in data.items()
            if key not in TensorArtAccountDB.SENSITIVE_FIELDS
        }
        public["has_token"] = bool(data.get("access_token"))
        device_id = str(data.get("device_id") or "")
        public["device_id_masked"] = (
            device_id[:5] + "***" + device_id[-4:] if len(device_id) > 12 else ("***" if device_id else "")
        )
        public["token_expired"] = TensorArtAccountDB._is_token_expired(data)
        public["configured"] = (
            public["has_token"]
            and not public["token_expired"]
            and str(data.get("status") or "active").lower() == "active"
        )
        return public

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM tensorart_accounts ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        conn.close()
        return [
            TensorArtAccountDB._public(TensorArtAccountDB._row_to_account(row))
            for row in rows
        ]

    @staticmethod
    def list_all_internal() -> list[dict]:
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM tensorart_accounts ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        conn.close()
        return [TensorArtAccountDB._row_to_account(row) for row in rows]

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute(
            "SELECT * FROM tensorart_accounts WHERE id = ?",
            (account_id,),
        ).fetchone()
        conn.close()
        return TensorArtAccountDB._row_to_account(row) if row else None

    @staticmethod
    def get_public(account_id: int) -> dict | None:
        account = TensorArtAccountDB.get(account_id)
        return TensorArtAccountDB._public(account) if account else None

    @staticmethod
    def upsert(
        email: str,
        access_token: str = "",
        expires_at: int = 0,
        device_id: str = "",
        user_agent: str = "",
        user_id: str = "",
        status: str = "active",
        note: str = "",
    ) -> dict:
        email = str(email or "").strip()
        if not email:
            raise ValueError("email is required")
        access_token = str(access_token or "").strip()
        token_masked = (
            access_token[:16] + "..." + access_token[-6:]
            if len(access_token) > 28
            else ("***" if access_token else "")
        )
        conn = get_connection()
        conn.execute(
            """INSERT INTO tensorart_accounts
                   (email, access_token, token_masked, expires_at, device_id,
                    user_agent, user_id, status, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                       strftime('%s','now'), strftime('%s','now'))
               ON DUPLICATE KEY UPDATE
                   access_token = IF(VALUES(access_token) != '', VALUES(access_token), access_token),
                   token_masked = IF(VALUES(token_masked) != '', VALUES(token_masked), token_masked),
                   expires_at = IF(VALUES(expires_at) > 0, VALUES(expires_at), expires_at),
                   device_id = IF(VALUES(device_id) != '', VALUES(device_id), device_id),
                   user_agent = IF(VALUES(user_agent) != '', VALUES(user_agent), user_agent),
                   user_id = IF(VALUES(user_id) != '', VALUES(user_id), user_id),
                   status = VALUES(status),
                   note = VALUES(note),
                   updated_at = strftime('%s','now')""",
            (
                email,
                access_token,
                token_masked,
                int(expires_at or 0),
                str(device_id or ""),
                str(user_agent or ""),
                str(user_id or ""),
                str(status or "active"),
                str(note or ""),
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM tensorart_accounts WHERE email = ?",
            (email,),
        ).fetchone()
        conn.close()
        return TensorArtAccountDB._row_to_account(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM tensorart_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM tensorart_accounts"
        ).fetchone()
        count = int(count_row["cnt"] if count_row else 0)
        conn.execute("DELETE FROM tensorart_accounts")
        conn.commit()
        conn.close()
        return count


class InsmindAccountDB:
    """insMind 渠道十二账号库。"""

    SENSITIVE_FIELDS = {"access_token", "refresh_token", "cookie", "token_masked", "cookie_masked"}

    @staticmethod
    def _row_to_account(row: dict) -> dict:
        return dict(row) if row else {}

    @staticmethod
    def _is_token_expired(account: dict) -> bool:
        expires_at = int(account.get("expires_at") or 0)
        if not expires_at:
            return False
        # 兼容秒 / 毫秒时间戳
        now_ms = int(time.time() * 1000)
        if expires_at < 10_000_000_000:
            expires_at *= 1000
        return expires_at < now_ms

    @staticmethod
    def _mask_token(token: str) -> str:
        token = str(token or "")
        if len(token) > 28:
            return token[:16] + "..." + token[-6:]
        return "***" if token else ""

    @staticmethod
    def _mask_cookie(cookie: str) -> str:
        cookie = str(cookie or "")
        if len(cookie) > 24:
            return cookie[:10] + "..." + cookie[-6:]
        return "***" if cookie else ""

    @staticmethod
    def _public(data: dict) -> dict:
        public = {
            key: value
            for key, value in data.items()
            if key not in InsmindAccountDB.SENSITIVE_FIELDS
        }
        public["has_token"] = bool(data.get("access_token"))
        public["has_cookie"] = bool(data.get("cookie"))
        public["token_masked"] = data.get("token_masked") or InsmindAccountDB._mask_token(
            data.get("access_token") or ""
        )
        public["token_expired"] = InsmindAccountDB._is_token_expired(data)
        public["configured"] = (
            public["has_token"]
            and not public["token_expired"]
            and str(data.get("status") or "active").lower() == "active"
        )
        return public

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM insmind_accounts ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        conn.close()
        return [
            InsmindAccountDB._public(InsmindAccountDB._row_to_account(row))
            for row in rows
        ]

    @staticmethod
    def list_all_internal() -> list[dict]:
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM insmind_accounts ORDER BY updated_at DESC, created_at DESC"
        ).fetchall()
        conn.close()
        return [InsmindAccountDB._row_to_account(row) for row in rows]

    @staticmethod
    def get(account_id: int) -> dict | None:
        conn = get_connection()
        row = conn.execute(
            "SELECT * FROM insmind_accounts WHERE id = ?",
            (account_id,),
        ).fetchone()
        conn.close()
        return InsmindAccountDB._row_to_account(row) if row else None

    @staticmethod
    def get_public(account_id: int) -> dict | None:
        account = InsmindAccountDB.get(account_id)
        return InsmindAccountDB._public(account) if account else None

    @staticmethod
    def get_many(account_ids: list[int]) -> list[dict]:
        ids = []
        seen = set()
        for raw in account_ids or []:
            try:
                account_id = int(raw)
            except (TypeError, ValueError):
                continue
            if account_id <= 0 or account_id in seen:
                continue
            seen.add(account_id)
            ids.append(account_id)
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        conn = get_connection()
        rows = conn.execute(
            f"SELECT * FROM insmind_accounts WHERE id IN ({placeholders}) "
            "ORDER BY updated_at DESC, created_at DESC",
            tuple(ids),
        ).fetchall()
        conn.close()
        by_id = {
            int(row["id"]): InsmindAccountDB._row_to_account(row)
            for row in rows
            if row and row.get("id") is not None
        }
        return [by_id[account_id] for account_id in ids if account_id in by_id]

    @staticmethod
    def get_by_email(email: str) -> dict | None:
        email = str(email or "").strip()
        if not email:
            return None
        conn = get_connection()
        row = conn.execute(
            "SELECT * FROM insmind_accounts WHERE LOWER(email) = LOWER(?) LIMIT 1",
            (email,),
        ).fetchone()
        conn.close()
        return InsmindAccountDB._row_to_account(row) if row else None

    @staticmethod
    def upsert(
        email: str,
        access_token: str = "",
        refresh_token: str = "",
        cookie: str = "",
        expires_at: int = 0,
        user_id: str = "",
        org_id: str = "",
        status: str = "active",
        note: str = "",
    ) -> dict:
        email = str(email or "").strip()
        if not email:
            raise ValueError("email is required")
        access_token = str(access_token or "").strip()
        refresh_token = str(refresh_token or "").strip()
        cookie = str(cookie or "").strip()
        token_masked = InsmindAccountDB._mask_token(access_token)
        cookie_masked = InsmindAccountDB._mask_cookie(cookie)
        conn = get_connection()
        conn.execute(
            """INSERT INTO insmind_accounts
                   (email, access_token, refresh_token, token_masked, cookie, cookie_masked,
                    expires_at, user_id, org_id, status, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       strftime('%s','now'), strftime('%s','now'))
               ON DUPLICATE KEY UPDATE
                   access_token = IF(VALUES(access_token) != '', VALUES(access_token), access_token),
                   refresh_token = IF(VALUES(refresh_token) != '', VALUES(refresh_token), refresh_token),
                   token_masked = IF(VALUES(token_masked) != '', VALUES(token_masked), token_masked),
                   cookie = IF(VALUES(cookie) != '', VALUES(cookie), cookie),
                   cookie_masked = IF(VALUES(cookie_masked) != '', VALUES(cookie_masked), cookie_masked),
                   expires_at = IF(VALUES(expires_at) > 0, VALUES(expires_at), expires_at),
                   user_id = IF(VALUES(user_id) != '', VALUES(user_id), user_id),
                   org_id = IF(VALUES(org_id) != '', VALUES(org_id), org_id),
                   status = VALUES(status),
                   note = VALUES(note),
                   updated_at = strftime('%s','now')""",
            (
                email,
                access_token,
                refresh_token,
                token_masked,
                cookie,
                cookie_masked,
                int(expires_at or 0),
                str(user_id or ""),
                str(org_id or ""),
                str(status or "active"),
                str(note or ""),
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM insmind_accounts WHERE email = ?",
            (email,),
        ).fetchone()
        conn.close()
        return InsmindAccountDB._row_to_account(row)

    @staticmethod
    def delete(account_id: int):
        conn = get_connection()
        conn.execute("DELETE FROM insmind_accounts WHERE id = ?", (account_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def delete_many(account_ids: list[int]) -> int:
        """按 id 批量删除；返回实际删除条数。"""
        ids = []
        for raw in account_ids or []:
            try:
                value = int(raw)
            except (TypeError, ValueError):
                continue
            if value > 0:
                ids.append(value)
        # 去重，避免占位符膨胀
        ids = list(dict.fromkeys(ids))
        if not ids:
            return 0
        conn = get_connection()
        placeholders = ",".join("?" for _ in ids)
        cur = conn.execute(
            f"DELETE FROM insmind_accounts WHERE id IN ({placeholders})",
            ids,
        )
        deleted = int(cur.rowcount or 0)
        conn.commit()
        conn.close()
        return deleted

    @staticmethod
    def delete_all() -> int:
        conn = get_connection()
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM insmind_accounts"
        ).fetchone()
        count = int(count_row["cnt"] if count_row else 0)
        conn.execute("DELETE FROM insmind_accounts")
        conn.commit()
        conn.close()
        return count


class ProjectDB:
    @staticmethod
    def _row_to_project(row: dict) -> dict:
        data = dict(row)
        data["editable"] = bool(data.get("editable", 1))
        return data

    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC").fetchall()
        conn.close()
        return [ProjectDB._row_to_project(r) for r in rows]

    @staticmethod
    def get(project_id: str) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        conn.close()
        return ProjectDB._row_to_project(row) if row else None

    @staticmethod
    def add(data: dict) -> dict:
        project_id = data.get("id") or str(int(time.time() * 1000))
        conn = get_connection()
        conn.execute(
            """INSERT INTO projects
               (id, title, date, time, status, progress, collection, thumbnail, editable, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))""",
            (
                project_id,
                data.get("title", "未命名项目"),
                data.get("date", ""),
                data.get("time", ""),
                data.get("status", "未生成"),
                data.get("progress", "0/0"),
                data.get("collection", ""),
                data.get("thumbnail", ""),
                1 if data.get("editable", True) else 0,
            ),
        )
        conn.execute(
            """INSERT IGNORE INTO project_payloads (
                 project_id, segments_json, character_assets_json,
                 scene_assets_json, item_assets_json, generation_tasks_json
               ) VALUES (?, '[]', '[]', '[]', '[]', '[]')""",
            (project_id,),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        conn.close()
        return ProjectDB._row_to_project(row)

    @staticmethod
    def update(data: dict) -> dict | None:
        project_id = data.get("id")
        if not project_id:
            return None
        existing = ProjectDB.get(project_id)
        if not existing:
            return None
        merged = {**existing, **{k: v for k, v in data.items() if v not in (None, "") or k in ("collection", "thumbnail")}}
        conn = get_connection()
        conn.execute(
            """UPDATE projects
               SET title = ?, date = ?, time = ?, status = ?, progress = ?, collection = ?,
                   thumbnail = ?, editable = ?, updated_at = strftime('%s','now')
               WHERE id = ?""",
            (
                merged.get("title", "未命名项目"),
                merged.get("date", ""),
                merged.get("time", ""),
                merged.get("status", "未生成"),
                merged.get("progress", "0/0"),
                merged.get("collection", ""),
                merged.get("thumbnail", ""),
                1 if merged.get("editable", True) else 0,
                project_id,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        conn.close()
        return ProjectDB._row_to_project(row)

    @staticmethod
    def delete(project_id: str):
        conn = get_connection()
        conn.execute("DELETE FROM project_payloads WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
        conn.close()

    @staticmethod
    def _get_payload_list(project_id: str, column: str) -> list:
        allowed = {
            "segments_json",
            "character_assets_json",
            "scene_assets_json",
            "item_assets_json",
            "generation_tasks_json",
        }
        if column not in allowed:
            return []
        conn = get_connection()
        row = conn.execute(f"SELECT {column} FROM project_payloads WHERE project_id = ?", (project_id,)).fetchone()
        conn.close()
        if not row:
            return []
        try:
            return json.loads(row[column] or "[]")
        except Exception:
            return []

    @staticmethod
    def get_segments(project_id: str) -> list:
        return ProjectDB._get_payload_list(project_id, "segments_json")

    @staticmethod
    def get_character_assets(project_id: str) -> list:
        return ProjectDB._get_payload_list(project_id, "character_assets_json")

    @staticmethod
    def get_scene_assets(project_id: str) -> list:
        return ProjectDB._get_payload_list(project_id, "scene_assets_json")

    @staticmethod
    def get_item_assets(project_id: str) -> list:
        return ProjectDB._get_payload_list(project_id, "item_assets_json")

    @staticmethod
    def get_generation_tasks(project_id: str) -> list:
        return ProjectDB._get_payload_list(project_id, "generation_tasks_json")

    @staticmethod
    def save_payload(
        project_id: str,
        segments: list | None = None,
        character_assets: list | None = None,
        scene_assets: list | None = None,
        item_assets: list | None = None,
        generation_tasks: list | None = None,
    ):
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT * FROM project_payloads WHERE project_id = ? FOR UPDATE",
                (project_id,),
            ).fetchone() or {}

            def encode(value: list | None, column: str) -> str:
                if value is None:
                    return str(existing.get(column) or "[]")
                return json.dumps(value, ensure_ascii=False)

            payload = (
                project_id,
                encode(segments, "segments_json"),
                encode(character_assets, "character_assets_json"),
                encode(scene_assets, "scene_assets_json"),
                encode(item_assets, "item_assets_json"),
                encode(generation_tasks, "generation_tasks_json"),
            )
            conn.execute(
                """INSERT INTO project_payloads (
                     project_id, segments_json, character_assets_json, scene_assets_json,
                     item_assets_json, generation_tasks_json, updated_at
                   )
                   VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
                   ON DUPLICATE KEY UPDATE
                     segments_json = VALUES(segments_json),
                     character_assets_json = VALUES(character_assets_json),
                     scene_assets_json = VALUES(scene_assets_json),
                     item_assets_json = VALUES(item_assets_json),
                     generation_tasks_json = VALUES(generation_tasks_json),
                     updated_at = VALUES(updated_at)""",
                payload,
            )
            conn.execute(
                "UPDATE projects SET updated_at = strftime('%s','now') WHERE id = ?",
                (project_id,),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


class TaskDB:
    @staticmethod
    def list_all(limit: int = 100) -> list[dict]:
        conn = get_connection()
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add(
        task_id: str,
        account_id: int,
        task_type: int,
        prompt: str = "",
        model: str = "",
        status: str = "pending",
        video_url: str = "",
        video_duration: int = 0,
    ) -> dict:
        conn = get_connection()
        conn.execute(
            """INSERT INTO tasks
               (task_id, account_id, task_type, prompt, model, status, video_url, video_duration)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (task_id, account_id, task_type, prompt, model, status, video_url, int(video_duration or 0)),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        conn.close()
        return dict(row)

    @staticmethod
    def update_status(task_id: str, status: str, video_url: str | None = None):
        conn = get_connection()
        if video_url is None:
            conn.execute(
                "UPDATE tasks SET status = ? WHERE task_id = ?",
                (status, task_id),
            )
        else:
            conn.execute(
                "UPDATE tasks SET status = ?, video_url = ? WHERE task_id = ?",
                (status, video_url, task_id),
            )
        conn.commit()
        conn.close()

    @staticmethod
    def update_account(task_id: str, account_id: int):
        conn = get_connection()
        conn.execute(
            "UPDATE tasks SET account_id = ? WHERE task_id = ?",
            (account_id, task_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def active_count_for_account(account_id: int, model_prefix: str = "") -> int:
        conn = get_connection()
        if model_prefix:
            row = conn.execute(
                """SELECT COUNT(*) AS cnt
                   FROM tasks
                   WHERE account_id = ? AND status IN ('pending', 'processing', 'collecting') AND model LIKE ?""",
                (account_id, f"{model_prefix}%"),
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT COUNT(*) AS cnt
                   FROM tasks
                   WHERE account_id = ? AND status IN ('pending', 'processing', 'collecting')""",
                (account_id,),
            ).fetchone()
        conn.close()
        return int(row["cnt"] if row else 0)

    @staticmethod
    def used_15s_count_for_account(account_id: int) -> int:
        conn = get_connection()
        row = conn.execute(
            """SELECT COUNT(*) AS cnt
               FROM tasks
               WHERE account_id = ?
                 AND COALESCE(video_duration, 0) >= 15
                 AND status NOT IN ('failed')""",
            (account_id,),
        ).fetchone()
        conn.close()
        return int(row["cnt"] if row else 0)

    @staticmethod
    def get(task_id: str) -> dict | None:
        conn = get_connection()
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def get_dola_task_account(task_id: str) -> dict | None:
        conn = get_connection()
        row = conn.execute(
            """SELECT t.account_id, a.name AS account_name
               FROM tasks t
               LEFT JOIN dola_accounts a ON a.id = t.account_id
               WHERE t.task_id = ?""",
            (task_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    @staticmethod
    def quickframe_stats() -> dict:
        """渠道三出片统计：按任务状态汇总（model 以 'quickframe' 开头的任务）。"""
        conn = get_connection()
        rows = conn.execute(
            """SELECT status, COUNT(*) AS cnt
               FROM tasks
               WHERE model LIKE 'quickframe%'
               GROUP BY status"""
        ).fetchall()
        total_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM tasks WHERE model LIKE 'quickframe%'"
        ).fetchone()
        remaining_row = conn.execute("SELECT COUNT(*) AS cnt FROM qf_accounts").fetchone()
        conn.close()
        by_status = {r["status"]: r["cnt"] for r in rows}
        return {
            "total": total_row["cnt"] if total_row else 0,
            "completed": by_status.get("completed", 0),
            "failed": by_status.get("failed", 0),
            "processing": by_status.get("pending", 0) + by_status.get("processing", 0),
            "remaining_accounts": remaining_row["cnt"] if remaining_row else 0,
        }
