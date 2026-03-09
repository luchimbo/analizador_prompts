import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.utils import ensure_directory, json_dumps


class RunRepository:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)

    def initialize(self) -> None:
        ensure_directory(self.db_path.parent)
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    status TEXT NOT NULL,
                    audited_provider TEXT NOT NULL,
                    audited_model TEXT NOT NULL,
                    product_url TEXT NOT NULL,
                    language TEXT NOT NULL,
                    market TEXT NOT NULL,
                    enable_web_search INTEGER NOT NULL,
                    product_profile_json TEXT,
                    prompt_bank_json TEXT,
                    summary_json TEXT,
                    export_path TEXT,
                    error_message TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    prompt_id TEXT NOT NULL,
                    prompt_type TEXT NOT NULL,
                    prompt_text TEXT NOT NULL,
                    raw_response TEXT NOT NULL,
                    detected_urls_json TEXT,
                    cited_urls_json TEXT,
                    latency_ms INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    model_provider TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    product_hit INTEGER NOT NULL,
                    vendor_hit INTEGER NOT NULL,
                    exact_url_accuracy INTEGER NOT NULL,
                    product_competitors INTEGER NOT NULL,
                    rank INTEGER NOT NULL,
                    evidence_snippet TEXT,
                    judge_provider TEXT,
                    judge_model TEXT,
                    judge_notes TEXT,
                    FOREIGN KEY(run_id) REFERENCES runs(run_id)
                )
                """
            )
            connection.commit()

    def create_run(self, payload: dict[str, Any]) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                INSERT INTO runs (
                    run_id, created_at, status, audited_provider, audited_model,
                    product_url, language, market, enable_web_search,
                    product_profile_json, prompt_bank_json, summary_json,
                    export_path, error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload["run_id"],
                    payload.get("created_at", datetime.now(UTC).isoformat()),
                    payload["status"],
                    payload["audited_provider"],
                    payload["audited_model"],
                    payload["product_url"],
                    payload["language"],
                    payload["market"],
                    int(payload["enable_web_search"]),
                    json_dumps(payload.get("product_profile_json")),
                    json_dumps(payload.get("prompt_bank_json")),
                    json_dumps(payload.get("summary_json")),
                    payload.get("export_path"),
                    payload.get("error_message"),
                ),
            )
            connection.commit()

    def update_run(self, run_id: str, **fields: Any) -> None:
        if not fields:
            return
        assignments = []
        values: list[Any] = []
        for key, value in fields.items():
            assignments.append(f"{key} = ?")
            if key.endswith("_json"):
                values.append(json_dumps(value))
            elif key == "enable_web_search":
                values.append(int(value))
            else:
                values.append(value)
        values.append(run_id)
        statement = f"UPDATE runs SET {', '.join(assignments)} WHERE run_id = ?"
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(statement, tuple(values))
            connection.commit()

    def insert_prompt_result(self, result: dict[str, Any]) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                INSERT INTO prompt_results (
                    run_id, prompt_id, prompt_type, prompt_text, raw_response,
                    detected_urls_json, cited_urls_json, latency_ms, created_at,
                    model_provider, model_name, product_hit, vendor_hit,
                    exact_url_accuracy, product_competitors, rank,
                    evidence_snippet, judge_provider, judge_model, judge_notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result["run_id"],
                    result["prompt_id"],
                    result["prompt_type"],
                    result["prompt_text"],
                    result["raw_response"],
                    json_dumps(result.get("detected_urls", [])),
                    json_dumps(result.get("cited_urls", [])),
                    result["latency_ms"],
                    result["created_at"],
                    result["model_provider"],
                    result["model_name"],
                    result["product_hit"],
                    result["vendor_hit"],
                    result["exact_url_accuracy"],
                    result["product_competitors"],
                    result["rank"],
                    result.get("evidence_snippet"),
                    result.get("judge_provider"),
                    result.get("judge_model"),
                    result.get("judge_notes"),
                ),
            )
            connection.commit()

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with sqlite3.connect(self.db_path) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        with sqlite3.connect(self.db_path) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                "SELECT run_id, status, created_at, audited_provider, audited_model, product_profile_json, export_path FROM runs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_prompt_results(self, run_id: str) -> list[dict[str, Any]]:
        with sqlite3.connect(self.db_path) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                "SELECT * FROM prompt_results WHERE run_id = ? ORDER BY prompt_id ASC",
                (run_id,),
            ).fetchall()
        return [dict(row) for row in rows]
