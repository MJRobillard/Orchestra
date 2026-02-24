import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "path";

// Load .env.local so DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, TESTING, RUN_LLM_CHECK
// are visible to the Playwright test runner (Next.js loads this file at runtime
// but plain Node/Playwright does not).
loadEnv({ path: path.resolve(__dirname, ".env.local"), override: false });

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  tsconfig: "./tsconfig.json",
  projects: [
    {
      name: "contract",
      testMatch: /backend\.contract\.spec\.ts/,
    },
    {
      name: "frontend-state",
      testMatch: /frontend\.workflow\.spec\.ts/,
    },
  ],
});
