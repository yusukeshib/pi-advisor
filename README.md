# @yusukeshib/pi-advisor

[日本語：動作・設定・ログ・費用の説明](docs/design.ja.md)

A small, explicit second-opinion tool for Pi 1.0.4. It makes **one model request per consultation**, with no tools, automatic history collection, retries, or execution of its advice. Private local JSON records let you inspect what was asked, what came back, and Pi's estimated cost.

This is a fresh standalone extension. It does not read the old `advisor.json`, change the current model, or modify Pi settings. Do not load it alongside another extension registering `advisor`.

## Try it (only when ready to make paid requests)

From this checkout:

```sh
npm ci --ignore-scripts
pi --no-extensions --extension ./index.ts
```

That invocation disables other configured/discovered extensions for this session (including the old advisor) and loads only this extension, without installing it into settings. Loading alone makes no advisor model request. The tool may subsequently be called by your agent. Configure/authenticate the desired provider through Pi's normal mechanisms; this extension never reads `auth.json` itself. A future published package can be installed with `pi install npm:@yusukeshib/pi-advisor`; this checkout has not been published.

The model calls the tool with explicit arguments, for example:

```json
{
  "question": "Is the retry layer necessary, or should we remove it?",
  "purpose": "decision",
  "context": "The existing SDK retries twice. The proposed layer retries three more times. Requirement: fail within 30 seconds.",
  "model": "openai-codex/gpt-6.1-sol"
}
```

`question` and `purpose` are required. Purpose is `decision` (compare supplied alternatives/tradeoffs and recommend), `diagnosis` (rank evidence-backed causes and suggest a discriminating check), or `critique` (challenge a proposal with concrete failure modes and simplifications). These are brief prompt directions, not separate frameworks. `context` is optional explicit evidence/constraints. `model` is an optional **provider-qualified** override for that call only (model IDs may contain slashes). Missing models and invalid inputs fail rather than silently using a different model. Use only for concrete unresolved questions, not routine checkpoints. A recommendation is a hypothesis, never approval or proof.

## Exact flow

1. Register one `advisor` tool. There are no event listeners, commands, timers, configuration writes, or network calls at registration.
2. On an explicit call, assign a UUID and capture the current Pi session ID (not its contents). Read `getAgentDir()/pi-advisor.json` anew. A missing file uses defaults; malformed/unknown settings fail.
3. Validate question/purpose/context/model and the **combined system + user text** character limit. Resolve the exact model using the host registry. No files, repository, conversation, research services, or tools are supplied to the advisor.
4. Assemble the fixed prompt in `src/advisor.ts` (`SYSTEM`, prompt version 1). It asks for Recommendation, Evidence/reasoning (brief explanation, not hidden thinking), Strongest objection/uncertainty, Smallest next step, and Stop condition. The user text is exactly `Purpose: …`, `Question: …`, and `Explicit context/evidence/constraints: …`. The log records both assembled texts after redaction. The request has these two messages only; no tool definitions.
5. Write a private pending record best-effort. Send one `modelRegistry.streamSimple(...).result()` request using Pi's request-time authentication and a unique provider `sessionId` equal to the consultation UUID. Request `maxRetries: 0`, a timeout, token limit, and reasoning level. The host/provider may perform authentication refresh or its own transport activity; this is not a guarantee of exactly one HTTP packet. The extension has no retry loop or fallback. Each call gets a fresh two-message context and provider session ID, with normal Pi authentication; there is no sandbox or separate process isolation.
6. Race the response against timeout and caller cancellation; abort the provider signal and remove timer/listener afterward. The caller stops waiting even if a provider ignores cancellation. Such a provider may still finish and incur charges; its late usage is **not** collected. Local filesystem operations are not separately timed out.
7. Extract only text blocks, at most 100,000 characters. Hidden thinking, thinking signatures, tool calls, diagnostics, transport payloads, response IDs, headers, and raw provider errors are not returned or logged. No model-requested tools are executed. Only a nonempty answer with finish reason `stop` succeeds; all other responses are marked incomplete/error while preserving available text and usage.
8. Finalize a local JSON record and perform best-effort retention. Return the answer, consultation ID, resolved model, status, accounting, log location, and warnings. Nested usage is also returned through Pi's existing `usage` field for session totals. Logging failure must not lose the answer.

The evidence is sent to your chosen model provider **without logging redaction**. Do not supply secrets. There is no telemetry implemented by this package, but Pi and the provider have their own behavior and policies.

## Configuration

Create the separate `pi-advisor.json` in Pi's agent directory (normally `~/.pi/agent/`; respects Pi's agent-directory setting):

