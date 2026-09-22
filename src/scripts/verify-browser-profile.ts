#!/usr/bin/env node
/**
 * Proves MONEYMAN_BROWSER_PROFILE_PATH keeps browser storage between runs, in
 * the image that will actually run it. Needs no network and no config:
 *
 *   MONEYMAN_BROWSER_PROFILE_PATH=$(mktemp -d) node dst/scripts/verify-browser-profile.js
 *
 * 1. a run stores a localStorage value and a persistent cookie, and exits cleanly;
 * 2. the next run reads both back, and is then killed without closing Chromium;
 * 3. its lock is made to look like another pod's, and a third run must still
 *    start and read both back.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "puppeteer";
import {
  browserProfilePath,
  createBrowser,
  createSecureBrowserContext,
} from "../scraper/browser.js";

const MARKER = "device-trust-marker";

if (!browserProfilePath) {
  console.error("❌ MONEYMAN_BROWSER_PROFILE_PATH is not set");
  process.exit(1);
}

const server = createServer((req, res) => {
  const headers: Record<string, string> = { "content-type": "text/html" };
  if (req.url === "/set") {
    headers["set-cookie"] = `${MARKER}=1; Max-Age=86400; Path=/`;
  }
  res.writeHead(200, headers).end("<html></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function openPage(browser: Browser, path: string) {
  const context = await createSecureBrowserContext(browser, "hapoalim" as any);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  return page;
}

async function readBack(browser: Browser, run: string) {
  const page = await openPage(browser, "/");
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    MARKER,
  );
  const cookie = (await browser.cookies()).find((c) => c.name === MARKER);
  await page.close();
  if (stored !== "1" || !cookie) {
    throw new Error(
      `${run}: profile lost state (localStorage=${stored}, cookie=${!!cookie})`,
    );
  }
  console.log(`✅ ${run}: localStorage and cookie survived`);
}

try {
  const first = await createBrowser();
  const page = await openPage(first, "/set");
  await page.evaluate((key) => localStorage.setItem(key, "1"), MARKER);
  await page.close();
  await first.close();

  const second = await createBrowser();
  await readBack(second, "after a clean exit");
  const chromium = second.process();
  chromium?.kill("SIGKILL");
  if (chromium && chromium.exitCode === null && !chromium.signalCode) {
    await once(chromium, "exit");
  }

  const lock = join(browserProfilePath, "SingletonLock");
  await unlink(lock).catch(() => {});
  await symlink("another-pod-1", lock);

  const third = await createBrowser();
  await readBack(third, "after a killed run");
  await third.close();
  console.log("✅ Browser profile persists");
} catch (error) {
  console.error("❌", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.close();
}
