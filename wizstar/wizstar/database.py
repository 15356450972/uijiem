"""SQLite 持久化层 — 邮箱库 / 账号库 / 任务记录"""

from __future__ import annotations

import sqlite3
import os
import json
import time
from pathlib import Path
from .app_paths import get_wizstar_data_dir

DB_PATH = os.path.join(get_wizstar_data_dir(), "wizstar.db")


def _ensure_dir():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    _ensure_dir()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Some sandboxes and locked Windows profiles cannot switch journal mode.
    # Keep SQLite's default mode in that case so the app can still start.
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass
    return conn


def init_db():
    conn = get_connection()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS mailboxes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            client_id TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            status TEXT DEFAULT 'unknown',
            created_at REAL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            uid INTEGER DEFAULT 0,
            display_name TEXT DEFAULT '',
            osduss TEXT DEFAULT '',
            refresh_token TEXT DEFAULT '',
            pass_os_refresh_tk TEXT DEFAULT '',
            points_balance INTEGER DEFAULT 0,
            max_concurrency INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            created_at REAL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            account_id INTEGER,
            task_type INTEGER,
            prompt TEXT DEFAULT '',
            model TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            video_url TEXT DEFAULT '',
            created_at REAL DEFAULT (strftime('%s','now')),
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        );

        CREATE TABLE IF NOT EXISTS qf_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            cs_session TEXT DEFAULT '',
            bearer TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            note TEXT DEFAULT '',
            created_at REAL DEFAULT (strftime('%s','now')),
            updated_at REAL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS dola_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            env_file TEXT DEFAULT '',
            profile_dir TEXT DEFAULT '',
            cookie_masked TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            device_id_masked TEXT DEFAULT '',
            web_id_masked TEXT DEFAULT '',
            fp_masked TEXT DEFAULT '',
            max_concurrency INTEGER DEFAULT 1,
            daily_video_quota INTEGER DEFAULT 6,
            daily_video_used INTEGER DEFAULT 0,
            daily_video_date TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            note TEXT DEFAULT '',
            created_at REAL DEFAULT (strftime('%s','now')),
            updated_at REAL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date TEXT DEFAULT '',
            time TEXT DEFAULT '',
            status TEXT DEFAULT '未生成',
            progress TEXT DEFAULT '0/0',
            collection TEXT DEFAULT '',
            thumbnail TEXT DEFAULT '',
            editable INTEGER DEFAULT 1,
            created_at REAL DEFAULT (strftime('%s','now')),
            updated_at REAL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS project_payloads (
            project_id TEXT PRIMARY KEY,
            segments_json TEXT DEFAULT '[]',
            character_assets_json TEXT DEFAULT '[]',
            scene_assets_json TEXT DEFAULT '[]',
            item_assets_json TEXT DEFAULT '[]',
            generation_tasks_json TEXT DEFAULT '[]',
            updated_at REAL DEFAULT (strftime('%s','now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
    """)
    existing_payload_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(project_payloads)").fetchall()
    }
    for col in ("scene_assets_json", "item_assets_json", "generation_tasks_json"):
        if col not in existing_payload_cols:
            conn.execute(f"ALTER TABLE project_payloads ADD COLUMN {col} TEXT DEFAULT '[]'")
    existing_dola_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(dola_accounts)").fetchall()
    }
    if "max_concurrency" not in existing_dola_cols:
        conn.execute("ALTER TABLE dola_accounts ADD COLUMN max_concurrency INTEGER DEFAULT 1")
    if "daily_video_quota" not in existing_dola_cols:
        conn.execute("ALTER TABLE dola_accounts ADD COLUMN daily_video_quota INTEGER DEFAULT 6")
    if "daily_video_used" not in existing_dola_cols:
        conn.execute("ALTER TABLE dola_accounts ADD COLUMN daily_video_used INTEGER DEFAULT 0")
    if "daily_video_date" not in existing_dola_cols:
        conn.execute("ALTER TABLE dola_accounts ADD COLUMN daily_video_date TEXT DEFAULT ''")
    conn.commit()
    conn.close()


class MailboxDB:
    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("""
            SELECT m.*,
                   CASE WHEN a.id IS NOT NULL THEN 'registered' ELSE m.status END AS status
            FROM mailboxes m
            LEFT JOIN accounts a ON m.email = a.email
            ORDER BY m.created_at DESC
        """).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add(email: str, client_id: str, refresh_token: str) -> dict:
        conn = get_connection()
        conn.execute(
            "INSERT INTO mailboxes (email, client_id, refresh_token) VALUES (?, ?, ?)",
            (email, client_id, refresh_token),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM mailboxes WHERE email = ?", (email,)).fetchone()
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


class AccountDB:
    @staticmethod
    def list_all() -> list[dict]:
        conn = get_connection()
        rows = conn.execute("SELECT * FROM accounts ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def add(email: str, password: str, uid: int = 0, display_name: str = "",
            osduss: str = "", refresh_token: str = "", pass_os_refresh_tk: str = "",
            points_balance: int = 0, max_concurrency: int = 1) -> dict:
        conn = get_connection()
        conn.execute(
            """INSERT OR REPLACE INTO accounts
               (email, password, uid, display_name, osduss, refresh_token, pass_os_refresh_tk, points_balance, max_concurrency)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (email, password, uid, display_name, osduss, refresh_token, pass_os_refresh_tk, points_balance, max_concurrency),
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
        conn.execute("UPDATE accounts SET points_balance = ?, status = 'active' WHERE id = ?", (points, account_id))
        conn.commit()
        conn.close()

    @staticmethod
    def update_status(account_id: int, status: str):
        conn = get_connection()
        conn.execute("UPDATE accounts SET status = ? WHERE id = ?", (status, account_id))
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
            """INSERT OR REPLACE INTO qf_accounts
               (email, cs_session, bearer, status, note, updated_at)
               VALUES (?, ?, ?, ?, ?, strftime('%s','now'))""",
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
            row = conn.execute("SELECT * FROM dola_accounts WHERE id = ?", (account_id,)).fetchone()
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
    def reserve_best_daily_video_quota(cost: int) -> dict | None:
        cost = max(1, int(cost or 1))
        today = time.strftime("%Y-%m-%d")
        conn = get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute("SELECT * FROM dola_accounts WHERE status = 'active'").fetchall()
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


class ProjectDB:
    @staticmethod
    def _row_to_project(row: sqlite3.Row) -> dict:
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
        conn.execute("INSERT OR IGNORE INTO project_payloads (project_id) VALUES (?)", (project_id,))
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
        segments: list,
        character_assets: list,
        scene_assets: list | None = None,
        item_assets: list | None = None,
        generation_tasks: list | None = None,
    ):
        conn = get_connection()
        conn.execute(
            """INSERT INTO project_payloads (
                 project_id, segments_json, character_assets_json, scene_assets_json,
                 item_assets_json, generation_tasks_json, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
               ON CONFLICT(project_id) DO UPDATE SET
                 segments_json = excluded.segments_json,
                 character_assets_json = excluded.character_assets_json,
                 scene_assets_json = excluded.scene_assets_json,
                 item_assets_json = excluded.item_assets_json,
                 generation_tasks_json = excluded.generation_tasks_json,
                 updated_at = strftime('%s','now')""",
            (
                project_id,
                json.dumps(segments, ensure_ascii=False),
                json.dumps(character_assets, ensure_ascii=False),
                json.dumps(scene_assets or [], ensure_ascii=False),
                json.dumps(item_assets or [], ensure_ascii=False),
                json.dumps(generation_tasks or [], ensure_ascii=False),
            ),
        )
        conn.execute("UPDATE projects SET updated_at = strftime('%s','now') WHERE id = ?", (project_id,))
        conn.commit()
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
    ) -> dict:
        conn = get_connection()
        conn.execute(
            """INSERT INTO tasks
               (task_id, account_id, task_type, prompt, model, status, video_url)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (task_id, account_id, task_type, prompt, model, status, video_url),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        conn.close()
        return dict(row)

    @staticmethod
    def update_status(task_id: str, status: str, video_url: str = ""):
        conn = get_connection()
        conn.execute(
            "UPDATE tasks SET status = ?, video_url = ? WHERE task_id = ?",
            (status, video_url, task_id),
        )
        conn.commit()
        conn.close()

    @staticmethod
    def active_count_for_account(account_id: int) -> int:
        conn = get_connection()
        row = conn.execute(
            """SELECT COUNT(*) AS cnt
               FROM tasks
               WHERE account_id = ? AND status IN ('pending', 'processing')""",
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
