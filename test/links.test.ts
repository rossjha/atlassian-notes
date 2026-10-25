import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLinks } from "../src/shared/links.ts";

test("parseLinks reads names, http(s) urls and icons", () => {
  const r = parseLinks({
    links: [
      { name: "Roadmap", url: "https://roadmap.example.com/board", icon: "map" },
      { name: "Wiki", url: "http://wiki.example.com" },
      { name: "Planning", url: "https://plan.example.com", icon: "🗺️", newTab: false },
    ],
  });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.links, [
    { name: "Roadmap", url: "https://roadmap.example.com/board", icon: { kind: "named", name: "map" }, newTab: true },
    { name: "Wiki", url: "http://wiki.example.com/", icon: null, newTab: true },
    { name: "Planning", url: "https://plan.example.com/", icon: { kind: "text", text: "🗺️" }, newTab: false },
  ]);
});

test("parseLinks skips bad entries with a warning each, keeping the good ones", () => {
  const r = parseLinks({
    links: [
      { name: "Ok", url: "https://ok.example.com" },
      { name: "Script", url: "javascript:alert(1)" },
      { name: "Relative", url: "/local" },
      { url: "https://noname.example.com" },
      { name: "  ", url: "https://blank.example.com" },
      "just a string",
    ],
  });
  assert.deepEqual(r.links.map((l) => l.name), ["Ok"]);
  assert.equal(r.warnings.length, 5);
  assert.match(r.warnings[0]!, /Script.*http/);
});

test("parseLinks: an unknown icon name falls back to the link name, with a warning naming the choices", () => {
  const r = parseLinks({ links: [{ name: "Docs", url: "https://docs.example.com", icon: "not-an-icon" }] });
  assert.deepEqual(r.links[0]!.icon, null);
  assert.match(r.warnings[0]!, /not-an-icon.*link.*globe/);
});

test("parseLinks: newTab must be true or false; anything else warns and opens in a new tab", () => {
  const r = parseLinks({ links: [{ name: "Odd", url: "https://odd.example.com", newTab: "no" }] });
  assert.equal(r.links[0]!.newTab, true);
  assert.match(r.warnings[0]!, /Odd.*newTab/);
});

test("parseLinks: empty, missing or wrongly shaped files", () => {
  assert.deepEqual(parseLinks(null), { links: [], warnings: [] });
  assert.deepEqual(parseLinks({}), { links: [], warnings: [] });
  assert.equal(parseLinks({ links: "nope" }).warnings.length, 1);
  assert.equal(parseLinks(["x"]).warnings.length, 1);
});
