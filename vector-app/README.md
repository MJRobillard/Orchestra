# Vector App Workflow

Workflow UI for iterative design generation, merge, and targeted induction refinement.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000/workflow`.

## Python Backend + Celery (LLM + Worker Tracking)

LLM execution can be moved behind a Python backend and tracked in Celery.
Detailed setup: `PYTHON_BACKEND_SETUP.md`.

1. Install Python backend deps:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt
```

2. Start Celery worker:

```bash
  celery -A python_backend.celery_app.celery_app worker \                                                                    
    --loglevel=info \                                                                                                        
    --concurrency=6 \                                                                                                        
    --prefetch-multiplier=1 \                                                                                                
    -Ofair   ```

3. Start Flask service:

```bash
flask --app python_backend.app run --host 127.0.0.1 --port 8000 --debug
```

4. Enable Python backend in the Next.js process:

```bash
PYTHON_BACKEND_ENABLED=1
PYTHON_BACKEND_URL=http://127.0.0.1:8000
```

Optional tuning:
- `PYTHON_LLM_TIMEOUT_MS` (default `120000`)
- `PYTHON_LLM_POLL_INTERVAL_MS` (default `1000`)

When `PYTHON_BACKEND_ENABLED=1`, TypeScript workflow handlers submit LLM work to `/llm/tasks` and poll `/llm/tasks/{taskId}`, so worker lifecycle is tracked by Celery states (`PENDING`, `STARTED`, `SUCCESS`, `FAILURE`) without requiring Redis.

## Current Process

1. **Phase A: Initialize Context (Human)**
   - Enter intent, optional tokens/rubric, and branch factor.
2. **Variant Generation (LLM)**
   - Base variants (`phase_b`, `phase_c`) plus dynamic branches based on branch factor.
3. **Phase D: Human Review + Merge Instruction**
   - Select inspiration variants.
   - Provide natural-language merge instruction.
4. **Phase E: Merge + Finalize (LLM)**
   - Produces merged HTML output.
5. **Induction (Fine-Tune)**
   - Target a specific component/subset and generate induction variants.
6. **Induction Merge (Human)**
   - Pick the best induction variant to merge.
7. Repeat steps 5–6 as needed, or export HTML and stop.

## Notes

- Induction is intended for **targeted component-level refinement**, not full-page rewrites.
- Each preview iframe has a **Download HTML** action.
- Induction merge view has an **Export HTML** action for final output.

## Verification Tests

Use these checks to verify that LLM wiring and backend integration are working.

### Python tests (backend task layer)

1. Mocked provider-selection checks (no real network):

```bash
python -m unittest -v python_backend/test_llm_env_selection.py
```

2. Live LLM provider call checks (real DeepSeek/Anthropic API calls):
Requires `DEEPSEEK_API_KEY` and/or `ANTHROPIC_API_KEY` in `.env.local`.

```bash
RUN_LIVE_LLM_TEST=1 python -m unittest -v python_backend/test_llm_env_selection.py
```

### Playwright contract tests

1. Contract suite (default):

```bash
npm run test:contracts
```

2. Run real LLM check inside contract tests:
Requires real API key env vars (for DeepSeek check in the contract suite).

```bash
RUN_LLM_CHECK=1 npm run test:contracts
```

3. If you want mocked contract behavior while `.env.local` has Python backend enabled:

```bash
PYTHON_BACKEND_ENABLED=0 npm run test:contracts
```

### Quick runtime health checks

With Flask running:

```bash
curl http://127.0.0.1:8000/health
```

Expected:

```json
{"status":"ok"}
```

With Next.js running:

```bash
curl http://127.0.0.1:3000/api/python-backend/health
```

Expected when enabled and reachable:

```json
{"enabled":true,"connected":true,...}
```
