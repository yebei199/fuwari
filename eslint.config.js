import js from "@eslint/js";

const browserGlobals = {
	document: "readonly",
	localStorage: "readonly",
	navigator: "readonly",
	window: "readonly",
};

const nodeGlobals = {
	console: "readonly",
	process: "readonly",
};

export default [
	{
		ignores: ["coverage/**", "dist/**", "node_modules/**", "test-results/**"],
	},
	js.configs.recommended,
	{
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: {
			ecmaVersion: "latest",
			globals: {
				...browserGlobals,
				...nodeGlobals,
			},
			sourceType: "module",
		},
		rules: {
			"no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
		},
	},
];
