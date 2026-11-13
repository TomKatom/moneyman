import {
  OTP_RESEND,
  type OtpCodeRetrieverOptions,
} from "israeli-bank-scrapers";
import { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { aborted } from "node:util";
import type { OtpRequest } from "../scraper/otp.js";

const logger = createLogger("otp");

const OTP_CODE_REPLY = /^\d{4,8}$/;
const OTP_RESEND_REPLY = /^(resend|r|שלח שוב)$/i;

/**
 * Maps a reply to the OTP prompt to a code, the resend sentinel, or undefined
 * when it is neither.
 */
export function parseOtpReply(text: string): string | undefined {
  const reply = text.trim();
  if (OTP_CODE_REPLY.test(reply)) return reply;
  if (OTP_RESEND_REPLY.test(reply)) return OTP_RESEND;
  return undefined;
}

/** Answers a reply with the acknowledgement to send, or undefined to ignore it */
type OtpReceiver = (text: string, sentAt: number) => string | undefined;

export function createOtpHandler(bot: Telegraf<Context> | null) {
  const telegramConfig = config.options.notifications?.telegram;
  const pending = new Map<number, OtpReceiver>();
  const registering = new Set<Promise<number | undefined>>();

  bot?.on(message("text"), async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return next();

    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    let receive =
      replyToMessageId === undefined
        ? pending.size + registering.size === 1
          ? pending.values().next().value
          : undefined
        : pending.get(replyToMessageId);
    if (!receive && registering.size > 0) {
      if (replyToMessageId === undefined) {
        if (pending.size + registering.size !== 1) return next();
        const messageId = await registering.values().next().value!;
        receive = messageId === undefined ? undefined : pending.get(messageId);
      } else {
        // Only in-flight prompts can own an early reply; unrelated sends must not delay a match.
        const messageId = await Promise.any(
          Array.from(registering, async (registration) => {
            const messageId = await registration;
            if (messageId !== replyToMessageId)
              throw new Error("Unmatched OTP prompt");
            return messageId;
          }),
        ).catch((error: unknown) => {
          if (error instanceof AggregateError) return undefined;
          throw error;
        });
        receive = messageId === undefined ? undefined : pending.get(messageId);
      }
    }
    if (!receive) return next();

    const acknowledgement = receive(text, ctx.message.date);
    if (acknowledgement === undefined) return next();
    // Only the prompt itself may fail the login, not a failed reply to the user.
    void ctx
      .reply(acknowledgement)
      .catch((error: unknown) =>
        logger("Failed to acknowledge an OTP reply", error),
      );
  });

  const requestOtpCode: OtpRequest = async (
    companyId,
    phoneNumber,
    signal,
    options,
  ) => {
    signal?.throwIfAborted();
    if (!bot || !telegramConfig?.chatId || !telegramConfig.enableOtp) {
      throw new Error("Telegram OTP is not enabled or configured");
    }

    const timeoutSeconds = telegramConfig.otpTimeoutSeconds;
    const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
    const completed = new AbortController();
    const combined = AbortSignal.any(
      [signal, timeout, completed.signal].filter(
        (signal) => signal !== undefined,
      ),
    );
    const response = Promise.withResolvers<string>();
    const registration = Promise.withResolvers<number | undefined>();
    const cancellation = aborted(combined, registration).then(() => undefined);
    registering.add(registration.promise);
    let messageId: number | undefined;
    let reminder: NodeJS.Timeout | undefined;

    try {
      const requestMessage = await Promise.race([
        bot.telegram.sendMessage(
          telegramConfig.chatId,
          `🔐 2FA Authentication Required\n\n` +
            `Account: ${companyId}\n` +
            otpRequestContext(options) +
            `Please enter the OTP code sent to ${phoneNumber ?? "your phone"}:\n\n` +
            `Reply to this message with the digits, or "resend" for a fresh code.`,
        ),
        cancellation,
      ]);
      signal?.throwIfAborted();
      if (!requestMessage || timeout.aborted) {
        throw new Error(
          `OTP timeout: No response received within ${timeoutSeconds} seconds`,
        );
      }
      messageId = requestMessage.message_id;
      logger("Waiting for OTP code from user...");
      pending.set(messageId, (text, sentAt) => {
        // Polling starts once per run, and Telegram redelivers whatever the
        // previous run never confirmed: its last code, or a "resend".
        if (sentAt < requestMessage.date) return undefined;
        const reply = parseOtpReply(text);
        if (reply === undefined) {
          return `Reply with the ${companyId} OTP digits, or "resend" for a fresh code.`;
        }
        pending.delete(requestMessage.message_id);
        response.resolve(reply);
        if (reply === OTP_RESEND) {
          logger("User asked for a new OTP code");
          return "📨 Asking the bank for a new code...";
        }
        return "✅ OTP code received. Continuing authentication...";
      });
      reminder = setTimeout(() => {
        bot.telegram
          .sendMessage(
            telegramConfig.chatId,
            `⏳ Still waiting for the ${companyId} OTP — ` +
              `${Math.ceil(timeoutSeconds / 120)} minutes left. ` +
              `Reply to the prompt with the digits, or "resend" for a fresh code.`,
            { reply_parameters: { message_id: requestMessage.message_id } },
          )
          .catch((error: unknown) =>
            logger("Failed to send OTP reminder", error),
          );
      }, timeoutSeconds * 500);
      reminder.unref();
      registering.delete(registration.promise);
      registration.resolve(messageId);
      const received = await Promise.race([response.promise, cancellation]);
      if (typeof received === "string") return received;
      signal?.throwIfAborted();
      throw new Error(
        `OTP timeout: No response received within ${timeoutSeconds} seconds`,
      );
    } finally {
      clearTimeout(reminder);
      completed.abort();
      if (messageId !== undefined) pending.delete(messageId);
      registering.delete(registration.promise);
      registration.resolve(undefined);
    }
  };
  return requestOtpCode;
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