```json
{
  "model": "openai-codex/gpt-6.1-sol",
  "reasoning": "high",
  "maxTokens": 4096,
  "timeoutMs": 120000,
  "maxInputChars": 48000,
  "logDirectory": "/absolute/private/path/consultations"
}
```

All fields are optional. Those are the defaults except `logDirectory`, which defaults to `$XDG_STATE_HOME/pi-advisor/consultations` or `~/.local/state/pi-advisor/consultations`. Allowed reasoning: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `off` omits the reasoning option (provider behavior can vary). Pi/provider may clamp unsupported levels; logs include reported provider thinking level when supplied. Limits: integer `maxTokens` 1–32768, `timeoutMs` 1–300000, `maxInputChars` 1000–100000. Log path must be absolute. Unknown keys fail. There is no settings UI or logging-disable switch in v0.1.

## Reading the logs

Each consultation has `<UUID>.pending.json`, replaced by `<UUID>.completed.json` after completion (including failures). Finalization uses an exclusive `<UUID>.finalizing.json` temporary file and rename. Files are 0600, new directories 0700. Existing final log directories must already be private; symlinks anywhere in the configured directory path are rejected. This can reject familiar symlinked paths such as macOS `/var`; use their canonical paths. Logs should live outside the repo in a dedicated directory.

Records include schema/package/prompt versions, consultation and Pi session IDs, start/end/duration, status, explicit question/purpose/context, exact assembled request, default/override/selected/resolved and provider-reported model identifiers, requested limits/reasoning/retry setting, text answer, finish reason, sanitized static error, warning list, and accounting. Validation failures are zero-call records where possible; invalid/oversized input is intentionally not retained. Pending records have `modelCalls: 0` because they are written before dispatch; finalized records show whether dispatch occurred. The counter is dispatch attempts, not proof of provider receipt.

Accounting retains input, output, cache-read, cache-write, total tokens, plus optional reasoning and one-hour cache-write breakdowns. **Reasoning is a subset of output; one-hour cache-write is a subset of cache-write. Do not add these twice.** Costs retain Pi's input/output/cache-read/cache-write/total USD components when nonzero and valid. These are **Pi-reported/catalog estimates, not actual invoices**. `actualBilledUsd` is always `null`. Missing or all-zero prices are `null`/unknown rather than invented free usage (including subscriptions and potentially genuinely free models). Pi's session usage still uses its native numbers, which may display zero while the log reports unknown. An incomplete/failed/cancelled call has `complete: false`; absence of usage does not mean no charge.

Redaction operates on string values in the local record: it replaces known environment values of length at least eight whose variable names contain key/token/secret/password/credential, common Bearer values, and `sk-`, `ghp_`, `github_pat_` token patterns. The record says whether anything was replaced. **It is best effort, not a security boundary**: it does not read stored auth, recognize every credential, redact arbitrary personal/proprietary information, change the network request, or redact the tool answer in your Pi transcript. Treat the entire log and Pi session as sensitive. Raw provider errors are omitted altogether rather than guessed safe.

Retention is fixed at 30 days and 100 MiB, pruning oldest completed regular UUID records after finalization. Unrelated names, symlinks, pending and finalizing records are left untouched. Cleanup is not scheduled while idle. Crashes may leave pending/finalizing records indefinitely; inspect and remove stale files manually when no consultation is active. Concurrent processes can briefly exceed the quota or race cleanup; warnings report failures. This is not a strict quota or a hardened multi-user storage service: directory component checks cannot eliminate malicious concurrent path replacement. Use a private, trusted local filesystem, not an attacker-writable/shared directory. No outcome/feedback is collected automatically; review a record alongside your later decision manually.

## Understand and validate the code

- `index.ts`: schema and registration only.
- `src/config.ts`: defaults, config read, validation.
- `src/advisor.ts`: prompt, one request, cancellation, accounting and result.
- `src/logs.ts`: private writes, redaction, retention.
- `tests/advisor.test.ts`: offline mocks; no real provider/auth/session configuration.

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

The package check runs TypeScript and 15 offline tests, typically under a minute, **zero real model calls / $0 API spend**. It covers registration, strict config, override isolation, explicit prompts, token/cost handling, incomplete/provider failures, cancel/timeout including ignored aborts, private logs, redaction, concurrency, retention and unsafe-path warnings. Tests use temporary isolated configuration and a mock registry; they do not install the extension or alter your active Pi settings. Dependencies supplied by Pi are peers plus pinned dev dependencies, never runtime dependencies. The npm allowlist excludes tests, logs, credentials and node_modules.

Offline checks establish mechanics only—not advice quality, authentication with every provider, live billing, or an actual installed Pi loader session. No live evaluation is authorized or performed by these commands. Before live testing, explicitly budget cases, model requests, latency and cost/unknown billing. To roll back, stop loading this package; no active configuration was changed by implementation.
