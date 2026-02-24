# Workflow Orchestrator — Build Plan & Decision Framework

*Backtrack Orchestra Domain Implementation*

---

# Summary

This document structures the development process for the AI Engineer take-home project using the **Backtrack Orchestra** concept as the domain. The goal is to build a **DAG-based workflow orchestrator** with a real-time React UI, human-in-the-loop phases, and worker-driven execution.

The core strategy:

* Treat **Backtrack Orchestra as the product domain**, not the orchestration engine itself.
* Build a **general workflow DAG orchestrator** that happens to run UI-patch workflows.
* Separate:

  * orchestration logic
  * phase logic
  * UI rendering
  * worker execution

This ensures the system demonstrates architecture decisions, failure handling, and UX thinking — which are explicitly what the assignment evaluates.

---

# 1. Core Design Principles

## 1.1 Separation of Concerns

**Orchestrator**
* Env Vars: DEEPSEEK, ANTHROPIC
* Defines workflows
* Tracks dependencies
* Schedules phases
* Handles pause/resume

**Phase Workers**

* Execute isolated tasks
* Call LLM or APIs
* Produce structured outputs

**Domain Layer (Backtrack Orchestra)**

* UI patch schema
* diff generation
* rubric evaluation

**Frontend**

* Real-time DAG visualization
* Human approval interface

---

## 1.2 Why This Structure

This aligns directly with evaluation criteria:

* “How you separated orchestration from phase logic”
* “How outputs flow between phases”
* “How you handle failure modes”

Backtrack Orchestra becomes a **case study** running on a reusable orchestrator.

---

# 2. System Architecture Overview

## Backend Stack

* FastAPI (API + SSE streaming)
* Celery workers (phase execution)
* Redis (queue + pub/sub)
* SQLite/Postgres (run state)

## Frontend Stack

* React + TypeScript
* ReactFlow (DAG UI)
* SSE event stream

---

# 3. Workflow Model

## 3.1 DAG Definitions

A workflow is:

```
Workflow = {
  phases: PhaseDefinition[],
  edges: Dependency[]
}
```

Each phase defines:

* input schema
* execution function
* dependencies
* human interaction flag

---

## 3.2 Minimum Required Workflow (Project Domain)

### Phase A — Human Context Initialization (Sequential)

Purpose:

* Human defines UI/UX intent and constraints in frontend
* Capture baseline UI, tokens, rubric, and design goals as structured input
* Produce the canonical parent context used by all child phases

Output:

* `ContextArtifact` / ParentVersion V0 (human-authored, validated)

---

### Phase B — Variant Generation A (Parallel)

LLM generates constrained UI patch for slot X using approved Phase A context.

Output:

* Candidate Variant A

---

### Phase C — Variant Generation B (Parallel)

Second variant or second slot using approved Phase A context.

Output:

* Candidate Variant B

---

### Phase D — Human Review (Pause Phase)

System pauses.

Frontend shows:

* diff
* rubric
* preview code

User chooses:

* approve
* reject
* retry

---

### Phase E — Merge & Finalize (Sequential)

Applies approved variant(s) to create ParentVersion V1.

---

# 4. State Machine

Each phase instance has lifecycle:

```
DRAFT
BLOCKED
RUNNING
WAITING_FOR_HUMAN
READY_FOR_REVIEW
APPROVED
REJECTED
ERROR_STATUS
COMPLETED
```

Rules:

* Children cannot start if dependencies incomplete.
* Phase A is a hard gate: B/C remain `BLOCKED` until human context is submitted and approved/completed.
* Human phase pauses scheduling.
* Retry preserves spec but creates new output.

---

# 5. Worker Strategy (Celery)

## Why Workers

They test:

* parallel execution
* retry logic
* non-blocking backend

## Execution Flow

1. Orchestrator schedules phase.
2. Celery worker executes LLM call.
3. Worker posts result → API.
4. API updates run state.
5. SSE emits event.

