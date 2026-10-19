import { defineConfig } from "@playwright/test";

const port = 3107;
const baseURL = `http://127.0.0.1:${port}`;
const artifacts = "artifacts/e2e";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  forbidOnly: Boolean(process.env.CI),
  outputDir: `${artifacts}/test-results`,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${artifacts}/report`, open: "never" }],
    ["json", { outputFile: `${artifacts}/results.json` }],
  ],
  use: { baseURL },
  webServer: {
    command: `npm start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
