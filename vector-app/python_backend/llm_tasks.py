import os
import logging
from typing import Any

import requests

from python_backend.celery_app import celery_app

DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
logger = logging.getLogger(__name__)


def _preview_text(value: str, limit: int = 240) -> str:
    cleaned = " ".join(value.split())
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[:limit]}..."


def _redact_key(value: str) -> str:
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def _resolve_provider(explicit_provider: str | None = None) -> str:
    if explicit_provider:
        normalized = explicit_provider.strip().lower()
        if normalized in {"deepseek", "anthropic"}:
            return normalized

    explicit_env = (os.getenv("LLM_PROVIDER") or os.getenv("LLM") or "").strip().lower()
    if explicit_env in {"deepseek", "anthropic"}:
        return explicit_env
    return "deepseek" if os.getenv("TESTING") == "1" else "anthropic"


def _provider_key(provider: str) -> str:
    if provider == "deepseek":
        key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("DEEPSEEK")
        if not key:
            raise RuntimeError("DEEPSEEK_API_KEY or DEEPSEEK is required for DeepSeek calls")
        return key

    key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY or ANTHROPIC is required for Anthropic calls")
    return key


def _parse_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""

    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    def extract_text_blocks(blocks: Any) -> str:
        if isinstance(blocks, str):
            return blocks
        if not isinstance(blocks, list):
            return ""

        text_parts: list[str] = []
        for block in blocks:
            if isinstance(block, str):
                text_parts.append(block)
                continue
            if not isinstance(block, dict):
                continue
            direct_text = block.get("text")
            if isinstance(direct_text, str):
                text_parts.append(direct_text)
                continue
            nested_content = block.get("content")
            if isinstance(nested_content, str):
                text_parts.append(nested_content)
                continue
            if isinstance(nested_content, list):
                nested_text = extract_text_blocks(nested_content)
                if nested_text:
                    text_parts.append(nested_text)
        return "".join(text_parts).strip()

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                parsed = extract_text_blocks(content)
                if parsed:
                    return parsed

    content = payload.get("content")
    if isinstance(content, list) and content:
        parsed = extract_text_blocks(content)
        if parsed:
            return parsed

    return ""


def _invoke_provider(prompt: str, provider: str) -> str:
    api_key = _provider_key(provider)
    timeout_seconds = float(os.getenv("PYTHON_LLM_HTTP_TIMEOUT_SECONDS", "60"))
    logger.info(
        "celery->llm dispatch provider=%s prompt_len=%d prompt_preview=%r timeout_seconds=%s api_key=%s",
        provider,
        len(prompt),
        _preview_text(prompt),
        timeout_seconds,
        _redact_key(api_key),
    )

    if provider == "deepseek":
        logger.info("dispatch details provider=deepseek endpoint=%s model=deepseek-chat", DEEPSEEK_ENDPOINT)
        response = requests.post(
            DEEPSEEK_ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        parsed = _parse_text(response.json())
        logger.info(
            "llm->celery response provider=deepseek status_code=%d content_len=%d content_preview=%r",
            response.status_code,
            len(parsed),
            _preview_text(parsed),
        )
        return parsed

    logger.info("dispatch details provider=anthropic endpoint=%s model=%s", ANTHROPIC_ENDPOINT, ANTHROPIC_MODEL)
    response = requests.post(
        ANTHROPIC_ENDPOINT,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": 2048,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    parsed = _parse_text(response.json())
    logger.info(
        "llm->celery response provider=anthropic status_code=%d content_len=%d content_preview=%r",
        response.status_code,
        len(parsed),
        _preview_text(parsed),
    )
    return parsed


@celery_app.task(name="vector.llm.execute", bind=True)
def execute_llm_task(
    self,
    *,
    run_id: str,
    phase_id: str,
    prompt: str,
    provider: str | None = None,
) -> dict[str, Any]:
    selected_provider = _resolve_provider(provider)
    logger.info(
        "celery task start task_id=%s run_id=%s phase_id=%s provider=%s explicit_provider=%s",
        self.request.id,
        run_id,
        phase_id,
        selected_provider,
        provider or "(none)",
    )
    self.update_state(
        state="STARTED",
        meta={
            "run_id": run_id,
            "phase_id": phase_id,
            "provider": selected_provider,
        },
    )
    content = _invoke_provider(prompt=prompt, provider=selected_provider)
    logger.info(
        "celery task success task_id=%s run_id=%s phase_id=%s provider=%s content_len=%d content_preview=%r",
        self.request.id,
        run_id,
        phase_id,
        selected_provider,
        len(content),
        _preview_text(content),
    )
    return {
        "run_id": run_id,
        "phase_id": phase_id,
        "provider": selected_provider,
        "content": content,
    }
