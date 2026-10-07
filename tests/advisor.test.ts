import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  lstat,
  symlink,
  utimes,
  realpath,
  open,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import register from "../index.js";
import { accounting, consult, SYSTEM } from "../src/advisor.js";
import { loadConfig } from "../src/config.js";
import { redact, retain, writeLog } from "../src/logs.js";
import { randomUUID } from "node:crypto";
const usage: Usage = {
  input: 10,
  output: 20,
  reasoning: 5,
  cacheRead: 3,
  cacheWrite: 2,
  cacheWrite1h: 1,
  totalTokens: 35,
  cost: {
    input: 0.01,
    output: 0.02,
    cacheRead: 0.003,
    cacheWrite: 0.002,
    total: 0.035,
  },
};
async function fixture(options: object = {}, mode = "ok") {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "pi-advisor-test-"));
  const logs = join(dir, "logs");
  await writeFile(
    join(dir, "pi-advisor.json"),
    JSON.stringify({ logDirectory: logs, ...options }),
  );
  const calls: any[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => "isolated-test" },
    modelRegistry: {
      find: (provider: string, id: string) =>
        id === "missing"
          ? undefined
          : { provider, id, api: "openai-responses" },
      streamSimple: (model: unknown, context: unknown, opts: unknown) => {
        calls.push({ model, context, opts });
        return {
          result: () =>
            mode === "hang"
              ? new Promise(() => {})
              : mode === "throw"
                ? Promise.reject(new Error("Bearer secret-provider-error"))
                : Promise.resolve({
                    role: "assistant",
                    provider: "test",
                    model: "answer",
                    content: [
                      { type: "thinking", thinking: "HIDDEN" },
                      { type: "text", text: "Recommendation: simplify" },
                    ],
                    stopReason:
                      mode === "length"
                        ? "length"
                        : mode === "error"
                          ? "error"
                          : "stop",
                    errorMessage:
                      mode === "error"
                        ? "Bearer secret-provider-error"
                        : undefined,
                    responseModel: "actual-response-model",
                    providerThinkingLevel: "high",
                    usage: mode === "no-usage" ? undefined : usage,
                  } as AssistantMessage),
        };
      },
    },
  } as unknown as Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
  return { dir, logs, ctx, calls };
}
const input = {
  question: "What should be removed?",
  purpose: "critique" as const,
  context: "Evidence only",
};
test("registers one explicit tool without calling a model", () => {
  const tools: any[] = [];
  register({
    registerTool: (tool: unknown) => tools.push(tool),
  } as unknown as ExtensionAPI);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "advisor");
  assert.deepEqual(tools[0].parameters.required, ["question", "purpose"]);
});
test("config defaults and strict invalid config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-config-"));
  assert.equal((await loadConfig(dir)).maxTokens, 4096);
  for (const config of [
    { timeoutMs: 0 },
    { model: "unqualified" },
    { extra: true },
    [],
  ]) {
    await writeFile(join(dir, "pi-advisor.json"), JSON.stringify(config));
    await assert.rejects(loadConfig(dir));
  }
});
test("one call, explicit prompt, override isolation, usage and private logs", async () => {
  const f = await fixture();
  const a = await consult(
    {
      ...input,
      context: "Bearer secret-for-log-test",
      model: "test/override/with-slash",
    },
    f.ctx,
    f.dir,
  );
  const b = await consult(input, f.ctx, f.dir);
  assert.equal(a.isError, false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].model.id, "override/with-slash");
  assert.equal(f.calls[1].model.id, "gpt-6.1-sol");
  assert.notEqual(f.calls[0].opts.sessionId, f.calls[1].opts.sessionId);
  assert.equal(f.calls[0].opts.maxRetries, 0);
  assert.equal(f.calls[0].context.messages.length, 2);
  assert.equal(f.calls[0].context.messages[0].content, SYSTEM);
  assert.equal(a.usage, usage);
  assert.equal((a.details.accounting as any).tokens.reasoning, 5);
  assert.equal((await lstat(f.logs)).mode & 0o777, 0o700);
  const files = await readdir(f.logs);
  assert.equal(files.length, 2);
  for (const file of files) {
    const path = join(f.logs, file);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes("HIDDEN"));
    assert.ok(!text.includes("secret-for-log-test"));
    assert.equal(JSON.parse(text).request.system, SYSTEM);
  }
  assert.equal(b.isError, false);
});
test("invalid input/model/size never falls back or makes calls", async () => {
  const f = await fixture({ maxInputChars: 1000 });
  for (const params of [
    { ...input, model: "test/missing" },
    { ...input, model: "bad" },
    { ...input, question: "" },
    { ...input, context: "x".repeat(2000) },
  ]) {
    assert.equal((await consult(params, f.ctx, f.dir)).isError, true);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await readdir(f.logs)).length, 4);
});
test("timeout bounds caller even if provider ignores abort", async () => {
  const f = await fixture({ timeoutMs: 10 }, "hang");
  const result = await consult(input, f.ctx, f.dir);
  assert.equal(result.details.status, "timeout");
  assert.equal(f.calls[0].opts.signal.aborted, true);
  assert.equal((result.details.accounting as any).complete, false);
});
test("pre-cancel prevents call; in-flight cancel propagates", async () => {
  const f = await fixture({}, "hang");
  const pre = new AbortController();
  pre.abort();
  assert.equal(
    (await consult(input, f.ctx, f.dir, pre.signal)).details.status,
    "cancelled",
  );
  assert.equal(f.calls.length, 0);
  const active = new AbortController();
  const timer = setTimeout(() => active.abort(), 20);
  const result = await consult(input, f.ctx, f.dir, active.signal);
  clearTimeout(timer);
  assert.equal(result.details.status, "cancelled");
});
test("provider failures omit raw error; incomplete answer preserves usage", async () => {
  const f = await fixture({}, "throw");
  const result = await consult(input, f.ctx, f.dir);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("secret-provider-error"));
  const short = await fixture({}, "length");
  const partial = await consult(input, short.ctx, short.dir);
  assert.equal(partial.isError, true);
  assert.equal(partial.usage, usage);
});
test("unknown costs are null, optional token subsets preserved", () => {
  assert.equal(accounting(undefined, false).estimatedUsd, null);
  assert.equal(
    accounting(
      {
        ...usage,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      true,
    ).estimatedUsd,
    null,
  );
  assert.deepEqual(accounting(usage, true).estimatedUsd, usage.cost);
});
test("redacts env credentials and patterns", () => {
  const text = redact(
    "testsecret123 Bearer abcdef sk-123456789 ghp_123456789",
    { TEST_API_KEY: "testsecret123" },
  );
  assert.ok(!text.includes("testsecret123"));
  assert.ok(!text.includes("123456789"));
  assert.ok(!text.includes("abcdef"));
});
test("concurrent logs, retention leaves unrelated/pending/symlinks", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 3 }, () => consult(input, f.ctx, f.dir)),
  );
  const old = join(f.logs, (await readdir(f.logs))[0]);
  await utimes(old, new Date(0), new Date(0));
  const pending = join(f.logs, `${randomUUID()}.pending.json`);
  await writeFile(pending, "{}");
  const unrelated = join(f.logs, "notes.txt");
  await writeFile(unrelated, "keep");
  const link = join(f.logs, `${randomUUID()}.completed.json`);
  await symlink(unrelated, link);
  await retain(f.logs);
  await assert.rejects(readFile(old));
  assert.equal(await readFile(unrelated, "utf8"), "keep");
  assert.equal(await readFile(pending, "utf8"), "{}");
  assert.ok((await lstat(link)).isSymbolicLink());
});
test("unsafe log path warns but answer survives", async () => {
  const f = await fixture();
  const target = join(f.dir, "target");
  await mkdir(target);
  await symlink(target, f.logs);
  const result = await consult(input, f.ctx, f.dir);
  assert.equal(result.isError, false);
  assert.ok(result.details.warnings.length > 0);
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(writeLog(f.logs, randomUUID(), {}, false));
});
test("error responses retain safe metadata and usage; absent usage stays unknown", async () => {
  const f = await fixture({}, "error");
  const result = await consult(input, f.ctx, f.dir);
  assert.equal(result.isError, true);
  assert.equal(result.usage, usage);
  const record = JSON.parse(
    await readFile(join(f.logs, (await readdir(f.logs))[0]), "utf8"),
  );
  assert.equal(record.reportedModel.responseModel, "actual-response-model");
  assert.equal(record.reportedModel.providerThinkingLevel, "high");
  assert.equal(record.accounting.complete, false);
  assert.ok(!JSON.stringify(record).includes("secret-provider-error"));
  const missing = await fixture({}, "no-usage");
  const answer = await consult(input, missing.ctx, missing.dir);
  assert.equal(answer.isError, false);
  assert.equal(answer.usage, undefined);
  assert.equal((answer.details.accounting as any).tokens, null);
});
test("invalid config is logged in isolated default state with zero requests", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "pi-advisor.json"), "{malformed");
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = f.dir;
  try {
    const result = await consult(input, f.ctx, f.dir);
    assert.equal(result.isError, true);
    assert.equal(f.calls.length, 0);
    const directory = join(f.dir, "pi-advisor", "consultations");
    const record = JSON.parse(
      await readFile(join(directory, (await readdir(directory))[0]), "utf8"),
    );
    assert.equal(record.modelCalls, 0);
    assert.equal(record.error, "Invalid pi-advisor.json");
  } finally {
    if (original === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original;
  }
});
test("byte retention removes an oversized completed record", async () => {
  const f = await fixture();
  await mkdir(f.logs, { mode: 0o700 });
  const path = join(f.logs, `${randomUUID()}.completed.json`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.truncate(101 * 1024 * 1024);
  } finally {
    await file.close();
  }
  await retain(f.logs);
  await assert.rejects(lstat(path));
});
test("existing unsafe directory and pending symlink cannot be overwritten", async () => {
  const f = await fixture();
  await mkdir(f.logs, { mode: 0o700 });
  await chmod(f.logs, 0o755);
  await assert.rejects(writeLog(f.logs, randomUUID(), {}, false));
  await chmod(f.logs, 0o700);
  const id = randomUUID();
  const target = join(f.dir, "private-target");
  await writeFile(target, "untouched");
  await symlink(target, join(f.logs, `${id}.pending.json`));
  await assert.rejects(writeLog(f.logs, id, {}, false));
  assert.equal(await readFile(target, "utf8"), "untouched");
});
