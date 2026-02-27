# vector-app

## Testing

### Latest local results
- `npm run test:frontend`: `12 passed`
- `npm run test:contracts`: `23 passed`, `1 skipped` (`runLLMCheck makes a real DeepSeek network call`)

### Expectations
- Contract tests include an env preflight and will fail clearly if:
  - `.env.local` is missing in `vector-app`
  - `ANTHROPIC_API_KEY` (or `ANTHROPIC`) is missing
  - `ANTHROPIC_MODEL` is missing
- The live DeepSeek contract test runs only when:
  - `RUN_LLM_CHECK=1` (or `runLLMCheck=1`)
  - `DEEPSEEK_API_KEY` (or `DEEPSEEK`) is set
- Frontend workflow tests are deterministic and do not require live LLM keys.
