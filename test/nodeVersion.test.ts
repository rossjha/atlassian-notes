import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeVersionProblem } from "../src/server/nodeVersion.ts";

test("nodeVersionProblem accepts >=22.18 and explains anything older", () => {
  for (const ok of ["v22.18.0", "v22.22.1", "v23.0.0", "v24.1.0"]) assert.equal(nodeVersionProblem(ok), null, ok);
  for (const old of ["v22.17.9", "v20.11.0", "v18.0.0"]) {
    const msg = nodeVersionProblem(old);
    assert.ok(msg && msg.includes("22.18") && msg.includes(old), old);
  }
});
