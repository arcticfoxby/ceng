import assert from "node:assert/strict";
import test from "node:test";
import { QQBot, runMiddlewareChain } from "@tencent-connect/qqbot-nodejs";
import { createDeepSeekClient } from "../dist/ai/deepseek.js";
import { createBot } from "../dist/qq/bot.js";

const ERROR_REPLY = "我这边暂时出了点问题，稍后再试。";
// Both SDK constructors reject empty strings. Spaces are inert blank test inputs,
// never real or fabricated API keys; fetch is intercepted before construction.
const aiConfig = { apiKey: " ", baseURL: "https://offline.invalid/v1", model: "deepseek-flash" };
const botConfig = { appId: "42", appSecret: " ", deepseek: aiConfig };

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content, reasoning = "internal reasoning must stay out of the reply") {
  return { choices: [{ message: { role: "assistant", content, reasoning_content: reasoning } }] };
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function captureLogs(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  const record = (...args) => lines.push(args.map(String).join(" "));
  console.log = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n");
}

let nextMessageId = 0;
function groupMessage(overrides = {}) {
  const messageId = overrides.messageId ?? `message-${++nextMessageId}`;
  return {
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    kind: "group",
    senderId: "member-1",
    content: "你好",
    messageId,
    timestamp: "2026-10-07T00:00:00Z",
    groupOpenid: "group-1",
    replyTarget: { scope: "group", targetId: "group-1", msgId: messageId },
    raw: {},
    ...overrides,
  };
}

async function withBot(fetchImpl, run) {
  const originalOn = QQBot.prototype.on;
  const originalSendText = QQBot.prototype.sendText;
  let messageHandler;
  const sent = [];
  QQBot.prototype.on = function (event, handler) {
    if (event === "message") messageHandler = handler;
    return originalOn.call(this, event, handler);
  };
  QQBot.prototype.sendText = async function (target, content) {
    sent.push({ target, content });
    return { id: `reply-${sent.length}`, timestamp: "" };
  };

  try {
    await withFetch(fetchImpl, async () => {
      const bot = createBot(botConfig);
      assert.equal(typeof messageHandler, "function");
      const dispatch = async (message) => {
        let stopped = false;
        let stopReason;
        const controller = new AbortController();
        const ctx = {
          bot,
          message,
          replyTarget: message.replyTarget,
          state: {},
          log: { info() {}, error() {}, warn() {}, debug() {} },
          stop(reason) { stopped = true; stopReason = reason; },
          get stopped() { return stopped; },
          get stopReason() { return stopReason; },
          get signal() { return controller.signal; },
          abort(reason) { controller.abort(reason); stopped = true; stopReason = reason; },
          get aborted() { return controller.signal.aborted; },
          receivedAt: Date.now(),
        };
        await runMiddlewareChain(
          [...bot.getMiddlewares(), async (current) => messageHandler(current, current.message)],
          ctx,
        );
        return ctx;
      };
      await run({ bot, dispatch, sent });
    });
  } finally {
    QQBot.prototype.on = originalOn;
    QQBot.prototype.sendText = originalSendText;
  }
}

test("V1.0.1 offline behavior", { concurrency: false }, async (t) => {
  await t.test("DeepSeek request sends only a final, non-streaming answer", async () => {
    let body;
    let requestURL;
    const logs = await captureLogs(async () => {
      await withFetch(async (input, init) => {
        requestURL = input instanceof Request ? input.url : String(input);
        body = JSON.parse(init.body);
        return response(completion(" 最终回复 "));
      }, async () => {
        const generateReply = createDeepSeekClient(aiConfig);
        assert.equal(await generateReply("用户问题"), "最终回复");
      });
    });
    assert.equal(requestURL, "https://offline.invalid/v1/chat/completions");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.stream, false);
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.max_tokens, 500);
    assert.deepEqual(body.messages.map(({ role }) => role), ["system", "user"]);
    assert.equal(body.messages[1].content, "用户问题");
    assert.equal(JSON.stringify(body).includes("reasoning_content"), false);
    for (const privateText of ["用户问题", "最终回复", "internal reasoning must stay out of the reply"]) {
      assert.equal(logs.includes(privateText), false);
    }
  });

  await t.test("HTTP failures, malformed data and transport errors do not retry", async () => {
    const logs = await captureLogs(async () => {
      for (const status of [401, 402, 429, 500, 503]) {
        let calls = 0;
        await withFetch(async () => {
          calls++;
          return response({ error: { message: "ERROR_BODY_SENTINEL" } }, status);
        }, async () => {
          assert.equal(await createDeepSeekClient(aiConfig)("问题"), ERROR_REPLY);
        });
        assert.equal(calls, 1, `status ${status} retried`);
      }
      for (const body of ["{", { choices: {} }, { choices: [] }, completion("  ")]) {
        let calls = 0;
        await withFetch(async () => { calls++; return response(body); }, async () => {
          assert.equal(await createDeepSeekClient(aiConfig)("问题"), ERROR_REPLY);
        });
        assert.equal(calls, 1);
      }
      let calls = 0;
      await withFetch(async () => { calls++; throw new TypeError("offline transport error"); }, async () => {
        assert.equal(await createDeepSeekClient(aiConfig)("问题"), ERROR_REPLY);
      });
      assert.equal(calls, 1);
    });
    assert.equal(logs.includes("ERROR_BODY_SENTINEL"), false);
  });

  await t.test("30-second total deadline covers response-body reading and clears its timer", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduled = [];
    const cleared = [];
    let bodyRead = false;
    let signalAborted = false;
    globalThis.setTimeout = (callback, ms, ...args) => {
      const handle = originalSetTimeout(callback, ms === 30_000 ? 20 : ms, ...args);
      if (ms === 30_000) scheduled.push(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      if (scheduled.includes(handle)) cleared.push(handle);
      return originalClearTimeout(handle);
    };
    try {
      await withFetch(async (_input, init) => {
        let streamController;
        const body = new ReadableStream({
          start(controller) { streamController = controller; },
          pull() { bodyRead = true; },
        });
        init.signal.addEventListener("abort", () => {
          signalAborted = true;
          streamController.error(new Error("body read aborted"));
        }, { once: true });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }, async () => {
        assert.equal(await createDeepSeekClient(aiConfig)("问题"), ERROR_REPLY);
      });
      assert.equal(bodyRead, true);
      assert.equal(signalAborted, true);
      assert.ok(scheduled.length >= 1);
      assert.ok(cleared.includes(scheduled[0]), "total deadline timer was not cleared");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  await t.test("group @ detection precedes sanitization; other messages are ignored", async () => {
    const requests = [];
    await withBot(async (_input, init) => {
      requests.push(JSON.parse(init.body));
      return response(completion(`回复-${requests.length}`));
    }, async ({ bot, dispatch, sent }) => {
      assert.equal(bot.getMiddlewares().length, 3);
      const authoritative = groupMessage({ content: "  已去掉@的提问  " });
      await dispatch(authoritative);
      await dispatch(groupMessage({ rawEventType: "GROUP_MESSAGE_CREATE", content: " 结构化@ ", mentions: [{ is_you: true }] }));
      await dispatch(groupMessage({ rawEventType: "GROUP_MESSAGE_CREATE", content: "<@!42>  文本@  ", mentions: [] }));
      assert.deepEqual(requests.map((request) => request.messages[1].content), ["已去掉@的提问", "结构化@", "文本@"]);
      assert.deepEqual(sent[0].target, authoritative.replyTarget);
      assert.deepEqual(sent.map(({ content }) => content), ["回复-1", "回复-2", "回复-3"]);

      await dispatch(groupMessage({ rawEventType: "GROUP_MESSAGE_CREATE", content: "无@", mentions: [] }));
      await dispatch(groupMessage({ content: "<@!42>   " }));
      await dispatch(groupMessage({ content: " \n " }));
      await dispatch(groupMessage({ kind: "c2c", replyTarget: { scope: "c2c", targetId: "member-1", msgId: "c2c-1" } }));
      await dispatch(groupMessage({ senderIsBot: true }));
      await dispatch(groupMessage({ replyTarget: { scope: "group", targetId: "group-1" } }));
      assert.equal(requests.length, 3);
      assert.equal(sent.length, 3);
    });
  });

  await t.test("concurrent duplicate group event produces one AI request and reply", async () => {
    let calls = 0;
    await withBot(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return response(completion("唯一回复"));
    }, async ({ dispatch, sent }) => {
      const first = groupMessage({ messageId: "duplicate-1" });
      await Promise.all([dispatch(first), dispatch(groupMessage({ messageId: "duplicate-1" }))]);
      assert.equal(calls, 1);
      assert.deepEqual(sent.map(({ content }) => content), ["唯一回复"]);
    });
  });

  await t.test("AI failure sends one friendly reply and next event still succeeds", async () => {
    let calls = 0;
    await withBot(async () => {
      calls++;
      return calls === 1
        ? response({ error: { message: "offline error" } }, 503)
        : response(completion("恢复成功"));
    }, async ({ dispatch, sent }) => {
      await dispatch(groupMessage());
      await dispatch(groupMessage());
      assert.equal(calls, 2);
      assert.deepEqual(sent.map(({ content }) => content), [ERROR_REPLY, "恢复成功"]);
    });
  });
});
