import os
import time
from typing import Any

from celery import group
from celery.result import AsyncResult
from flask import Flask, jsonify, request

from python_backend.celery_app import celery_app
from python_backend.llm_tasks import execute_llm_task

app = Flask(__name__)
_TASK_STATUS_LOG_CACHE: dict[str, str] = {}
_TASK_POLL_COUNT: dict[str, int] = {}


def _preview_text(value: str, limit: int = 240) -> str:
    cleaned = " ".join(value.split())
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[:limit]}..."


def _json_error(message: str, status_code: int):
    return jsonify({"error": message}), status_code


def _read_json() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    if isinstance(payload, dict):
        return payload
    return {}


def _require_non_empty(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/llm/tasks")
def create_llm_task():
    payload = _read_json()
    try:
        run_id = _require_non_empty(payload, "run_id")
        phase_id = _require_non_empty(payload, "phase_id")
        prompt = _require_non_empty(payload, "prompt")
    except ValueError as error:
        return _json_error(str(error), 400)

    provider = payload.get("provider")
    provider_value = provider.strip() if isinstance(provider, str) and provider.strip() else None
    debug_context = payload.get("debug_context")
    debug_context_value = debug_context if isinstance(debug_context, dict) else None
    app.logger.info(
        "frontend->flask /llm/tasks run_id=%s phase_id=%s provider=%s prompt_len=%d prompt_preview=%r debug_context=%s",
        run_id,
        phase_id,
        provider_value or "(auto)",
        len(prompt),
        _preview_text(prompt),
        debug_context_value,
    )

    task = execute_llm_task.delay(
        run_id=run_id,
        phase_id=phase_id,
        prompt=prompt,
        provider=provider_value,
    )
    app.logger.info(
        "flask->celery queued task_id=%s run_id=%s phase_id=%s provider=%s",
        task.id,
        run_id,
        phase_id,
        provider_value or "(auto)",
    )
    return jsonify({"taskId": task.id, "status": task.status})


@app.get("/llm/tasks/<task_id>")
def get_llm_task(task_id: str):
    result = AsyncResult(task_id, app=celery_app)
    status = result.status
    poll_count = _TASK_POLL_COUNT.get(task_id, 0) + 1
    _TASK_POLL_COUNT[task_id] = poll_count
    previous_status = _TASK_STATUS_LOG_CACHE.get(task_id)
    should_log_poll = (
        previous_status != status
        or status in {"SUCCESS", "FAILURE"}
        or poll_count % 30 == 0
    )
    if should_log_poll:
        app.logger.info(
            "frontend->flask poll /llm/tasks/%s status=%s poll_count=%d",
            task_id,
            status,
            poll_count,
        )
    _TASK_STATUS_LOG_CACHE[task_id] = status

    if status == "SUCCESS":
        payload = result.result
        if not isinstance(payload, dict):
            return _json_error("Unexpected Celery result payload", 500)
        content = payload.get("content")
        content_len = len(content) if isinstance(content, str) else 0
        app.logger.info(
            "flask->frontend task success task_id=%s provider=%s content_len=%d content_preview=%r",
            task_id,
            payload.get("provider", "unknown"),
            content_len,
            _preview_text(content) if isinstance(content, str) else "",
        )
        _TASK_STATUS_LOG_CACHE.pop(task_id, None)
        _TASK_POLL_COUNT.pop(task_id, None)
        return jsonify({"taskId": task_id, "status": status, "result": payload})

    if status == "FAILURE":
        error = str(result.result) if result.result else "Task failed"
        _TASK_STATUS_LOG_CACHE.pop(task_id, None)
        _TASK_POLL_COUNT.pop(task_id, None)
        return jsonify({"taskId": task_id, "status": status, "error": error})

    return jsonify({"taskId": task_id, "status": status})


@app.post("/llm/tasks/batch")
def create_batch_llm_tasks():
    payload = _read_json()
    items = payload.get("items")
    if not isinstance(items, list):
        return _json_error("items must be an array", 400)
    if not items:
        return jsonify({"groupId": "", "tasks": []})

    normalized_items: list[dict[str, str | None]] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            return _json_error(f"items[{index}] must be an object", 400)
        try:
            key = _require_non_empty(item, "key")
            run_id = _require_non_empty(item, "run_id")
            phase_id = _require_non_empty(item, "phase_id")
            prompt = _require_non_empty(item, "prompt")
        except ValueError as error:
            return _json_error(f"items[{index}] {error}", 400)

        provider = item.get("provider")
        provider_value = provider.strip() if isinstance(provider, str) and provider.strip() else None
        app.logger.info(
            "frontend->flask /llm/tasks/batch item=%s run_id=%s phase_id=%s provider=%s prompt_len=%d prompt_preview=%r",
            key,
            run_id,
            phase_id,
            provider_value or "(auto)",
            len(prompt),
            _preview_text(prompt),
        )
        normalized_items.append(
            {
                "key": key,
                "run_id": run_id,
                "phase_id": phase_id,
                "prompt": prompt,
                "provider": provider_value,
            }
        )

    signatures = [
        execute_llm_task.s(
            run_id=item["run_id"],
            phase_id=item["phase_id"],
            prompt=item["prompt"],
            provider=item["provider"],
        )
        for item in normalized_items
    ]
    group_result = group(signatures).apply_async()
    task_results = list(group_result.results)
    app.logger.info(
        "flask->celery queued batch group_id=%s task_count=%d",
        group_result.id,
        len(task_results),
    )

    timeout_seconds = float(os.getenv("PYTHON_BATCH_WAIT_SECONDS", "180"))
    poll_seconds = float(os.getenv("PYTHON_BATCH_POLL_SECONDS", "0.5"))
    deadline = time.monotonic() + timeout_seconds

    while time.monotonic() < deadline:
        if all(result.ready() for result in task_results):
            break
        time.sleep(poll_seconds)

    tasks: list[dict[str, Any]] = []
    for index, async_result in enumerate(task_results):
        source = normalized_items[index]
        status = async_result.status
        if status == "SUCCESS":
            value = async_result.result
            if isinstance(value, dict):
                raw_content = value.get("content")
                app.logger.info(
                    "batch task success key=%s task_id=%s provider=%s content_len=%d content_preview=%r",
                    source["key"],
                    async_result.id,
                    value.get("provider", "unknown"),
                    len(raw_content) if isinstance(raw_content, str) else 0,
                    _preview_text(raw_content) if isinstance(raw_content, str) else "",
                )
            tasks.append(
                {
                    "key": source["key"],
                    "taskId": async_result.id,
                    "status": status,
                    "result": value if isinstance(value, dict) else {},
                }
            )
            continue
        if status == "FAILURE":
            tasks.append(
                {
                    "key": source["key"],
                    "taskId": async_result.id,
                    "status": status,
                    "error": str(async_result.result) if async_result.result else "Task failed",
                }
            )
            continue
        tasks.append(
            {
                "key": source["key"],
                "taskId": async_result.id,
                "status": status,
                "error": f"Task not completed before timeout ({timeout_seconds}s)",
            }
        )

    return jsonify({"groupId": group_result.id, "tasks": tasks})
