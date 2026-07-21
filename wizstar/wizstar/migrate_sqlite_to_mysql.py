"""One-time importer for the legacy SQLite database.

Run from the repository root:

    PYTHONPATH=wizstar python -m wizstar.migrate_sqlite_to_mysql

MySQL connection values are read from ``.env`` / ``WIZSTAR_MYSQL_*``.
The SQLite source is read-only and is never deleted or modified.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from .app_paths import get_wizstar_data_dir
from .database import MYSQL_DATABASE, get_connection, init_db


TABLES = (
    "mailboxes",
    "mailbox_channel_usage",
    "accounts",
    "qf_accounts",
    "dola_accounts",
    "lovart_accounts",
    "oreateai_accounts",
    "framia_accounts",
    "tensorart_accounts",
    "projects",
    "project_payloads",
    "tasks",
)

PRIMARY_KEYS = {
    "mailboxes": ("id",),
    "mailbox_channel_usage": ("id",),
    "accounts": ("id",),
    "qf_accounts": ("id",),
    "dola_accounts": ("id",),
    "lovart_accounts": ("id",),
    "oreateai_accounts": ("id",),
    "framia_accounts": ("id",),
    "tensorart_accounts": ("id",),
    "projects": ("id",),
    "project_payloads": ("project_id",),
    "tasks": ("id",),
}

DATETIME_COLUMNS = {"created_at", "updated_at", "retry_after", "lease_expires_at"}


def _mysql_columns(connection, table_name: str) -> set[str]:
    rows = connection.execute(
        """SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?""",
        (MYSQL_DATABASE, table_name),
    ).fetchall()
    return {str(row["COLUMN_NAME"]) for row in rows}


def _to_mysql_value(column: str, value):
    if column in DATETIME_COLUMNS and isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(float(value), timezone.utc).replace(tzinfo=None)
    return value


def migrate(sqlite_path: Path) -> dict[str, int]:
    if not sqlite_path.is_file():
        raise FileNotFoundError(f"SQLite 数据库不存在: {sqlite_path}")

    init_db()
    source = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    target = get_connection()
    imported: dict[str, int] = {}
    try:
        source_tables = {
            row["name"]
            for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        for table_name in TABLES:
            if table_name not in source_tables:
                imported[table_name] = 0
                continue
            target_columns = _mysql_columns(target, table_name)
            source_columns = [
                row["name"]
                for row in source.execute(f"PRAGMA table_info(`{table_name}`)").fetchall()
                if row["name"] in target_columns
            ]
            rows = source.execute(f"SELECT * FROM `{table_name}`").fetchall()
            if not rows or not source_columns:
                imported[table_name] = 0
                continue

            quoted_columns = ", ".join(f"`{column}`" for column in source_columns)
            placeholders = ", ".join("?" for _ in source_columns)
            primary_keys = set(PRIMARY_KEYS[table_name])
            updates = ", ".join(
                f"`{column}` = VALUES(`{column}`)"
                for column in source_columns
                if column not in primary_keys
            )
            sql = (
                f"INSERT INTO `{table_name}` ({quoted_columns}) VALUES ({placeholders}) "
                f"ON DUPLICATE KEY UPDATE {updates}"
            )
            for row in rows:
                values = tuple(
                    _to_mysql_value(column, row[column])
                    for column in source_columns
                )
                target.execute(sql, values)
            imported[table_name] = len(rows)

        target.commit()
        # 迁移完成后再次执行幂等初始化，补齐各账号表对应的邮箱渠道占用状态。
        init_db()
        return imported
    except Exception:
        target.rollback()
        raise
    finally:
        source.close()
        target.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="将旧 Wizstar SQLite 数据导入 MySQL")
    parser.add_argument(
        "--sqlite-path",
        type=Path,
        default=Path(get_wizstar_data_dir()) / "wizstar.db",
        help="旧 wizstar.db 路径（默认读取 Wizstar 数据目录）",
    )
    args = parser.parse_args()
    imported = migrate(args.sqlite_path.expanduser().resolve())
    total = sum(imported.values())
    print(f"迁移完成，共导入 {total} 行到 MySQL 数据库 {MYSQL_DATABASE}:")
    for table_name, count in imported.items():
        print(f"  {table_name}: {count}")


if __name__ == "__main__":
    main()
