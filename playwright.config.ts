import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

function findExecutable(names: string[]): string | undefined {
	for (const directory of process.env.PATH?.split(":") ?? []) {
		for (const name of names) {
			const executablePath = join(directory, name);
			if (existsSync(executablePath)) {
				return executablePath;
			}
		}
	}
}

const chromiumExecutablePath =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
	findExecutable(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);

export default defineConfig({
	testDir: "./tests",
	webServer: {
		command: "bun run dev -- --host 127.0.0.1 --port 4321",
		url: "http://127.0.0.1:4321/",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
	use: {
		baseURL: "http://127.0.0.1:4321",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				...(chromiumExecutablePath
					? { launchOptions: { executablePath: chromiumExecutablePath } }
					: {}),
			},
		},
	],
});
