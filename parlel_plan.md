# Parallel Plan - Workflow Orchestrator Foundation
FRONTEND TEAM REVIEW: @design.png
## Goal
Start both workstreams in parallel with a strict integration contract so frontend and backend can develop independently and merge with minimal rework.

## First Task Completed: Integration Contract (Single Source of Truth)
The shared contract for snapshot, action API, and SSE events is defined in:

- `vector-app/contracts/workflow-contract.ts`

The canonical mock payloads are defined in:

- `vector-app/mock_responses/workflow.snapshot.json`
- `vector-app/mock_responses/action.requests.json`
- `vector-app/mock_responses/sse.phase_updated.json`

## Contract Scope

### 1. Workflow Snapshot
`WorkflowSnapshot` defines the load payload used by UI and backend.

Key fields:
- `nodes[]`: phase metadata and current status
- `edges[]`: DAG links
- `phases{}`: phase runtime details, attempts, outputs, and artifacts

### 2. Action API
`WorkflowActionRequest` / `WorkflowActionResponse` defines write-side actions.

Supported actions:
- `START_PHASE`
- `APPROVE_PHASE`
- `REJECT_PHASE`
- `RETRY_PHASE`

Canonical route templates are in `ACTION_ENDPOINTS`.

### 3. SSE Event Stream
`WorkflowEvent` union defines runtime events and payload shapes.

Required event:
- `phase_updated`

Also defined:
- `heartbeat`
- `phase_output_ready`
- `workflow_completed`
- `workflow_failed`

## Parallel Workstreams

### Team A - Backend (Agentic DAG)
1. Build `WorkflowRunner` against `WorkflowSnapshot` semantics.
2. Persist `WorkflowRun`, `PhaseInstance`, `Artifact` using contract fields.
3. Emit SSE messages that conform to `WorkflowEvent`.
4. Implement action handlers matching `WorkflowActionRequest`.
5. Validate pause/resume transitions for `WAITING_FOR_HUMAN`.

### Team B - Frontend (UX/Flow)
1. Render static DAG from `workflow.snapshot.json`.
2. Map `PhaseStatus` to node styling states.
3. Build `useWorkflowStream` around `WorkflowEvent`.
4. Build review panel using `PhaseOutput.diff` and `PhaseOutput.rubricResults`.
5. Wire approve/reject/retry controls using `WorkflowActionRequest`.

## Handshake Milestones

| Milestone | Backend Delivery | Frontend Delivery |
| --- | --- | --- |
| 1 | DAG JSON schema stable (`WorkflowSnapshot`) | Static DAG rendering from mock snapshot |
| 2 | SSE `heartbeat` + `phase_updated` stream | Live node state updates from SSE |
| 3 | Action endpoints for approve/reject/retry | Review panel buttons post contract payloads |
| 4 | Real artifacts persisted in DB | Real diff/rubric rendering from API artifacts |

## Integration Rules
1. Any contract change must update `workflow-contract.ts` and all three mocks in one PR.
2. Use `CONTRACT_VERSION` to signal breaking changes.
3. No frontend/backend merge without contract compatibility check.

## Definition of Done for Foundation
1. Shared TypeScript contract exists.
2. Mock payloads exist and match contract.
3. Parallel tasks are unblocked and can start without waiting on each other.

## Contract Test Guardrails
Playwright is used as the shared workflow test runner for both teams.

- Team A contract suite: `vector-app/tests/backend.contract.spec.ts`
- Team B state-sync suite: `vector-app/tests/frontend.workflow.spec.ts`

Commands:
- `npm run test:contracts`
- `npm run test:e2e`

## Frontend Team Instructions - Zustand Adoption
Goal: move workflow UI state to a single store so DAG canvas, panel, SSE, and action controls stay synchronized.

### Scope
1. Add `zustand` and create `vector-app/app/workflow/store/workflow-store.ts`.
2. Move these fields into store state:
- `snapshot: WorkflowSnapshot | null`
- `selectedPhaseId: string | null`
- `connectionStatus: "connecting" | "open" | "closed" | "error"`
- `lastEventId?: string`
3. Add store actions:
- `setSnapshot(snapshot)`
- `selectPhase(phaseId | null)`
- `applyEvent(event)` using contract-safe transitions
- `setConnectionStatus(status)`
- `applyActionResponse(response)`

### Integration Steps
1. `page.tsx` should read/write workflow data via hooks from the store (no local `useState` for snapshot/selection).
2. `useWorkflowStream` should only dispatch `applyEvent` and `setConnectionStatus`.
3. Action buttons (`approve/reject/retry/start`) should call API then dispatch `applyActionResponse`.
4. Keep transition logic in pure functions so backend/contract tests can reuse it.

### Definition of Done
1. Refresh keeps same initial rendering from snapshot mocks.
2. SSE updates mutate store and immediately update DAG + side panel.
3. Selecting a node updates panel via `selectedPhaseId` in store.
4. Playwright frontend suite remains green.
