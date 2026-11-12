"use strict";

// Pure graph logic shared by the webview (media/graph-model.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const M = require("../media/graph-model.js");

// a → b → c, a → c, d alone, e → missing (dropped), f → f (dropped)
const data = {
  nodes: ["src/a.ts", "src/b.ts", "lib/c.ts", "README.md", "e.ts", "f.ts"].map((id) => ({
    id,
    lang: id.endsWith(".md") ? "markdown" : "typescript",
    role: id === "lib/c.ts" ? "Parses Tokens" : undefined,
    context: id === "src/a.ts" ? "current" : "missing",
  })),
  edges: [
    ["src/a.ts", "src/b.ts"],
    ["src/b.ts", "lib/c.ts"],
    ["src/a.ts", "lib/c.ts"],
    ["e.ts", "gone.ts"],
    ["f.ts", "f.ts"],
  ],
};
const sorted = (set) => Array.from(set).sort((x, y) => x - y);

test("index keeps only edges between known, distinct nodes", () => {
  const idx = M.buildIndex(data);
  assert.deepEqual(idx.links, [
    [0, 1],
    [1, 2],
    [0, 2],
  ]);
  assert.deepEqual(idx.out[0], [1, 2]);
  assert.deepEqual(idx.in[2], [1, 0]);
  assert.deepEqual(idx.degree, [2, 2, 2, 0, 0, 0]);
});

test("neighbourhood follows links both ways up to the depth", () => {
  const idx = M.buildIndex(data);
  assert.deepEqual(sorted(M.neighbourhood(idx, 2, 1)), [0, 1, 2]);
  assert.deepEqual(sorted(M.neighbourhood(idx, 3, 3)), [3]);
});

test("visible nodes: local mode, orphans and the focus", () => {
  const idx = M.buildIndex(data);
  const all = M.visibleNodes(idx, 6, { local: false, orphans: true, focus: -1 });
  assert.equal(all.size, 6);
  const linked = M.visibleNodes(idx, 6, { local: false, orphans: false, focus: 4 });
  assert.deepEqual(sorted(linked), [0, 1, 2, 4], "the focus shows even without links");
  const local = M.visibleNodes(idx, 6, { local: true, depth: 1, orphans: true, focus: 1 });
  assert.deepEqual(sorted(local), [0, 1, 2]);
  // Local mode without a focus shows everything rather than nothing.
  assert.equal(M.visibleNodes(idx, 6, { local: true, orphans: true }).size, 6);
});

test("search matches paths and roles, case-insensitively", () => {
  assert.deepEqual(sorted(M.searchNodes(data.nodes, "TOKENS")), [2]);
  assert.deepEqual(sorted(M.searchNodes(data.nodes, "src/")), [0, 1]);
  assert.equal(M.searchNodes(data.nodes, "  ").size, 0);
});

test("colour keys by folder, language and context state", () => {
  assert.equal(M.folderOf("src/deep/x.ts", 1), "src");
  assert.equal(M.folderOf("src/deep/x.ts", 2), "src/deep");
  assert.equal(M.folderOf("README.md", 1), "(root)");
  assert.equal(M.colourKey(data.nodes[3], "language"), "markdown");
  assert.equal(M.colourKey(data.nodes[0], "context"), "current");
  assert.equal(M.colourKey(data.nodes[2], "folder"), "lib");
  const p = M.palette(5, true);
  assert.equal(new Set(p).size, 5);
});
