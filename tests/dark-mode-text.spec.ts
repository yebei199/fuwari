import { expect, test } from "@playwright/test";

const postTitle = /Google 废弃 Gemini CLI/;
const postDescription =
	/Google 切断个人用户后端，将 Gemini CLI 降级为企业附属品/;

function parseRgbChannels(color: string): [number, number, number] | null {
	const rgbMatch = color.match(/rgba?\(([^)]+)\)/);
	if (rgbMatch) {
		const channels = rgbMatch[1]
			.split(/[,\s/]+/)
			.map((part) => Number.parseFloat(part))
			.filter((value) => Number.isFinite(value));
		if (channels.length >= 3) {
			return [channels[0], channels[1], channels[2]];
		}
	}

	const srgbMatch = color.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/);
	if (!srgbMatch) {
		return null;
	}

	return [
		Number.parseFloat(srgbMatch[1]) * 255,
		Number.parseFloat(srgbMatch[2]) * 255,
		Number.parseFloat(srgbMatch[3]) * 255,
	];
}

function expectLightText(color: string): void {
	const channels = parseRgbChannels(color);
	expect(channels, `Unsupported color format: ${color}`).not.toBeNull();
	expect(channels?.every((channel) => channel > 180), `${color} should be light`).toBe(true);
}

test("dark-mode post card text is light in the dev server", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("theme", "dark");
	});

	await page.goto("/");
	await expect(page.locator("html")).toHaveClass(/dark/);

	const title = page.getByRole("link", { name: postTitle }).first();
	const description = page.getByText(postDescription).first();

	await expect(title).toBeVisible();
	await expect(description).toBeVisible();

	expectLightText(await title.evaluate((element) => getComputedStyle(element).color));
	expectLightText(await description.evaluate((element) => getComputedStyle(element).color));

	const mainCss = await page
		.locator('style[data-vite-dev-id*="/src/styles/main.css"]')
		.textContent();
	const text90RuleStart = mainCss?.indexOf(".text-90") ?? -1;
	const nextTextRuleStart = mainCss?.indexOf(".text-75", text90RuleStart) ?? -1;
	const text90Css = mainCss?.slice(text90RuleStart, nextTextRuleStart);

	expect(text90RuleStart).toBeGreaterThanOrEqual(0);
	expect(nextTextRuleStart).toBeGreaterThan(text90RuleStart);
	expect(text90Css).toContain(".dark .text-90");
	expect(text90Css).not.toContain(".dark &");
	expect(text90Css).not.toContain("&:where(.dark");
});
