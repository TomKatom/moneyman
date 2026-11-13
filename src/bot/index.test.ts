jest.mock("telegraf", () => ({
  Telegraf: jest.fn(() => ({
    on: jest.fn(),
    telegram: {
      sendMessage: jest.fn(),
      editMessageText: jest.fn(),
      sendMediaGroup: jest.fn(),
    },
  })),
  TelegramError: class extends Error {},
}));

jest.mock("../config.js", () => ({
  config: {
    options: {
      notifications: { telegram: { apiKey: "token", chatId: "42" } },
      scraping: {},
    },
  },
}));

jest.mock("../utils/logger.js", () => ({
  createLogger: () => jest.fn(),
  logToPublicLog: jest.fn(),
}));

jest.mock("./storage/index.js", () => ({
  storages: [{}],
  saveResults: jest.fn(),
}));

jest.mock("./messages.js", () => ({
  getSummaryMessages: () => "summary",
}));

import { Telegraf } from "telegraf";
import { runWithStorage } from "./index.js";
import { REQUEST_TIMEOUT_MS } from "./notifier.js";
import type { RunnerHooks } from "../types.js";

const telegram = jest.mocked(Telegraf).mock.results[0].value.telegram;
const { saveResults } = jest.requireMock("./storage/index.js");
const { logToPublicLog } = jest.requireMock("../utils/logger.js");

const results = [{ companyId: "hapoalim", result: { success: true } }];

async function scrapeEverything(hooks: RunnerHooks) {
  await hooks.onStatusChanged(["[hapoalim] END_SCRAPING"]);
  await hooks.onResultsReady(results as any);
  await hooks.onError(new Error("boom"));
}

function publicLog(): string[] {
  return logToPublicLog.mock.calls.map(([line]: [string]) => line);
}

describe("runWithStorage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("scrapes and saves when every Telegram request is rejected", async () => {
    const failure = Object.assign(new Error("request to <url> failed"), {
      code: "ECONNRESET",
    });
    telegram.sendMessage.mockRejectedValue(failure);
    telegram.editMessageText.mockRejectedValue(failure);

    const runScraper = jest.fn(scrapeEverything);
    await runWithStorage(runScraper);

    expect(runScraper).toHaveBeenCalledTimes(1);
    expect(saveResults).toHaveBeenCalledWith(results);
    expect(publicLog()).toContain(
      "Telegram failed, start message not sent (ECONNRESET)",
    );
    expect(publicLog().at(-1)).toBe("Scraping ended");
  });

  it("gives up on a Telegram request that never answers", async () => {
    jest.useFakeTimers();
    try {
      telegram.sendMessage.mockReturnValue(new Promise(() => {}));
      const runScraper = jest.fn(async () => {});

      const run = runWithStorage(runScraper);
      await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await run;

      expect(runScraper).toHaveBeenCalledTimes(1);
      expect(publicLog()).toContain(
        "Telegram failed, start message not sent (TIMEOUT)",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("never puts a Telegram error message in the public log", async () => {
    telegram.sendMessage.mockRejectedValue(
      new Error("request to https://api.telegram.org/botSECRET/sendMessage"),
    );

    await runWithStorage(jest.fn(scrapeEverything));

    expect(publicLog().join("\n")).not.toContain("SECRET");
  });
});
