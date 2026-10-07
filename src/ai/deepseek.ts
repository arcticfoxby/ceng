import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { BotConfig } from "../config.js";

const SYSTEM_MESSAGE =
  "你是 ceng，一个运行在 QQ 群中的聊天机器人。" +
  "请使用自然、简洁的中文回复用户。不要声称自己执行了实际上没有执行的操作。";
const ERROR_REPLY = "我这边暂时出了点问题，稍后再试。";
const REQUEST_TIMEOUT_MS = 30_000;

// DeepSeek 的扩展字段不在 OpenAI 的标准请求类型内；SDK 会原样发送额外字段。
type DeepSeekCompletionParams = ChatCompletionCreateParamsNonStreaming & {
  thinking: { type: "disabled" };
};

export function createDeepSeekClient(config: BotConfig["deepseek"]) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    logLevel: "off",
  });

  return async function generateReply(userMessage: string): Promise<string> {
    const startedAt = Date.now();
    const controller = new AbortController();
    // 总时限覆盖响应体读取，避免服务端提前发回响应头后无限等待正文。
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    console.log(`[AI] requesting DeepSeek model=${JSON.stringify(config.model)}`);

    try {
      const request: DeepSeekCompletionParams = {
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_MESSAGE },
          { role: "user", content: userMessage },
        ],
        thinking: { type: "disabled" },
        stream: false,
        max_tokens: 500,
      };
      const completion = await client.chat.completions.create(request, {
        signal: controller.signal,
      });
      const content = Array.isArray(completion?.choices)
        ? completion.choices[0]?.message?.content
        : undefined;
      if (typeof content !== "string" || !content.trim()) {
        const type = typeof content === "string" ? "empty_response" : "invalid_response";
        console.error(`[AI] DeepSeek request failed status=none type=${type}`);
        return ERROR_REPLY;
      }

      console.log(`[AI] DeepSeek response received elapsed=${Date.now() - startedAt}ms`);
      return content.trim();
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      let type = "unexpected";
      if (controller.signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
        type = "timeout";
      } else if (error instanceof OpenAI.APIConnectionError) {
        type = "network";
      } else if (status !== undefined) {
        if (status === 401) type = "authentication";
        else if (status === 402) type = "billing";
        else if (status === 429) type = "rate_limit";
        else if (status >= 500) type = "server";
        else type = "api_error";
      } else if (error instanceof SyntaxError) {
        type = "invalid_response";
      }
      console.error(`[AI] DeepSeek request failed status=${status ?? "none"} type=${type}`);
      return ERROR_REPLY;
    } finally {
      clearTimeout(timeout);
    }
  };
}
