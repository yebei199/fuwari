import { expect, test } from "@playwright/test";

const postTitle = /Google 废弃 Gemini CLI/;
const postDescription =
	/Google 切断个人用户后端，将 Gemini CLI 降级为企业附属品/;
const profileImageUrl = "https://upload.cryptorust.uk/u/meow-loading-poster-v1.webp";
const smokeRoutes = [
	"/",
	"/archive/",
	"/about/",
	"/posts/markdown-extended/",
	"/posts/google-gemini-cli-deprecation/",
];

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

test("dev routes render without Astro server errors", async ({ page }) => {
	for (const route of smokeRoutes) {
		const response = await page.goto(route);

		expect(response, `${route} should produce a response`).not.toBeNull();
		expect(response?.ok(), `${route} returned ${response?.status()}`).toBe(true);
		await expect(page.locator("body")).not.toContainText(
			/Internal server error|module is not defined/,
		);
	}
});

test("dark-mode post card text is light in the dev server", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("theme", "dark");
	});

	const response = await page.goto("/");
	expect(response?.ok(), `Home returned ${response?.status()}`).toBe(true);
	await expect(page.locator("html")).toHaveClass(/dark/);

	const title = page.getByRole("link", { name: postTitle }).first();
	const description = page.getByText(postDescription).first();
	const homeLink = page.locator("#navbar").getByRole("link", { name: "Home" });
	const archiveLink = page.locator("#navbar").getByRole("link", { name: "Archive" });
	const profileImage = page.getByAltText("Profile Image of the Author");

	await expect(title).toBeVisible();
	await expect(description).toBeVisible();
	await expect(homeLink).toBeVisible();
	await expect(archiveLink).toBeVisible();
	await expect(profileImage).toHaveAttribute("src", profileImageUrl);

	expectLightText(await title.evaluate((element) => getComputedStyle(element).color));
	expectLightText(await description.evaluate((element) => getComputedStyle(element).color));
	expectLightText(await homeLink.evaluate((element) => getComputedStyle(element).color));
	expectLightText(await archiveLink.evaluate((element) => getComputedStyle(element).color));

	const profileImageLoaded = await profileImage.evaluate(
		(element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
	);
	expect(profileImageLoaded, "profile image should load").toBe(true);

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
	expect(mainCss).toContain(".dark .btn-plain");
});
