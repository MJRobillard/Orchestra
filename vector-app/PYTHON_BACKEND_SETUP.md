# Python Backend Setup

This project can run LLM execution and worker fan-out through a Python backend backed by Celery.
It uses Flask for HTTP endpoints and does not require Redis.

## 1) Prereqs

- Python 3.11+
- Node app dependencies installed (`npm install`)

## 2) Install Python dependencies

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt
```

## 3) Start Celery worker

```bash
source .venv/bin/activate
celery -A python_backend.celery_app.celery_app worker --loglevel=info
```

## 4) Start Flask service

```bash
source .venv/bin/activate
flask --app python_backend.app run --host 127.0.0.1 --port 8000 --debug
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

## 5) Configure Next.js runtime

Set these env vars where you run `npm run dev`:

```bash
PYTHON_BACKEND_ENABLED=1
PYTHON_BACKEND_URL=http://127.0.0.1:8000
```

Optional:

```bash
PYTHON_LLM_TIMEOUT_MS=120000
PYTHON_LLM_POLL_INTERVAL_MS=1000
PYTHON_BATCH_WAIT_SECONDS=180
PYTHON_BATCH_POLL_SECONDS=0.5
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

## 6) Start the app

```bash
npm run dev
```

Open `http://localhost:3000/workflow`.

## Notes

- Single LLM calls are queued via `POST /llm/tasks` and polled via `GET /llm/tasks/{taskId}`.
- Worker fan-out paths (variant permutations and induction refinements) are queued via `POST /llm/tasks/batch`.
- Celery task states (`PENDING`, `STARTED`, `SUCCESS`, `FAILURE`) provide backend worker tracking.
- Default Celery transport is filesystem (`.data/celery/*`) and result backend is SQLite (`.data/celery/results.sqlite3`).
