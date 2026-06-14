import { de } from "./languages/de";
import { en } from "./languages/en";
import { ja } from "./languages/ja";
import { zh_CN } from "./languages/zh_CN";

export type LangCode = "en" | "zh_CN" | "ja" | "de";

export const SUPPORTED_LANGS: { code: LangCode; label: string }[] = [
	{ code: "en", label: "English" },
	{ code: "zh_CN", label: "中文" },
	{ code: "ja", label: "日本語" },
	{ code: "de", label: "Deutsch" },
];

export const clientTranslations: Record<LangCode, Record<string, string>> = {
	en,
	zh_CN,
	ja,
	de,
};