---

# 6. Data Flow Between Phases

Outputs must be explicit artifacts:

```
PhaseOutput = {
  variantId,
  uiSchema,
  diff,
  rubricResults
}
```

Downstream phases receive:

* approved variants
* parentVersionId
* tokens + constraints

---

# 7. Human-In-Loop Design

Human interaction happens in Phase D.

Pause logic:

```
if phase.requiresHuman:
    status = WAITING_FOR_HUMAN
    halt downstream scheduling
```

Frontend responsibilities:

* render preview
* surface rubric
* emit decision event

Resume logic:

* decision triggers next phases

---

# 8. Real-Time Streaming Strategy

Use SSE.

Event Types:

## Frontend State Store Standard (Zustand)

To prevent workflow state divergence across ReactFlow canvas, review panel, SSE hook, and phase action controls, frontend state should be centralized in a Zustand store.

## 9.1 Required Store Shape

```
WorkflowUIState = {
  snapshot: WorkflowSnapshot | null,
  selectedPhaseId: string | null,
  connectionStatus: "connecting" | "open" | "closed" | "error",
  lastEventId?: string
}
```

## 9.2 Required Store Actions

```
setSnapshot(snapshot)
selectPhase(phaseId | null)
applyEvent(event: WorkflowEvent)
setConnectionStatus(status)
applyActionResponse(response: WorkflowActionResponse)
```

## 9.3 Implementation Rules

* Keep event/action transition logic pure and contract-driven.
* `useWorkflowStream` should dispatch into store, not maintain separate local state.
* UI components should read from selectors to minimize unnecessary renders.
* Any contract update must be reflected in store transition tests.

* phase_started
* phase_completed
* phase_failed
* waiting_for_human
* resumed
* workflow_finished

Frontend updates ReactFlow nodes in response.

---

# 9. ReactFlow UX Decisions

Graph shows **phase instances**, not just definitions.

Node includes:

* phase name
* status badge
* preview icon
* retry button

Right panel shows:

* diff summary
* rubric checklist
* preview iframe

Top bar:

* run controls
* sandbox selector
* error status

Left bar:

* workflow actions
* restart
* approve current
* retry current
* finish/save

---

# 10. Failure Modes & Decisions

## Two phases finish simultaneously

Solution:

* DB transaction lock
* decrement dependent counters atomically

## Client disconnect

* Workflow continues server-side
* UI rehydrates via snapshot endpoint

## Worker crash

* Celery retry
* idempotency key `(runId, phaseId)`

## LLM failure

* mark ERROR_STATUS
* allow manual retry

---

# 11. Tradeoffs (Intentional)

Chosen:

* SSE over websockets (simpler, enough for assignment)
* constrained UI schema (safe rendering)
* explicit DAG scheduling vs recursive calls

Deferred:

* dynamic scaling
* multi-tenant auth
* complex merge logic

---

# 12. README Narrative Strategy

When writing final README:

Explain:

1. Why Backtrack Orchestra was chosen as domain.
2. Why DAG orchestrator is reusable.
3. How human interaction is modeled as a phase.
4. How state machine prevents race conditions.
5. What would break at scale.

---

# 13. Development Order (Execution Plan)

## Step 1 — Orchestrator Core

* PhaseDefinition model
* DAG scheduler
* Celery integration

## Step 2 — Backend API

* create workflow run
* resume phase
* SSE event stream

## Step 3 — React UI

* ReactFlow nodes
* status streaming
* human approval panel

## Step 4 — Backtrack Domain

* UI schema renderer
* diff generator
* rubric evaluator

---
Considerations;
Implementing cycles in a Directed Acyclic Graph (DAG) is a common way to break orchestrators.

Better approach: Treat a "Retry" as a new Workflow Run seeded with data from the old one, or simply "re-queue" the specific node while keeping the DAG structure flat.
