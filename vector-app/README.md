# Vector App Workflow

Workflow UI for iterative design generation, merge, and targeted induction refinement.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000/workflow`.

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
