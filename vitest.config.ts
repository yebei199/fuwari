import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["tests/**", "node_modules/**", "dist/**"],
		include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"],
		passWithNoTests: true,
	},
});
