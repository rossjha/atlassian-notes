// Bundles the Excalidraw scratchpad (src/scratchpad/entry.ts) and its fonts into public/vendor/.
// Everything is served by the app itself: the scratchpad makes no network requests.
import { build, type Plugin } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "public", "vendor");
// The CJK font is ~12 MB; without it, CJK text falls back to a system font.
const SKIP_FONTS = new Set(["Xiaolai"]);

// Excalidraw always lists a CDN copy (esm.sh) as a second font source after EXCALIDRAW_ASSET_PATH. Point that
// fallback at our own copy too, so a missing font is a local 404 and never a request off the machine.
const CDN_FALLBACK = /`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/g;
const noCdn: Plugin = {
  name: "no-cdn-fallback",
  setup(b) {
    b.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async (args) => ({
      contents: (await fs.readFile(args.path, "utf8")).replace(CDN_FALLBACK, '(window.location.origin + "/vendor/")'),
      loader: "js",
    }));
  },
};

await fs.rm(out, { recursive: true, force: true });
await build({
  entryPoints: { scratchpad: path.join(root, "src", "scratchpad", "entry.ts") },
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: ["production"],
  loader: { ".woff2": "file", ".png": "file", ".svg": "file" },
  logLevel: "warning",
  plugins: [noCdn],
});
// Fail the build rather than ship a bundle that could reach a CDN.
for (const f of await fs.readdir(out, { recursive: true })) {
  if (f.endsWith(".js") && (await fs.readFile(path.join(out, f), "utf8")).includes("esm.sh")) {
    throw new Error(`build-scratchpad: ${f} still references esm.sh`);
  }
}
const fontsSrc = path.join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
for (const name of await fs.readdir(fontsSrc)) {
  if (!SKIP_FONTS.has(name)) await fs.cp(path.join(fontsSrc, name), path.join(out, "fonts", name), { recursive: true });
}
