# Vector Workflow System

## What I designed / built
This project is a workflow-orchestration system for iterative UI generation and refinement.

- Frontend: Next.js workflow console (`/workflow`) with DAG visualization, action controls, live stream updates, and sandboxed preview rendering.
- Backend (TypeScript in Next route handlers): workflow orchestrator, phase transitions, event streaming (SSE), artifact persistence, and LLM execution pipeline.
- Optional Python backend: Flask + Celery task layer for queued LLM execution and batch fan-out.
- Shared contract layer: strongly typed workflow schema/events/actions used by both teams.

The workflow supports:
- Phase A context initialization (human + normalization)
- Parallel variant generation (B/C + dynamic branch fan-out)
- Phase D human merge review
- Phase E auto-finalization and targeted induction/refinement loops

## Why this domain / approach
UI generation workflows need both automation and human checkpoints. The architecture here uses:

- Contract-first collaboration: frontend and backend both consume the same workflow contract and pure state reducers.
- Explicit phase DAG: dependency-aware transitions make automation safe while keeping manual review where needed.
- Progressive orchestration: start with in-process backend, then optionally offload LLM work to Python/Celery without changing the frontend contract.

This gives fast iteration for product development while still supporting production-style async execution.

## Architecture

### Excalidraw diagram
- Architecture diagram JSON: `docs/vector-workflow-architecture.excalidraw.json`
- Open it by importing into https://excalidraw.com (`Menu -> Open -> From file`).
- Scope shown: frontend, TS orchestrator, Python/Celery primary runtime, and test lanes.

### Core components
- Shared contracts: `vector-app/contracts/workflow-contract.ts`
- Shared state transition helpers: `vector-app/contracts/workflow-state.ts`
- Orchestrator: `vector-app/backend/workflow-engine.ts`
- Action + phase execution handler: `vector-app/backend/workflow-http.ts`
- Event bus + SSE: `vector-app/backend/workflow-events.ts` and `vector-app/app/api/workflows/[runId]/stream/route.ts`
- Persistence: `vector-app/backend/workflow-db.ts` (`.data/workflow-db.json` + lock directory)
- LLM client abstraction: `vector-app/backend/llm-client.ts`
- Optional async execution backend: `vector-app/python_backend/*`

### Orchestrator behavior
- Runs are seeded from `mock_responses/workflow.snapshot.json` and normalized so Phase A is the initial hard gate.
- `applyWorkflowAction` mutates phase state and emits `phase_updated` events.
- `unblockDependents` transitions blocked nodes to `DRAFT` when dependency statuses are satisfied (`COMPLETED` or `APPROVED`).
- Artifacts and outputs are persisted by phase attempt so retries are scoped cleanly.

### Phase model
- Phase A (`HUMAN`): captures context payload; auto-approves once normalized.
- Phase B/C (`LLM`): generated variants; auto-approved to funnel review into Phase D.
- Phase D (`HUMAN`): merge rationale and variant preference capture.
- Phase E (`SYSTEM` + retry path): final merge output and induction refinement cycles.

### Parallelism model
Parallelism is used in two places:

- Phase A fan-out: `callLlmBatch` generates multiple permutation variants in parallel based on `branchFactor` (2..8).
- Phase E induction retry: `callLlmBatch` launches multiple targeted refinement branches in parallel, then stores combined results for human merge selection.

Failure handling is resilient:
- Batch uses per-item success/failure status.
- Partial successes are retained; failures are recorded in `autoStartErrors` and variant metadata.
- If all branches fail, endpoints return an error with explicit failure reason.

## Two-team build/test architecture (Python backend primary)

### Team split
- Team Frontend (Team B): DAG rendering, stream consumption, action UX, local store transitions.
- Team Backend (Team A): contract validity, action endpoints, orchestrator transitions, persistence, LLM provider routing.

Both teams integrate through:
- Shared `workflow-contract.ts`
- Shared pure reducers in `workflow-state.ts`
- Contract tests (`tests/backend.contract.spec.ts`)
- Frontend state tests (`tests/frontend.workflow.spec.ts`)

