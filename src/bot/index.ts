import { saveResults, storages } from "./storage/index.js";
import { AccountScrapeResult, Runner } from "../types.js";
import { createLogger, logToPublicLog } from "../utils/logger.js";
import { getSummaryMessages } from "./messages.js";
import {
  bestEffort,
  editMessage,
  send,
  sendError,
  sendJSON,
  sendPhotos,
} from "./notifier.js";
import { runContextStore } from "../utils/asyncContext.js";
import { randomUUID } from "crypto";

const logger = createLogger("bot");

export async function runWithStorage(runScraper: Runner) {
  const message = await bestEffort("start message", () => send("Starting..."));
  if (!storages.length) {
    logger("No storages found, aborting");
    await bestEffort("abort message", () =>
      editMessage(message?.message_id, "No storages found, aborting"),
    );
    return;
  }

  const runId = randomUUID();

  await runContextStore.run({ runId }, async () => {
    await runScraper({
      async onStatusChanged(status: Array<string>, totalTime?: number) {
        const text = status.join("\n");
        await bestEffort("status update", () =>
          editMessage(
            message?.message_id,
            totalTime
              ? text + `\n\nTotal time: ${totalTime.toFixed(1)} seconds`
              : text,
          ),
        );
      },
      async onResultsReady(results: AccountScrapeResult[]) {
        const summaryMessage = getSummaryMessages(results);
        await bestEffort("summary", () => send(summaryMessage, "HTML"));
        await saveResults(results);
      },
      async onError(e: unknown, caller: string = "unknown") {
        await bestEffort("error report", () => sendError(e, caller));
      },
      async onBeforeStart() {},
      async failureScreenshotsHandler(photos) {
        await bestEffort("failure screenshots", () => sendPhotos(photos));
      },
    });

    logToPublicLog("Scraping ended", logger);
  });
}
