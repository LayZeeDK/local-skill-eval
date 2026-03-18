# External Integrations

**Analysis Date:** 2026-03-10

## AI Agents (Evaluated Subjects)

**Gemini CLI:**
- Role: Default agent under evaluation; executed inside Docker or local workspace
- Invocation: `gemini -y --sandbox=none -p "$(cat /tmp/.prompt.md)"` (run as shell command inside environment)
- Auth: `GEMINI_API_KEY` env var (passed into execution environment)
- Implementation: `src/agents/gemini.ts`
- Note: The CLI binary must be installed inside the Docker image or locally. The `superlint_demo` Dockerfile installs it with `npm install -g @google/gemini-cli`.

**Claude Code CLI:**
- Role: Alternative agent under evaluation; executed inside Docker or local workspace
- Invocation: `claude "$(cat /tmp/.prompt.md)" --yes --no-auto-update` (run as shell command inside environment)
- Auth: `ANTHROPIC_API_KEY` env var (passed into execution environment)
- Implementation: `src/agents/claude.ts`

## LLM Grading APIs

The `LLMGrader` in `src/graders/index.ts` uses a fallback chain: Ollama (local) → Gemini API (cloud) → Anthropic API (cloud).

**Ollama (Local LLM):**
- Role: Primary LLM grader; no API key required; preferred for free local inference
- Endpoint: `OLLAMA_HOST` env var (default: `http://localhost:11434`)
- API calls:
  - `GET /` — health check (5s timeout)
  - `GET /api/tags` — model availability check (5s timeout)
  - `POST /api/generate` — inference request (120s timeout)
- Default model: `qwen2.5:3b` (configurable per task via `task.toml` `[[graders]]` `model` field)
- Request format: uses Ollama's JSON Schema `format` field for structured output
- Configured via: `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_NUM_THREAD`
- Implementation: `src/graders/index.ts` — `callOllama()`, `callOllamaWithRetry()`, `checkOllamaAvailability()`, `warmUp()`

**Google Gemini API (Cloud Fallback):**
- Role: First cloud fallback when Ollama is unavailable
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- Auth: `GEMINI_API_KEY` env var (from `.env` or process environment)
- Default model: `gemini-2.0-flash` (overridable via task config)
- Called via native `fetch` with JSON body; no SDK dependency
- Implementation: `src/graders/index.ts` — `callGemini()`

**Anthropic Claude API (Cloud Fallback):**
- Role: Second cloud fallback when Ollama and Gemini are both unavailable
- Endpoint: `https://api.anthropic.com/v1/messages`
- Auth: `ANTHROPIC_API_KEY` env var (from `.env` or process environment)
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`
- Default model: `claude-sonnet-4-20250514` (overridable via task config)
- Called via native `fetch` with JSON body; no SDK dependency
- Implementation: `src/graders/index.ts` — `callAnthropic()`

## Container Runtime

**Docker Engine:**
- Role: Provides isolated, reproducible execution environments for each eval trial
- Client library: `dockerode` ^4.0.9
- Connection: Default Docker socket (no explicit host/port; uses `new Docker()` with no args)
- Operations:
  - `docker.buildImage()` — builds image from `tasks/<name>/environment/Dockerfile`
  - `docker.createContainer()`, `container.start()` — spins up per-trial containers
  - `container.exec()` — runs agent commands inside containers
  - `container.commit()` — snapshots container with injected skills as a new image
  - `container.kill()`, `container.remove()` — per-trial cleanup
  - `docker.getImage().inspect()` — checks cache before rebuilding
- Image naming: content-hash-based (`skill-eval-<taskname>-<sha256[:8]>[-ready]`) for automatic cache invalidation
- Resource limits: `NanoCpus` and `Memory` from `task.toml` `[environment]` section
- Implementation: `src/providers/docker.ts`

## Data Storage

**Databases:**
- None — no database used

**File Storage:**
- Local filesystem only
- Results written as JSON to `results/` directory (configurable via CLI): `results/<taskname>_<ISO-timestamp>.json`
- Session logs contain full trial transcripts; secrets are redacted before write
- Analytics reads from the same `results/` directory

**Caching:**
- Docker image layer cache — built images are reused across runs using content-hash-based names
- No application-level caching

## Authentication & Identity

**Auth Provider:**
- None — no user authentication
- API keys are read from `.env` files or process environment variables at runtime and forwarded into execution environments

## Monitoring & Observability

**Error Tracking:**
- None — errors print to stderr and optionally write to `results/` JSON logs

**Logs:**
- Structured session logs: JSON files in `results/`, one per eval run
- Console output: `console.log`/`console.warn`/`console.error` only; no log aggregation service

## CI/CD & Deployment

**Hosting:**
- Local developer tool only — not deployed

**CI Pipeline:**
- None detected — no `.github/`, `.gitlab-ci.yml`, or similar CI config files present in the repository

## Environment Configuration

**Required env vars for eval:**
- `GEMINI_API_KEY` — required when using Gemini as the evaluated agent
- `ANTHROPIC_API_KEY` — required when using Claude as the evaluated agent

**Required env vars for LLM grading:**
- At least one of: Ollama running locally, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`
- `OLLAMA_HOST` — optional; defaults to `http://localhost:11434`

**Optional performance vars (Ollama only):**
- `OLLAMA_FLASH_ATTENTION=1`
- `OLLAMA_KV_CACHE_TYPE=q8_0`
- `OLLAMA_NUM_PARALLEL=1`
- `OLLAMA_NUM_THREAD=<cpu-count>`

**Secrets location:**
- Root `.env` at project root (not committed; not present by default)
- Task-level `.env` at `tasks/<name>/.env` (optional, task-specific)
- All env values are redacted from persisted session logs by `EvalRunner.sanitize()` in `src/evalRunner.ts`

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None — all external calls are outbound HTTP via native `fetch` to Ollama, Gemini, and Anthropic APIs

---

*Integration audit: 2026-03-10*
