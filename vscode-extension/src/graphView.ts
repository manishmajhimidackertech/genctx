// <<<GENCTX
// FILE: vscode-extension/src/graphView.ts
// ROLE: The code graph webview — loads `genctx graph --json`, follows the active editor, refreshes on file changes, opens/packs files on request
// EXPORTS: GraphPanel
// IMPORTS: vscode-extension/src/pack.ts, vscode-extension/src/graphPaths.ts, vscode-extension/src/graphHtml.ts
// USED BY: vscode-extension/src/extension.ts
// NOTES: The graph comes from the store via the CLI (incremental, no Ollama); drawing and layout live in media/graph.js
// GENCTX>>>

import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

import { cliEnv, packFile, resolveCliBinary } from "./pack";
import { fromNodeId, toNodeId } from "./graphPaths";
import { graphPage } from "./graphHtml";

const execFileAsync = promisify(execFile);

/** Graph JSON as `genctx graph --json` prints it. */
interface GraphData {
  root: string;
  nodes: { id: string; lang: string; lines: number; role?: string; context: string }[];
  edges: [string, string][];
}

type FromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "open"; id: string; beside?: boolean }
  | { type: "pack"; id: string };

/** A big graph is plenty of JSON; execFile's 1 MB default is far too small. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Saves and file events arrive in bursts (save all, refactorings). */
const REFRESH_DELAY_MS = 800;

/**
 * The single code graph panel. Reopening it reveals the existing one.
 */
export class GraphPanel implements vscode.Disposable {
  private static current: GraphPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private root: string | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private loading = false;
  private reloadQueued = false;

  /** Show the graph for `folder`'s project, creating the panel if needed. */
  static show(extensionUri: vscode.Uri, folder: string): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      if (GraphPanel.current.folder !== folder) {
        GraphPanel.current.folder = folder;
        void GraphPanel.current.load();
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "genctx.graph",
      "Code Graph",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Recomputing the layout of a large graph is expensive; keep it
        // while the tab is hidden.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, folder);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private folder: string
  ) {
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    panel.webview.html = renderHtml(panel.webview, extensionUri);

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.postFocus(editor)),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh())
    );
  }

  dispose(): void {
    GraphPanel.current = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case "ready":
      case "refresh":
        void this.load();
        break;
      case "open":
        if (this.root) {
          void vscode.window.showTextDocument(vscode.Uri.file(fromNodeId(this.root, msg.id)), {
            preview: true,
            viewColumn: msg.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
          });
        }
        break;
      case "pack":
        if (this.root) {
          void packFile(fromNodeId(this.root, msg.id), true);
        }
        break;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.load(), REFRESH_DELAY_MS);
  }

  /** Fetch the graph from the CLI and hand it to the webview. */
  private async load(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    try {
      void this.panel.webview.postMessage({ type: "loading" });
      const { stdout } = await execFileAsync(
        resolveCliBinary(),
        ["graph", this.folder, "--json"],
        { env: cliEnv(), timeout: 120_000, maxBuffer: MAX_OUTPUT_BYTES }
      );
      const data = JSON.parse(stdout) as GraphData;
      this.root = data.root;
      this.panel.title = `Code Graph — ${data.nodes.length} files`;
      void this.panel.webview.postMessage({
        type: "graph",
        data,
        focus: this.focusId(vscode.window.activeTextEditor),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = message.includes("ENOENT");
      void this.panel.webview.postMessage({
        type: "error",
        message: notFound
          ? "The genctx CLI was not found. Build it with `cargo build --release -p genctx`, then run `cpctx setup` (or set genctx.cliPath)."
          : `genctx graph failed: ${message}`,
      });
    } finally {
      this.loading = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.load();
      }
    }
  }

  private focusId(editor: vscode.TextEditor | undefined): string | undefined {
    if (!editor || editor.document.uri.scheme !== "file" || !this.root) {
      return undefined;
    }
    return toNodeId(this.root, editor.document.uri.fsPath);
  }

  private postFocus(editor: vscode.TextEditor | undefined): void {
    const id = this.focusId(editor);
    if (id) {
      void this.panel.webview.postMessage({ type: "focus", id });
    }
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const media = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
  return graphPage({
    cspSource: webview.cspSource,
    nonce: makeNonce(),
    styleUri: media("graph.css"),
    modelUri: media("graph-model.js"),
    scriptUri: media("graph.js"),
  });
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
