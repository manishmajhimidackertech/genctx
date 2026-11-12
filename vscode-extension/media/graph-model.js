// <<<GENCTX
// FILE: vscode-extension/media/graph-model.js
// ROLE: Pure graph logic for the code graph view - adjacency index, local neighbourhoods, search, filtering, colour keys
// EXPORTS: buildIndex(), neighbourhood(), visibleNodes(), searchNodes(), colourKey(), folderOf(), palette()
// IMPORTS: NONE
// USED BY: vscode-extension/media/graph.js, vscode-extension/tests/graphModel.test.js
// NOTES: No DOM and no VS Code API, so it runs in the webview and under node --test alike (UMD wrapper)
// GENCTX>>>

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GraphModel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Adjacency lists for `data` ({ nodes: [{id, ...}], edges: [[src, dst]] }).
   * Edges naming unknown nodes are dropped.
   */
  function buildIndex(data) {
    const ids = new Map();
    data.nodes.forEach((n, i) => ids.set(n.id, i));
    const out = data.nodes.map(() => []);
    const inc = data.nodes.map(() => []);
    const links = [];
    for (const [src, dst] of data.edges) {
      const s = ids.get(src);
      const d = ids.get(dst);
      if (s === undefined || d === undefined || s === d) {
        continue;
      }
      out[s].push(d);
      inc[d].push(s);
      links.push([s, d]);
    }
    const degree = out.map((o, i) => o.length + inc[i].length);
    return { ids, out, in: inc, links, degree };
  }

  /** Nodes within `depth` links of `focus` (either direction), as a Set of indices. */
  function neighbourhood(index, focus, depth) {
    const seen = new Set([focus]);
    let frontier = [focus];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next = [];
      for (const i of frontier) {
        for (const j of index.out[i].concat(index.in[i])) {
          if (!seen.has(j)) {
            seen.add(j);
            next.push(j);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }

  /**
   * Indices of the nodes to show.
   *  - local: only the neighbourhood of `focus` (when there is a focus);
   *  - orphans: false hides files without any link (the focus always shows).
   */
  function visibleNodes(index, count, opts) {
    const focus = opts.focus === undefined ? -1 : opts.focus;
    let base;
    if (opts.local && focus >= 0) {
      base = neighbourhood(index, focus, Math.max(1, opts.depth || 1));
    } else {
      base = new Set();
      for (let i = 0; i < count; i++) {
        base.add(i);
      }
    }
    if (!opts.orphans) {
      for (const i of Array.from(base)) {
        if (index.degree[i] === 0 && i !== focus) {
          base.delete(i);
        }
      }
    }
    return base;
  }

  /** Indices of nodes whose path or role contains `query` (case-insensitive). */
  function searchNodes(nodes, query) {
    const q = (query || "").trim().toLowerCase();
    const hits = new Set();
    if (!q) {
      return hits;
    }
    nodes.forEach((n, i) => {
      if (n.id.toLowerCase().includes(q) || (n.role || "").toLowerCase().includes(q)) {
        hits.add(i);
      }
    });
    return hits;
  }

  /** The first `levels` directories of a path (`(root)` for top-level files). */
  function folderOf(id, levels) {
    const parts = id.split("/");
    parts.pop();
    if (!parts.length) {
      return "(root)";
    }
    return parts.slice(0, Math.max(1, levels)).join("/");
  }

  /** What a node is coloured by in each colour mode (`levels`: folder depth). */
  function colourKey(node, mode, levels) {
    switch (mode) {
      case "language":
        return node.lang || "other";
      case "context":
        return node.context || "missing";
      default:
        return folderOf(node.id, levels || 1);
    }
  }

  /**
   * `n` well-separated hues (golden-angle steps), as CSS colours. Lightness
   * suits the theme: lighter on dark backgrounds.
   */
  function palette(n, dark) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const hue = Math.round((i * 137.508 + 200) % 360);
      out.push(`hsl(${hue}, 62%, ${dark ? 64 : 44}%)`);
    }
    return out;
  }

  return { buildIndex, neighbourhood, visibleNodes, searchNodes, colourKey, folderOf, palette };
});
