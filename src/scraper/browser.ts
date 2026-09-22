import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CompanyTypes } from "israeli-bank-scrapers";
import puppeteer, {
  TargetType,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
} from "puppeteer";
import { createLogger } from "../utils/logger.js";
import {
  runInLoggerContext,
  loggerContextStore,
} from "../utils/asyncContext.js";
import { initDomainTracking } from "../security/domains.js";
import { solveTurnstile } from "./cloudflareSolver.js";
import { config } from "../config.js";

export const browserArgs = [
  "--disable-dev-shm-usage",
  "--no-sandbox",
  // Reduce easy automation fingerprints used by anti-bot providers.
  "--disable-blink-features=AutomationControlled",
];
export const browserExecutablePath =
  config.options.scraping.puppeteerExecutablePath || undefined;

/**
 * A persistent Chromium profile keeps cookies, localStorage and IndexedDB between
 * runs, which is where banks keep device trust. Without it every run is a new
 * device, and banks that challenge new devices (Hapoalim) ask for an OTP nightly.
 */
export const browserProfilePath =
  process.env.MONEYMAN_BROWSER_PROFILE_PATH || undefined;

const logger = createLogger("browser");

export async function createBrowser(): Promise<Browser> {
  if (browserProfilePath) {
    await clearStaleProfileLock(browserProfilePath);
  }

  const options = {
    args: browserArgs,
    executablePath: browserExecutablePath,
    // Hide the "Chrome is being controlled by automated software" marker.
    ignoreDefaultArgs: ["--enable-automation"],
    userDataDir: browserProfilePath,
  } satisfies LaunchOptions;

  logger("Creating browser", options);
  return puppeteer.launch(options);
}

/**
 * Chromium refuses a profile whose Singleton* files point at another process.
 * A run killed mid-scrape leaves them behind, and in a container the hostname
 * and PID they record never match again. Only one run may use a profile at a
 * time, so any lock found at start-up is stale.
 */
async function clearStaleProfileLock(profilePath: string) {
  await Promise.all(
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
      rm(join(profilePath, name), { force: true }),
    ),
  );
}

export async function createSecureBrowserContext(
  browser: Browser,
  companyId: CompanyTypes,
): Promise<BrowserContext> {
  // Only the default context is backed by the profile on disk; any context
  // created on top of it is incognito and forgotten on close. Accounts scraped
  // in the same run therefore share it.
  const context = browserProfilePath
    ? browser.defaultBrowserContext()
    : await browser.createBrowserContext();
  await initDomainTracking(context, companyId);
  await initCloudflareSkipping(context);
  return context;
}

async function initCloudflareSkipping(browserContext: BrowserContext) {
  const activeContext = loggerContextStore.getStore();

  const cfParam = "__cf_chl_rt_tk";

  logger("Setting up Cloudflare skipping");
  browserContext.on(
    "targetcreated",
    runInLoggerContext(
      logRejections(async (target) => {
        if (target.type() === TargetType.PAGE) {
          logger("Target created %o", target.type());
          const page = await target.page();
          if (!page) return;

          const userAgent = await page.evaluate(() => navigator.userAgent);
          const newUA = userAgent.replace("HeadlessChrome/", "Chrome/");
          logger("Replacing user agent", { userAgent, newUA });

          await page.setUserAgent(newUA);
          await page.setExtraHTTPHeaders({
            "accept-language": "en-US,en;q=0.9,he;q=0.8",
          });
          await page.evaluateOnNewDocument(() => {
            // Apply lightweight stealth patches before page scripts run.
            Object.defineProperty(navigator, "webdriver", {
              get: () => undefined,
            });
            Object.defineProperty(navigator, "language", {
              get: () => "en-US",
            });
            Object.defineProperty(navigator, "languages", {
              get: () => ["en-US", "en", "he"],
            });
          });

          page.on(
            "framenavigated",
            runInLoggerContext((frame) => {
              const url = frame.url();
              if (!url || url === "about:blank") return;
              logger("Frame navigated", {
                url,
                parentFrameUrl: frame.parentFrame()?.url(),
              });
              if (url.includes(cfParam)) {
                logger("Cloudflare challenge detected");
                solveTurnstile(page).then(
                  (res) => {
                    logger(`Cloudflare challenge ended with ${res} for ${url}`);
                  },
                  (error) => {
                    logger(`Cloudflare challenge failed for ${url}`, error);
                  },
                );
              }
            }, activeContext),
          );
        }
      }),
      activeContext,
    ),
  );
}

/**
 * Nothing awaits an event listener's promise, so a rejection — typically a page
 * closed before its setup finished — would be unhandled and end the whole run.
 */
function logRejections<A extends unknown[]>(
  listener: (...args: A) => Promise<void>,
) {
  return (...args: A) =>
    listener(...args).catch((error) => logger("Target setup failed", error));
}
