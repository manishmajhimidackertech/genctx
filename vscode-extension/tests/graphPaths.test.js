"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { toNodeId, fromNodeId } = require("../out/graphPaths.js");

test("node ids are root-relative with forward slashes", () => {
  assert.equal(toNodeId("/p", "/p/src/a.ts", "linux"), "src/a.ts");
  assert.equal(toNodeId("/p/", "/p/src/../b.ts", "linux"), "b.ts");
  assert.equal(toNodeId("C:\\p", "C:\\p\\src\\a.ts", "win32"), "src/a.ts");
});

test("files outside the root have no node", () => {
  assert.equal(toNodeId("/p", "/other/a.ts", "linux"), undefined);
  assert.equal(toNodeId("/p", "/p", "linux"), undefined);
  assert.equal(toNodeId("/p", "/pq/a.ts", "linux"), undefined);
});

test("case is ignored where the file system ignores it, but kept in the id", () => {
  assert.equal(toNodeId("c:\\P", "C:\\p\\Src\\A.ts", "win32"), "Src/A.ts");
  assert.equal(toNodeId("/Users/Me/P", "/users/me/p/Src/A.ts", "darwin"), "Src/A.ts");
  assert.equal(toNodeId("/P", "/p/a.ts", "linux"), undefined);
});

test("ids map back to paths", () => {
  const path = require("node:path");
  assert.equal(fromNodeId("/p", "src/a.ts"), path.join("/p", "src", "a.ts"));
});
