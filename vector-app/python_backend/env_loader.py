import os
from pathlib import Path


def _parse_env_line(raw: str) -> tuple[str, str] | None:
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip().strip('"').strip("'")
    if not key:
        return None
    return key, value


def load_python_backend_env(base_dir: Path) -> None:
    # Local override first, then generic .env fallback.
    for filename in (".env.local", ".env"):
        env_path = base_dir / filename
        if not env_path.exists():
            continue
        with env_path.open("r", encoding="utf-8") as handle:
            for raw in handle:
                parsed = _parse_env_line(raw)
                if not parsed:
                    continue
                key, value = parsed
                os.environ.setdefault(key, value)
