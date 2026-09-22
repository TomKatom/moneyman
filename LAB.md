# The `lab/hapoalim` branch

A fork of [daniel-hauser/moneyman](https://github.com/daniel-hauser/moneyman) that
scrapes Bank Hapoalim unattended. It is built into
`ghcr.io/tomkatom/moneyman:<upstream tag>-lab.<n>` and run by
[TomKatom/lab](https://github.com/TomKatom/lab) as its own CronJob, next to the stock
image that scrapes everything else.

Hapoalim sends an SMS code to any browser it does not recognise. Upstream cannot
answer that. The fix is spread across two forks:

|                                                                                                        | What it adds                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TomKatom/israeli-bank-scrapers](https://github.com/TomKatom/israeli-bank-scrapers) `lab/hapoalim-otp` | detects Hapoalim's OTP form, calls `otpCodeRetriever`, and honours an `OTP_RESEND` answer                                                           |
| this branch                                                                                            | relays the prompt to Telegram with `resend` and a reminder, and keeps a persistent browser profile so the bank's device trust survives between runs |

Every commit on this branch sits on top of an upstream release tag and can be
read on its own with `git log <base tag>..lab/hapoalim`.

## Configuration

Upstream's config schema is unchanged. On top of it:

- `notifications.telegram.enableOtp: true` also covers `hapoalim` accounts. No
  `phoneNumber` is needed; the bank texts the number it has on file.
- `MONEYMAN_BROWSER_PROFILE_PATH` — a writable directory kept between runs. All
  accounts in a run share it, so use it with one account per run. It holds live
  bank session cookies: keep it out of backups.
- Set `notifications.telegram.sendReportFileToTelegram: false`. Upstream defaults
  it to `true`, and the `report.html` it then sends after every run embeds every
  scraped transaction, failure screenshots and the run's logs.

## Rebasing onto a new upstream release

The weekly **Upstream drift** workflow fails when upstream releases past our base
tag. Then:

```sh
git fetch upstream --tags
git rebase -X ignore-space-change --onto v<new> v<old> lab/hapoalim
```

`-X ignore-space-change` because `fix(browser)` re-indents upstream's
`initCloudflareSkipping`; without it any upstream edit there conflicts. Run
`npx prettier --write src/scraper/browser.ts` on that commit afterwards, because
the strategy keeps upstream's indentation inside the wrapper.

Scraping runs in a worker thread, which shapes two of our commits:

- The OTP gate is `shouldCreateOtpRetriever` in `src/scraper/otp.ts`. The parent's
  `otp` callback in `client.ts` and the worker's `findOtpAccountIndex` lookup both
  call it, so a new upstream check against `oneZero` or `phoneNumber` in either
  file must go through it too, or Hapoalim prompts fail with `Invalid scraper worker
OTP request`.
- The worker sees only the variables allow-listed in `src/scraper/environment.ts`.
  `MONEYMAN_BROWSER_PROFILE_PATH` must stay on that list. Without it Chromium runs
  incognito and Hapoalim asks for an OTP every night. `verify-browser-profile`
  runs in a worker for this reason, and fails if the variable is missing.

`package.json` and `package-lock.json` conflict on the `israeli-bank-scrapers`
line, which upstream bumps all the time. Take upstream's files and re-apply our pin
instead of hand-merging the lockfile:

```sh
git checkout v<new> -- package.json package-lock.json
npm pkg set 'dependencies.israeli-bank-scrapers=github:TomKatom/israeli-bank-scrapers#<pin>'
PUPPETEER_SKIP_DOWNLOAD=true npm install
git add package.json package-lock.json && git rebase --continue
```

`npm pkg set` re-sorts `dependencies`. Move any key it moved back to where
upstream has it, so the commit stays a one-line change.

Then test and publish:

```sh
npm ci && npm run lint && npm run build && npm test
git push --force-with-lease origin lab/hapoalim
git tag v<new>-lab.1 && git push origin v<new>-lab.1
```

The tag builds and pushes the image. The **Lab image** run summary prints
`tag@digest`; bump `clusters/lab/apps/moneyman-hapoalim.yaml` in the lab repo to it.
Fixes on the same base are tagged `-lab.2`, `-lab.3` and so on.

Moving the `israeli-bank-scrapers` pin, after that fork is rebased, is the same
`npm pkg set` / `npm install` pair, a commit amended into
`build: depend on the lab israeli-bank-scrapers fork`, and a new `-lab.<n>` tag.

## Repository settings that are not in git

A recreated fork needs all six again. GitHub parks a fork's scheduled workflows as
`disabled_fork`, which already counts as disabled — never enable those three.

| Setting                   | Value          | Why                                                                                                     |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| Default branch            | `lab/hapoalim` | scheduled workflows only run on the default branch                                                      |
| Actions                   | enabled        | GitHub keeps workflows off on a fork until they are enabled                                             |
| `build.yml`               | disabled       | upstream's twice-daily release job would publish `:latest` and CalVer tags that collide with upstream's |
| `cleanup-images.yml`      | disabled       | deletes container images daily                                                                          |
| `copilot-setup-steps.yml` | disabled       | its push filter matches a tag push, so it ran on every release                                          |
| `scrape.yml`              | disabled       | upstream's own scheduled scrape; it has no config here and would fail twice a day                       |

The package `ghcr.io/tomkatom/moneyman` must also be set to **public** once, after
its first push: GitHub creates it private, and the cluster pulls without credentials.

## Retiring the fork

The drift workflow also fails when upstream's `src/scraper/otp.ts` starts
mentioning hapoalim. Drop whatever upstream now covers. When nothing is left, the lab
CronJob goes back to the stock image. The dependency commit stays: upstream's stale bot closed
eshaham/israeli-bank-scrapers#1084 unmerged on 2026-10-23, so no released
israeli-bank-scrapers handles Hapoalim's OTP.
