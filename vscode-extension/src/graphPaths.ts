// <<<GENCTX
// FILE: vscode-extension/src/graphPaths.ts
// ROLE: Map editor file paths to graph node ids (root-relative, `/`-separated) and back
// EXPORTS: toNodeId(), fromNodeId()
// IMPORTS: NONE
// USED BY: vscode-extension/src/graphView.ts, vscode-extension/tests/graphPaths.test.js
// NOTES: No VS Code import, so it is unit-tested under node --test; case-insensitive on Windows and macOS like the store
// GENCTX>>>

import * as path from "path";

/**
 * The graph node id for `file` in a project rooted at `root`, or undefined
 * when the file is outside it. Ids use `/` on every platform, as the store's
 * keys do; on Windows and macOS the comparison ignores case, since the store
 * keys files by their on-disk spelling there.
 */
export function toNodeId(
  root: string,
  file: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  const insensitive = platform === "win32" || platform === "darwin";
  const norm = (s: string): string => {
    const n = p.normalize(s);
    return insensitive ? n.toLowerCase() : n;
  };
  const rel = p.relative(norm(root), norm(file));
  if (!rel || rel.startsWith("..") || p.isAbsolute(rel)) {
    return undefined;
  }
  // Slice the original (correctly cased) path rather than the lowered one.
  const original = p.normalize(file).slice(p.normalize(file).length - rel.length);
  return original.split(p.sep).join("/");
}

/** The absolute path of node `id` under `root`. */
export function fromNodeId(root: string, id: string): string {
  return path.join(root, ...id.split("/"));
}
