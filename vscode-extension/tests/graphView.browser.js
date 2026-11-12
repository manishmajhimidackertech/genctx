"use strict";

// Drives the real code graph page (media/ + out/graphHtml.js) in Chromium.
// Not part of `npm test` (it needs Playwright and a browser):
//
//   npm run compile && node tests/graphView.browser.js <graph.json> [screenshot-dir]
//
// <graph.json> is the output of `genctx graph --json`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const { graphPage } = require("../out/graphHtml.js");

async function main() {
  const [graphFile, shotDir] = process.argv.slice(2);
  const data = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  const media = path.join(__dirname, "..", "media");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genctx-graph-"));
  const page = path.join(dir, "index.html");
  const url = (name) => pathToFileURL(path.join(media, name)).toString();
  fs.writeFileSync(
    page,
    graphPage({
      cspSource: "file:",
      nonce: "testnonce",
      styleUri: url("graph.css"),
      modelUri: url("graph-model.js"),
      scriptUri: url("graph.js"),
    })
  );

  const browser = await chromium.launch();
  const results = [];
  try {
    for (const scheme of ["dark", "light"]) {
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      const tab = await ctx.newPage();
      const errors = [];
      tab.on("pageerror", (e) => errors.push(e.message));
      tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await tab.addInitScript(() => {
        window.__GENCTX_TEST__ = true;
        window.__posted = [];
        window.acquireVsCodeApi = () => ({
          postMessage: (m) => window.__posted.push(m),
          getState: () => null,
          setState: () => {},
        });
      });
      await tab.goto(pathToFileURL(page).toString());
      const posted = () => tab.evaluate(() => window.__posted);
      assert.deepEqual((await posted())[0], { type: "ready" });

      const focus = data.nodes.find((n) => n.id.endsWith("process.rs"))?.id ?? data.nodes[0].id;
      await tab.evaluate(
        ([d, f]) => window.postMessage({ type: "graph", data: d, focus: f }, "*"),
        [data, focus]
      );
      const state = () => tab.evaluate(() => window.__genctxGraph.state());
      await tab.waitForFunction(() => window.__genctxGraph.state().settled, null, { timeout: 30000 });
      let s = await state();
      assert.equal(s.visible, data.nodes.length);
      assert.equal(s.focus, focus);
      if (shotDir) await tab.screenshot({ path: path.join(shotDir, `graph-${scheme}.png`) });

      // Hover shows the tooltip; click opens; shift+click packs.
      const pos = await tab.evaluate((id) => window.__genctxGraph.screenPos(id), focus);
      await tab.mouse.move(pos.x, pos.y);
      await tab.waitForFunction((id) => window.__genctxGraph.state().hover === id, focus);
      assert.equal(await tab.isVisible("#tooltip"), true);
      assert.match(await tab.textContent("#tooltip"), /imported by/);
      if (shotDir && scheme === "dark") {
        await tab.screenshot({ path: path.join(shotDir, "graph-hover.png") });
      }
      await tab.mouse.click(pos.x, pos.y);
      await tab.keyboard.down("Shift");
      await tab.mouse.click(pos.x, pos.y);
      await tab.keyboard.up("Shift");
      const msgs = (await posted()).slice(1);
      assert.deepEqual(msgs[0], { type: "open", id: focus, beside: false });
      assert.deepEqual(msgs[1], { type: "pack", id: focus });

      // Local graph around the focus, then search.
      await tab.check("#local");
      await tab.waitForFunction(() => window.__genctxGraph.state().settled, null, { timeout: 30000 });
      s = await state();
      assert.ok(s.visible < data.nodes.length && s.visible > 1, `local shows ${s.visible}`);
      if (shotDir && scheme === "dark") {
        await tab.screenshot({ path: path.join(shotDir, "graph-local.png") });
      }
      await tab.uncheck("#local");
      await tab.waitForFunction(() => window.__genctxGraph.state().settled, null, { timeout: 30000 });
      await tab.fill("#search", "store");
      s = await state();
      assert.ok(s.hits > 0);
      await tab.selectOption("#colour", "language");
      assert.match(await tab.textContent("#legend"), /rust/);

      // A refresh keeps positions: the focus barely moves.
      const before = await tab.evaluate((id) => window.__genctxGraph.screenPos(id), focus);
      await tab.evaluate((d) => window.postMessage({ type: "graph", data: d }, "*"), data);
      await tab.waitForFunction(() => window.__genctxGraph.state().settled, null, { timeout: 30000 });
      const after = await tab.evaluate((id) => window.__genctxGraph.screenPos(id), focus);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 60, "layout kept on refresh");

      assert.deepEqual(errors, []);
      results.push(`${scheme}: ok (${data.nodes.length} files, ${data.edges.length} links)`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(results.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
