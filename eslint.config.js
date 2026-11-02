import js from "@eslint/js";
import globals from "globals";

export default [
    { ignores: ["node_modules/", "native/build/"] },
    js.configs.recommended,
    { rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] } },
    { files: ["src/main/**", "scripts/**", "extension/**", "test/**", "*.js"], languageOptions: { globals: globals.node } },
    { files: ["src/overlay/**"], languageOptions: { globals: globals.browser } },
    { files: ["src/shared/**"], languageOptions: { globals: { setTimeout: "readonly", clearTimeout: "readonly" } } },
    { files: ["src/preload.cjs"], languageOptions: { sourceType: "commonjs", globals: { ...globals.node, ...globals.browser } } },
];
