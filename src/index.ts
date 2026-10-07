import { ApiError } from "@tencent-connect/qqbot-nodejs";
import { loadConfig } from "./config.js";
import { createBot } from "./qq/bot.js";

const STARTUP_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "配置读取失败。");
    process.exitCode = 1;
    return;
  }

  let bot: ReturnType<typeof createBot>;
  try {
    bot = createBot(config);
  } catch {
    console.error("[QQ] SDK 初始化失败。请检查依赖安装和运行环境。");
    process.exitCode = 1;
    return;
  }
  let ready = false;
  let stopping = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: (() => void) | undefined;
  const startupTimeout = new Error("30 秒内未收到 QQ Gateway READY，连接未就绪");
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    startupTimer = setTimeout(() => reject(startupTimeout), STARTUP_TIMEOUT_MS);
  });

  bot.on("ready", () => {
    if (!ready) {
      ready = true;
      clearTimeout(startupTimer);
      resolveReady?.();
    }
    console.log("[QQ] Gateway 已连接，机器人就绪。");
    if (stopping) bot.stop();
  });
  bot.on("resumed", () => console.log("[QQ] Gateway 会话已恢复。"));
  bot.on("error", (error) => {
    const detail = error instanceof ApiError ? `HTTP ${error.httpStatus}` : "网络或协议错误";
    console.error(`[QQ] Gateway 异常：${detail}。`);
  });

  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    console.log("[QQ] 正在停止机器人。");
    // SDK 在首次取 token 期间尚未建立 Gateway；就绪后再调用 stop()。
    if (ready) bot.stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const running = bot.start();
    await Promise.race([
      readyPromise,
      running.then(() => {
        if (!stopping) throw new Error("QQ Gateway 在就绪前已停止");
      }),
    ]);
    if (!stopping) await running;
  } catch (error) {
    if (!stopping) {
      const detail =
        error === startupTimeout
          ? startupTimeout.message
          : error instanceof ApiError
            ? `QQ API 返回 HTTP ${error.httpStatus}`
            : "凭证、网络或 SDK 初始化错误";
      console.error(`[QQ] 启动失败：${detail}。请检查 AppID、AppSecret、网络和开放平台权限。`);
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(startupTimer);
    bot.stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

void main().catch(() => {
  console.error("[QQ] 发生未预期的运行错误，机器人已退出。");
  process.exitCode = 1;
});
