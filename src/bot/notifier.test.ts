import { OTP_RESEND } from "israeli-bank-scrapers";

const PROMPT_DATE = 1_000;

jest.mock("telegraf", () => {
  const bot = {
    on: jest.fn(),
    launch: jest.fn(),
    stop: jest.fn(),
    telegram: {
      sendMessage: jest.fn(),
    },
  };
  return {
    Telegraf: jest.fn(() => bot),
    TelegramError: class extends Error {},
    __bot: bot,
  };
});

jest.mock("../config.js", () => ({
  config: {
    options: {
      notifications: {
        telegram: {
          apiKey: "token",
          chatId: "42",
          enableOtp: true,
          otpTimeoutSeconds: 600,
        },
      },
      scraping: {},
    },
  },
}));

jest.mock("../utils/logger.js", () => ({
  createLogger: () => jest.fn(),
  logToPublicLog: jest.fn(),
}));

import { parseOtpReply, requestOtpCode } from "./notifier.js";

const mockBot = jest.requireMock("telegraf").__bot;
const onText = mockBot.on.mock.calls[0][1] as (ctx: unknown) => void;

function reply(text: string, { chatId = 42, date = PROMPT_DATE } = {}) {
  const ctx = {
    chat: { id: chatId },
    message: { text, date },
    reply: jest.fn().mockResolvedValue(undefined),
  };
  onText(ctx);
  return ctx;
}

function sentTexts() {
  return mockBot.telegram.sendMessage.mock.calls.map(
    ([, text]: [string, string]) => text,
  );
}

describe("notifier", () => {
  describe("parseOtpReply", () => {
    it.each([
      ["123456", "123456"],
      [" 1234 ", "1234"],
      ["12345678", "12345678"],
      ["resend", OTP_RESEND],
      ["R", OTP_RESEND],
      ["שלח שוב", OTP_RESEND],
      ["123", undefined],
      ["123456789", undefined],
      ["12 34 56", undefined],
      ["thanks", undefined],
    ])("maps %p to %p", (text, expected) => {
      expect(parseOtpReply(text)).toBe(expected);
    });
  });

  describe("requestOtpCode", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      mockBot.launch.mockReset().mockReturnValue(new Promise(() => {}));
      mockBot.stop.mockReset();
      mockBot.telegram.sendMessage
        .mockReset()
        .mockResolvedValue({ message_id: 1, date: PROMPT_DATE });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("registers a single text handler however many prompts are sent", async () => {
      const first = requestOtpCode("hapoalim", undefined, { attempt: 1 });
      await jest.advanceTimersByTimeAsync(0);
      reply("resend");
      await expect(first).resolves.toBe(OTP_RESEND);

      const second = requestOtpCode("hapoalim", undefined, {
        attempt: 1,
        resent: true,
      });
      await jest.advanceTimersByTimeAsync(0);
      reply("654321");
      await expect(second).resolves.toBe("654321");

      expect(mockBot.on).toHaveBeenCalledTimes(1);
      expect(mockBot.stop).toHaveBeenCalledTimes(2);
    });

    it("keeps listening after a reply that is neither a code nor a resend", async () => {
      const code = requestOtpCode("hapoalim");
      await jest.advanceTimersByTimeAsync(0);

      const chatter = reply("which code?");
      expect(chatter.reply).toHaveBeenCalledWith(
        expect.stringContaining('"resend"'),
      );

      reply("123456");
      await expect(code).resolves.toBe("123456");
    });

    it("ignores messages older than the prompt and from other chats", async () => {
      const code = requestOtpCode("hapoalim");
      await jest.advanceTimersByTimeAsync(0);

      const stale = reply("resend", { date: PROMPT_DATE - 5 });
      const foreign = reply("111111", { chatId: 7 });
      reply("222222");

      await expect(code).resolves.toBe("222222");
      expect(stale.reply).not.toHaveBeenCalled();
      expect(foreign.reply).not.toHaveBeenCalled();
    });

    it("tells the user why they are being asked again", async () => {
      const code = requestOtpCode("hapoalim", undefined, {
        attempt: 1,
        resendFailed: true,
      });
      await jest.advanceTimersByTimeAsync(0);
      reply("123456");
      await code;

      expect(sentTexts()[0]).toContain("use the one you already have");
    });

    it("nudges at half the timeout and rejects at the timeout", async () => {
      const code = requestOtpCode("hapoalim");
      const rejection = expect(code).rejects.toThrow("OTP timeout");

      await jest.advanceTimersByTimeAsync(300_000);
      expect(sentTexts()).toHaveLength(2);
      expect(sentTexts()[1]).toContain("5 minutes left");

      await jest.advanceTimersByTimeAsync(300_000);
      await rejection;
      expect(mockBot.stop).toHaveBeenCalledTimes(1);
    });

    it("does not nudge once answered", async () => {
      const code = requestOtpCode("hapoalim");
      await jest.advanceTimersByTimeAsync(0);
      reply("123456");
      await code;

      await jest.advanceTimersByTimeAsync(600_000);
      expect(sentTexts()).toHaveLength(1);
    });
  });
});
