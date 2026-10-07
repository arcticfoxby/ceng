import "dotenv/config";

export interface BotConfig {
  appId: string;
  appSecret: string;
  deepseek: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
}

export function loadConfig(): BotConfig {
  const appId = process.env.QQBOT_APP_ID?.trim();
  const appSecret = process.env.QQBOT_APP_SECRET?.trim();
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const missing = [
    !appId && "QQBOT_APP_ID",
    !appSecret && "QQBOT_APP_SECRET",
    !apiKey && "DEEPSEEK_API_KEY",
  ].filter((name): name is string => Boolean(name));

  if (!appId || !appSecret || !apiKey) {
    throw new Error(`缺少环境变量：${missing.join("、")}。请配置 .env 或运行环境。`);
  }

  return {
    appId,
    appSecret,
    deepseek: {
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
      model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    },
  };
}
