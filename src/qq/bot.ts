import {
  ApiError,
  QQBot,
  contentSanitizer,
  mentionGate,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
import { createDeepSeekClient } from "../ai/deepseek.js";
import type { BotConfig } from "../config.js";

const GROUP_AND_C2C_INTENT = 1 << 25;
const RECENT_MESSAGE_MS = 5 * 60 * 1000;
const MAX_RECENT_MESSAGES = 1000;

export function createBot(config: BotConfig): QQBot {
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    // 官方 GROUP_AND_C2C_EVENT；只订阅本版本所需的群/C2C 事件。
    intents: GROUP_AND_C2C_INTENT,
  });
  const generateReply = createDeepSeekClient(config.deepseek);
  bot.use(
    messageFilter({ dedup: { windowMs: RECENT_MESSAGE_MS, maxSize: MAX_RECENT_MESSAGES } }),
    // 先识别事件/mentions/正文中的 @，再清洗正文，保留已验证的群 @ 事件触发方式。
    mentionGate({ requireMentionInGroup: true }),
    contentSanitizer({ stripBotMention: true }),
  );

  bot.on("message", async (_ctx, msg) => {
    if (msg.kind !== "group" || msg.replyTarget.scope !== "group" || msg.senderIsBot) {
      return;
    }

    const userMessage = msg.content.trim();
    if (!userMessage) return;

    // sendText 在没有 msgId 时会变成主动消息；本版本只允许被动回复。
    if (!msg.replyTarget.msgId) {
      console.error("[QQ] 跳过回复：入站群消息缺少 replyTarget.msgId。");
      return;
    }

    console.log(
      `[QQ] group message received sender=${JSON.stringify(msg.senderId)} ` +
        `messageId=${JSON.stringify(msg.messageId)}`,
    );

    try {
      const reply = await generateReply(userMessage);
      await bot.sendText(msg.replyTarget, reply);
      console.log("[QQ] reply sent");
    } catch (error) {
      const detail =
        error instanceof ApiError
          ? `HTTP ${error.httpStatus}${error.bizCode === undefined ? "" : `，QQ code=${error.bizCode}`}`
          : "网络或 SDK 错误";
      console.error(`[QQ] 群消息回复失败：${detail}；messageId=${JSON.stringify(msg.messageId)}`);
    }
  });

  return bot;
}
