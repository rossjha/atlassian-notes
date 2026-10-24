import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PACK_INCLUDE, buildZip, isExcluded } from "../scripts/pack.ts";

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

test("isExcluded drops env files and .DS_Store but keeps .env.example", () => {
  assert.ok(isExcluded(".env"));
  assert.ok(isExcluded(".env.local"));
  assert.ok(isExcluded(".DS_Store"));
  assert.ok(!isExcluded(".env.example"));
  assert.ok(!isExcluded("main.ts"));
});

test("buildZip nests under atlassian-notes/ and skips env files, .DS_Store and symlinks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pack-test-"));
  try {
    const fake = join(tmp, "repo");
    for (const e of PACK_INCLUDE) {
      mkdirSync(dirname(join(fake, e)), { recursive: true });
      if (!/\.\w+$/.test(e) && !e.startsWith(".")) mkdirSync(join(fake, e), { recursive: true });
      else writeFileSync(join(fake, e), "x");
    }
    writeFileSync(join(fake, "src", "a.ts"), "x");
    writeFileSync(join(fake, "src", ".env"), "SECRET");
    writeFileSync(join(fake, "src", ".env.local"), "SECRET");
    writeFileSync(join(fake, "src", ".DS_Store"), "x");
    writeFileSync(join(tmp, "outside.txt"), "x");
    symlinkSync(join(tmp, "outside.txt"), join(fake, "src", "link.txt"));
    const zip = join(tmp, "out.zip");
    buildZip(fake, zip);
    const names = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(names.every((n) => n.startsWith("atlassian-notes/")), names.join());
    assert.ok(names.includes("atlassian-notes/src/a.ts"));
    assert.ok(names.includes("atlassian-notes/.env.example"));
    for (const bad of [".env", ".env.local", ".DS_Store", "link.txt"]) {
      assert.ok(!names.some((n) => n.endsWith(`/src/${bad}`)), bad);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
