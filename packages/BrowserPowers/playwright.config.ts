import { defineConfig } from "@playwright/test";
import { resolve } from "path";

const EXT_PATH = resolve(
  __dirname,
  "extension",
  ".output",
  "chrome-mv3"
);

export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH.replace(/\\/g, "/")}`,
      `--load-extension=${EXT_PATH.replace(/\\/g, "/")}`,
    ],
    viewport: { width: 1280, height: 720 },
  },
  globalSetup: "./e2e/setup.ts",
});
