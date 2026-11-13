import { workerEnvironment } from "./environment.js";

describe("workerEnvironment", () => {
  it("passes the persistent browser profile through to the scraper worker", () => {
    expect(
      workerEnvironment({
        MONEYMAN_BROWSER_PROFILE_PATH: "/profile",
        MONEYMAN_CONFIG: "private",
      }),
    ).toEqual({ MONEYMAN_BROWSER_PROFILE_PATH: "/profile" });
  });
});
