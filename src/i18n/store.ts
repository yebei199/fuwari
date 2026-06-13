import { derived, writable } from "svelte/store";
import { clientTranslations, type LangCode } from "./client";

const initialLang: LangCode =
	typeof localStorage !== "undefined"
		? ((localStorage.getItem("fuwari-lang") as LangCode) ?? "en")
		: "en";

export const currentLang = writable<LangCode>(
	clientTranslations[initialLang] ? initialLang : "en",
);

export const t = derived(
	currentLang,
	($lang) => clientTranslations[$lang] ?? clientTranslations.en,
);
