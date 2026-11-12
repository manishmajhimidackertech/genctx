// <<<GENCTX
// FILE: vscode-extension/src/graphHtml.ts
// ROLE: The code graph webview's HTML page — controls, canvas and a nonce-based Content Security Policy
// EXPORTS: graphPage(), GraphPageOptions
// IMPORTS: NONE
// USED BY: vscode-extension/src/graphView.ts, vscode-extension/tests/graphView.browser.js
// NOTES: No VS Code import, so the browser test renders exactly the page the extension shows
// GENCTX>>>

export interface GraphPageOptions {
  /** The webview's `cspSource`. */
  cspSource: string;
  nonce: string;
  styleUri: string;
  modelUri: string;
  scriptUri: string;
}

export function graphPage(o: GraphPageOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource}`,
    `script-src 'nonce-${o.nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${o.styleUri}">
  <title>Code Graph</title>
</head>
<body>
  <div id="toolbar">
    <input id="search" type="search" placeholder="Search files and roles…" aria-label="Search files and roles">
    <label class="toggle" title="Show only the files linked to the active file"><input id="local" type="checkbox"> Local</label>
    <label class="depth" title="How many links away from the active file">Depth <input id="depth" type="range" min="1" max="4" value="2"> <output id="depthValue">2</output></label>
    <label class="toggle" title="Centre on the file open in the editor"><input id="follow" type="checkbox" checked> Follow editor</label>
    <label class="toggle" title="Show files with no links"><input id="orphans" type="checkbox" checked> Orphans</label>
    <label class="toggle" title="Show link direction"><input id="arrows" type="checkbox" checked> Arrows</label>
    <label class="select">Colour <select id="colour">
      <option value="folder">Folder</option>
      <option value="language">Language</option>
      <option value="context">Context</option>
    </select></label>
    <span class="spacer"></span>
    <span id="stats" aria-live="polite"></span>
    <button id="fit" title="Fit the graph to the window">Fit</button>
    <button id="refresh" title="Rescan the project">Refresh</button>
  </div>
  <canvas id="graph" aria-label="Dependency graph of the project's files"></canvas>
  <div id="legend"></div>
  <div id="tooltip" role="tooltip" hidden></div>
  <div id="message" hidden></div>
  <div id="help">Click: open · Alt+click: open beside · Shift+click: pack with imports · Double-click: local graph · Drag: move · Scroll: zoom</div>
  <script nonce="${o.nonce}" src="${o.modelUri}"></script>
  <script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
