import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFile, mkdir } from "node:fs/promises";

const testPluginDirectory =
  "test_vault/.obsidian/plugins/heading-section-tools";

const syncTestVaultPlugin = {
  name: "sync-test-vault-plugin",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) {
        return;
      }

      await mkdir(testPluginDirectory, { recursive: true });
      await Promise.all([
        copyFile("main.js", `${testPluginDirectory}/main.js`),
        copyFile("manifest.json", `${testPluginDirectory}/manifest.json`),
      ]);
    });
  },
};

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  loader: {
    ".css": "text"
  },
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  plugins: [syncTestVaultPlugin]
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
