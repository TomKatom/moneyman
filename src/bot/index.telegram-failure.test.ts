import { mock } from "jest-mock-extended";
import { CompanyTypes } from "israeli-bank-scrapers";
import type {
  AccountScrapeResult,
  Runner,
  TransactionStorage,
} from "../types.js";
import { logToPublicLog } from "../utils/logger.js";
import { runWithStorage } from "./index.js";
import { reportTransport } from "./notifier.js";
import { saveResults } from "./storage/index.js";

jest.mock("./storage/index.js", () => ({ saveResults: jest.fn() }));
jest.mock("./notifier.js", () => ({
  __esModule: true,
  reportTransport: { send: jest.fn(), edit: jest.fn(), sendFile: jest.fn() },
  reportUpdateIntervalMs: 0,
}));
jest.mock("../config.js", () => ({
  config: {
    options: {
      notifications: {
        telegram: {
          apiKey: "test-token",
          chatId: "1",
          sendReportFileToTelegram: false,
        },
      },
    },
  },
}));
jest.mock("../utils/secure-log.js", () => ({ readReportLogs: jest.fn() }));
jest.mock("../utils/logger.js", () => ({
  ...jest.requireActual("../utils/logger.js"),
  logToPublicLog: jest.fn(),
}));

const results: AccountScrapeResult[] = [
  { companyId: CompanyTypes.hapoalim, result: { success: true, accounts: [] } },
];
const rejectSoon = () =>
  new Promise<never>((_, reject) =>
    setImmediate(() => reject(new Error("ETIMEDOUT api.telegram.org"))),
  );

const publisherTurn = () => new Promise((resolve) => setTimeout(resolve, 10));

// A Telegram outage must cost the report, never the import: an awaited send
// outside every catch once ended a run at "Starting..." with nothing saved.
describe("runWithStorage when Telegram is down", () => {
  const transport = jest.mocked(reportTransport!);

  beforeEach(() => jest.resetAllMocks());

  it.each([
    ["every send", false],
    ["every edit", true],
  ])("still saves and logs Scraping ended when %s fails", async (_, edits) => {
    if (edits) {
      transport.send.mockResolvedValue(1);
      transport.edit.mockImplementation(rejectSoon);
    } else {
      transport.send.mockImplementation(rejectSoon);
    }
    const runner: Runner = async (hooks) => {
      await hooks.onStatusChanged(["[hapoalim] START_SCRAPING"]);
      await publisherTurn();
      await hooks.onError(new Error("bank said no"), "scrape");
      await publisherTurn();
      await hooks.onStatusChanged(["[hapoalim] END_SCRAPING"]);
      await hooks.onResultsReady(results);
    };

    await runWithStorage(runner, [mock<TransactionStorage>()]);

    expect(saveResults).toHaveBeenCalledWith(
      results,
      expect.anything(),
      expect.anything(),
    );
    expect(logToPublicLog).toHaveBeenCalledWith(
      "Scraping ended",
      expect.anything(),
    );
    expect(transport.send).toHaveBeenCalled();
    expect(transport.edit.mock.calls.length > 0).toBe(edits);
  });
});
