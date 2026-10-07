import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources, normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consult } from "../src/advisor.js";

test("Codex adapter warns about unenforced maxTokens and closes its actual cached socket", async (t) => {
  // Exercise Pi's real adapter, but never read credentials or allow network I/O.
  const model = Object.values(OPENAI_CODEX_MODELS)[0];
  const apiKey = `e30.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" },
    }),
  ).toString("base64url")}.fake`;
  const sockets: MockSocket[] = [];
  let payload: Record<string, unknown> | undefined;
  class MockSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(text: string) {
      payload = JSON.parse(text);
      const item = {
        type: "message",
        id: "msg_offline",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Insufficient context.", annotations: [] },
        ],
      };
      const events = [
        {
          type: "response.created",
          response: { id: "resp_offline", model: model.id },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          item_id: item.id,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: item.id,
          delta: "Insufficient context.",
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_offline",
            model: model.id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ];
      setImmediate(() => {
        for (const event of events)
          this.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(event) }),
          );
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Network forbidden in offline test");
  });
  const dir = await mkdtemp(join(await realpath(tmpdir()), "advisor-codex-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = join(dir, "logs");
  await writeFile(
    join(dir, "pi-advisor.json"),
    JSON.stringify({ logDirectory: logs, maxTokens: 1, timeoutMs: 1000 }),
  );
  let sessionId: string | undefined;
  t.after(() => {
    if (sessionId) cleanupSessionResources(sessionId);
  });
  const registryStream: ExtensionContext["modelRegistry"]["streamSimple"] =
    (_model, context, options) => {
      sessionId = options?.sessionId;
      return streamSimple(model, normalizeContext(context), { ...options, apiKey });
    };
  const ctx = {
    sessionManager: { getSessionId: () => "parent-session" },
    modelRegistry: { find: () => model, streamSimple: registryStream },
  } as unknown as Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
  const result = await consult(
    { question: "Can we decide?", purpose: "decision" },
    ctx,
    dir,
  );
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Insufficient context/);
  assert.ok(payload);
  assert.equal("max_output_tokens" in payload, false);
  assert.equal("max_tokens" in payload, false);
  assert.equal(result.usage?.output, 5);
  assert.ok(
    result.details.warnings.some((warning) =>
      warning.includes("not an output-token or cost cap"),
    ),
  );
  const record = JSON.parse(
    await readFile(join(logs, `${result.details.id}.completed.json`), "utf8"),
  );
  assert.equal(record.request.maxTokens, 1);
  assert.deepEqual(record.warnings, result.details.warnings);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(sessionId, result.details.id);
});
