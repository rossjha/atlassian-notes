import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACK_INCLUDE } from "../scripts/pack.ts";

const root = join(import.meta.dirname, "..");

test("PACK_INCLUDE excludes secrets, build output and absolute paths", () => {
  for (const bad of [".env", "node_modules", "public/js", "public/app.css"]) {
    assert.ok(!PACK_INCLUDE.includes(bad), bad);
  }
  for (const e of PACK_INCLUDE) {
    assert.ok(!e.startsWith("~") && !e.startsWith("/"), e);
    assert.ok(!e.split("/").includes(".."), e);
  }
});

test("every PACK_INCLUDE entry exists", () => {
  for (const e of PACK_INCLUDE) assert.ok(existsSync(join(root, e)), e);
});