### Backend evolution note (why TS toggles exist)
The project was initially easier to stand up in TypeScript route handlers, so orchestration and tests were built there first.
`PYTHON_BACKEND_ENABLED` and `PYTHON_BACKEND_URL` were added after that to switch LLM execution to Flask/Celery once backend contracts were proven.
This let backend behavior be test-defined early while Celery integration was implemented in parallel.

### Primary runtime mode
Primary mode for real execution is Python backend enabled:
```bash
PYTHON_BACKEND_ENABLED=1
PYTHON_BACKEND_URL=http://127.0.0.1:8000
```
In this mode, Next.js routes orchestrate workflow state while LLM tasks are queued/executed by Flask + Celery.

### Fast testing lanes
Run from `vector-app/`.

1. Frontend fast lane (pure contract/state behavior):
```bash
npm run test:frontend
```
Covers state reducers, action mapping, SSE event application, and client-side contract assumptions.

2. Backend fast lane (contract + orchestrator, network-free):
```bash
RUN_LLM_CHECK=0 PYTHON_BACKEND_ENABLED=0 npm run test:contracts
```
Covers endpoint behavior, action/event contracts, persistence semantics, retries, merge/refinement orchestration.

3. Python backend unit lane (mocked provider calls):
```bash
RUN_LIVE_LLM_TEST=0 python -m unittest -v python_backend/test_llm_env_selection.py
```
Covers provider selection, endpoint/key selection, and response parsing logic.

### Skipped/deprecated tests (intended)
- `tests/backend.contract.spec.ts` live check test (`runLLMCheck makes a real DeepSeek network call`) is skipped unless `RUN_LLM_CHECK=1`.
  Intended result: skipped by default to keep CI/local runs deterministic and network-free.
- `python_backend/test_llm_env_selection.py` live provider subtests are skipped unless `RUN_LIVE_LLM_TEST=1`.
  Intended result: skipped by default to avoid external API/network dependency.
- Some TS-only direct-LLM assumptions are effectively deprecated for production usage because Python backend mode is primary.
  Intended result: keep these for compatibility/regression coverage, but use Python backend mode for end-to-end validation.

### Notes for reliable local runs
If `.env.local` enables live/network modes, fast local tests may fail or become flaky. For deterministic local CI-style runs, force overrides shown above.

## Trade-offs and why
- In-process TS orchestrator inside Next routes:
  - Pro: very fast iteration and simple deployment for early stage.
  - Con: runtime coupling to Next server process.
- File/JSON + lock persistence:
  - Pro: no external DB required for local development.
  - Con: limited concurrency/scalability compared to a real transactional store.
- Auto-approving machine phases B/C:
  - Pro: keeps human effort concentrated in merge/review phases.
  - Con: less manual gating granularity before Phase D.
- SSE event stream + authoritative re-fetch after actions:
  - Pro: responsive UI with eventual consistency for dependent unblocks.
  - Con: requires extra snapshot fetch to resolve silent dependent transitions.

## Local setup instructions

### 1) Install Node dependencies
From repo root:
```bash
cd vector-app
npm install
```

### 2) Run app
```bash
npm run dev
```
Open: `http://localhost:3000/workflow`

### 3) Start Python backend + Celery (primary)
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r python_backend/requirements.txt
```

Start worker:
```bash
source .venv/bin/activate
celery -A python_backend.celery_app.celery_app worker --loglevel=info
```

Start Flask API:
```bash
source .venv/bin/activate
flask --app python_backend.app run --host 127.0.0.1 --port 8000 --debug
```

Set env for Next runtime:
```bash
PYTHON_BACKEND_ENABLED=1
PYTHON_BACKEND_URL=http://127.0.0.1:8000
```

Health checks:
```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:3000/api/python-backend/health
```

## Suggested execution order for contributors
1. `npm run test:frontend`
2. `RUN_LLM_CHECK=0 PYTHON_BACKEND_ENABLED=0 npm run test:contracts`
3. `RUN_LIVE_LLM_TEST=0 python -m unittest -v python_backend/test_llm_env_selection.py`
4. Start Flask + Celery and run app with `PYTHON_BACKEND_ENABLED=1` for primary integration flow.
5. (Optional) run live/provider checks only when validating external integrations.
