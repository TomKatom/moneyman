import {
  OTP_RESEND,
  type OtpCodeRetrieverOptions,
} from "israeli-bank-scrapers";
import { Context, Telegraf, TelegramError } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import type { ImageWithCaption } from "../types.js";
import { createLogger, logToPublicLog } from "../utils/logger.js";
import { formatUnknownError } from "../utils/utils.js";
import { assignDeprecationHandler } from "./deprecationManager.js";

const logger = createLogger("notifier");

const telegramConfig = config.options.notifications?.telegram;
const bot = telegramConfig ? new Telegraf(telegramConfig.apiKey) : null;

type TextContext = Context & { message: { text: string; date: number } };

// Only one OTP prompt is answerable at a time.
let pendingOtpReply: ((ctx: TextContext) => void) | undefined;

logToPublicLog(
  bot
    ? "Telegram logger initialized, status and errors will be sent"
    : "No Telegram bot info, status and errors will not be sent",
  logger,
);

logger(`Telegram bot initialized: ${Boolean(bot)}`);
if (bot && telegramConfig) {
  logger(`Telegram chat ID: ${telegramConfig.chatId}`);

  if (telegramConfig.enableOtp) {
    // Registered once: a Telegraf handler cannot be removed, and a stale one
    // left by an earlier prompt would swallow every reply to the next.
    bot.on(message("text"), (ctx) => {
      if (ctx.chat.id.toString() === telegramConfig.chatId) {
        pendingOtpReply?.(ctx);
      }
    });
  }

  assignDeprecationHandler((messageId, message) => {
    if (!config.options.scraping.hiddenDeprecations?.includes(messageId)) {
      logger(`Sending deprecation message: ${messageId}`);
      void send(message);
    }
  });
}

export async function send(message: string, parseMode?: "HTML") {
  if (message.length > 4096) {
    await send(
      `Next message is too long (${message.length} characters), truncating`,
    );
    await send(message.slice(0, 4096));

    if (bot && telegramConfig?.chatId) {
      const buffer = Buffer.from(message, "utf-8");
      await bot.telegram.sendDocument(
        telegramConfig.chatId,
        {
          source: buffer,
          filename: `message-${new Date().toISOString().replaceAll(":", "-")}.txt`,
        },
        {
          caption: "Full message attached",
        },
      );
    }
    return;
  }
  logger(message);
  if (!bot || !telegramConfig?.chatId) {
    return;
  }
  return await bot.telegram.sendMessage(telegramConfig.chatId, message, {
    parse_mode: parseMode,
  });
}

export async function sendPhoto(photoPath: string, caption: string) {
  logger(`Sending photo`, { photoPath, caption });
  if (!bot || !telegramConfig?.chatId) {
    return;
  }
  return await bot.telegram.sendPhoto(
    telegramConfig.chatId,
    { source: photoPath },
    { caption, has_spoiler: true },
  );
}

export async function sendPhotos(photos: Array<ImageWithCaption>) {
  logger(`Sending photos`, { photos });
  if (photos.length === 0 || !bot || !telegramConfig?.chatId) {
    return;
  }
  return await bot.telegram.sendMediaGroup(
    telegramConfig.chatId,
    photos.map(({ photoPath, caption }) => ({
      type: "photo",
      caption,
      media: { source: photoPath },
    })),
  );
}

export async function sendJSON(json: {}, filename: string) {
  logger(`Sending JSON`, { json, filename });
  if (!bot || !telegramConfig?.chatId) {
    return;
  }
  const buffer = Buffer.from(JSON.stringify(json, null, 2), "utf-8");
  return await bot.telegram.sendDocument(telegramConfig.chatId, {
    source: buffer,
    filename,
  });
}

export async function sendTextFile(filePath: string, caption?: string) {
  logger(`Sending file`, { filePath, caption });
  if (!bot || !telegramConfig?.chatId) {
    return;
  }
  return await bot.telegram.sendDocument(
    telegramConfig.chatId,
    { source: filePath, filename: `${filePath}.txt` },
    caption ? { caption } : undefined,
  );
}

export async function editMessage(
  message: number | undefined,
  newText: string,
  parseMode?: "HTML",
) {
  if (message === undefined || !bot || !telegramConfig?.chatId) {
    return;
  }

  try {
    /**
     * Telegram has limit on the number of messages per second.
     * To avoid getting 429 errors, we wait a bit before sending the edit request.
     * According to the docs, the limit is 30 messages per second so we should be safe with 250ms.
     */
    await new Promise((resolve) => setTimeout(resolve, 250));
    await bot.telegram.editMessageText(
      telegramConfig.chatId,
      message,
      undefined,
      newText,
      {
        parse_mode: parseMode,
      },
    );
  } catch (e) {
    if (canIgnoreTelegramError(e)) {
      logger(`Ignoring error`, e);
    } else {
      throw e;
    }
  }
}

function canIgnoreTelegramError(e: unknown) {
  return (
    e instanceof TelegramError &&
    e.response.description.startsWith("Bad Request: message is not modified")
  );
}

export function sendError(message: unknown, caller: string = "") {
  return send(
    `${caller}\n❌ ${String(
      message instanceof Error
        ? `${message.message}\n${message.stack}`
        : formatUnknownError(message),
    )}`.trim(),
  );
}

const OTP_CODE_REPLY = /^\d{4,8}$/;
const OTP_RESEND_REPLY = /^(resend|r|שלח שוב)$/i;

/**
 * Maps a reply to the OTP prompt to a code, the resend sentinel, or undefined
 * when it is neither.
 */
export function parseOtpReply(text: string): string | undefined {
  const reply = text.trim();
  if (OTP_CODE_REPLY.test(reply)) {
    return reply;
  }
  if (OTP_RESEND_REPLY.test(reply)) {
    return OTP_RESEND;
  }
  return undefined;
}

/**
 * Request an OTP code from the user via Telegram and wait for their response.
 * Resolves with the code, or with OTP_RESEND when the user asks for a new one.
 */
export async function requestOtpCode(
  companyId: string,
  phoneNumber?: string,
  options?: OtpCodeRetrieverOptions,
): Promise<string> {
  if (!bot || !telegramConfig?.chatId || !telegramConfig.enableOtp) {
    throw new Error("Telegram OTP is not enabled or configured");
  }

  const requestMessage = await send(
    `🔐 2FA Authentication Required\n\n` +
      `Account: ${companyId}\n` +
      `${otpRequestContext(options)}` +
      `Please enter the OTP code sent to ${phoneNumber ?? "your phone"}:\n\n` +
      `Reply with the digits, or "resend" for a fresh code.`,
  );

  if (!requestMessage) {
    throw new Error("Failed to send OTP request message");
  }

  logger("Waiting for OTP code from user...");

  const timeoutSeconds = telegramConfig.otpTimeoutSeconds;
  let nudgeTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const responsePromise = new Promise<string>((resolve, reject) => {
    timeoutTimer = setTimeout(
      () =>
        reject(
          new Error(
            `OTP timeout: No response received within ${timeoutSeconds} seconds`,
          ),
        ),
      timeoutSeconds * 1000,
    );
    nudgeTimer = setTimeout(() => {
      send(
        `⏳ Still waiting for the ${companyId} OTP — ` +
          `${Math.ceil(timeoutSeconds / 120)} minutes left. ` +
          `Reply with the digits, or "resend" for a fresh code.`,
      ).catch((e) => logger("Failed to send OTP nudge", e));
    }, timeoutSeconds * 500);

    pendingOtpReply = (ctx) => {
      // Polling restarts for every prompt, and Telegram redelivers updates the
      // last poll did not confirm — including the "resend" behind this prompt.
      if (ctx.message.date < requestMessage.date) {
        return;
      }

      const reply = parseOtpReply(ctx.message.text);
      if (reply === undefined) {
        void ctx.reply(
          `Reply with the ${companyId} OTP digits, or "resend" for a fresh code.`,
        );
        return;
      }

      if (reply === OTP_RESEND) {
        logger("User asked for a new OTP code");
        void ctx.reply("📨 Asking the bank for a new code...");
      } else {
        logger("Received OTP code");
        void ctx.reply("✅ OTP code received. Continuing authentication...");
      }
      resolve(reply);
    };

    bot
      .launch(() => {
        logger("Bot launched for OTP collection");
      })
      .catch((error) => {
        if (!error.message.includes("already running")) {
          sendError(error, "requestOtpCode");
          reject(
            new Error(`Failed to start Telegram bot for OTP: ${error.message}`),
          );
        }
      });
  });

  try {
    return await responsePromise;
  } finally {
    clearTimeout(nudgeTimer);
    clearTimeout(timeoutTimer);
    pendingOtpReply = undefined;
    try {
      bot.stop();
    } catch (e) {
      logger("Failed to stop the Telegram bot", e);
    }
  }
}

function otpRequestContext(options?: OtpCodeRetrieverOptions): string {
  if (options?.resendFailed) {
    return `⚠️ Could not ask the bank for a new code — use the one you already have.\n`;
  }
  if (options?.resent) {
    return `📨 A new code was requested, wait for the SMS.\n`;
  }
  if (options && options.attempt > 1) {
    return `❌ The previous code was rejected (attempt ${options.attempt}).\n`;
  }
  return "";
}
