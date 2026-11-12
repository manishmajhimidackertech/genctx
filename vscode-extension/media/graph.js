// <<<GENCTX
// FILE: vscode-extension/media/graph.js
// ROLE: Code graph webview — force-directed layout (Barnes-Hut), canvas drawing, pan/zoom/drag, hover, search, local graph and colour modes
// EXPORTS: NONE (runs in the webview)
// IMPORTS: vscode-extension/media/graph-model.js
// USED BY: vscode-extension/src/graphHtml.ts
// NOTES: Simulates only the visible nodes and stops when the layout settles, so an idle graph costs nothing; positions survive refreshes
// GENCTX>>>

(function () {
  "use strict";

  const M = window.GraphModel;
  const vscode =
    typeof acquireVsCodeApi === "function"
      ? acquireVsCodeApi() // eslint-disable-line no-undef
      : { postMessage() {}, getState() { return null; }, setState() {} };

  // ── Elements ────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const canvas = $("graph");
  const ctx = canvas.getContext("2d");
  const ui = {
    search: $("search"),
    local: $("local"),
    depth: $("depth"),
    depthValue: $("depthValue"),
    follow: $("follow"),
    orphans: $("orphans"),
    arrows: $("arrows"),
    colour: $("colour"),
    stats: $("stats"),
    fit: $("fit"),
    refresh: $("refresh"),
    legend: $("legend"),
    tooltip: $("tooltip"),
    message: $("message"),
  };

  // ── State ───────────────────────────────────────────────────────────────
  /** Above this many files the view opens on the active file's neighbourhood. */
  const LOCAL_BY_DEFAULT_ABOVE = 3000;
  /** Labels for every visible node only below this many. */
  const ALL_LABELS_BELOW = 1500;

  const saved = vscode.getState() || {};
  const settings = Object.assign(
    { local: false, depth: 2, follow: true, orphans: true, arrows: true, colour: "folder" },
    saved.settings || {}
  );
  let userChoseLocal = saved.userChoseLocal || false;

  let data = null; // { root, nodes, edges }
  let index = null; // M.buildIndex(data)
  let sim = []; // per node: { x, y, vx, vy, fx, fy }
  let visible = new Set();
  let visibleList = [];
  let visibleLinks = [];
  let linkCount = []; // per node, links among visible nodes
  let colours = []; // per node
  let focusId = null;
  let focus = -1;
  let hover = -1;
  let hits = new Set();
  const positions = new Map(); // id → {x, y}, kept across refreshes

  const view = { x: 0, y: 0, k: 1 };
  let alpha = 0;
  const ALPHA_MIN = 0.002;
  /** Cooling per step: ~320 steps for a normal graph, fewer for a huge one. */
  function alphaDecay() {
    const steps = visibleList.length > 5000 ? 140 : visibleList.length > 2000 ? 220 : 320;
    return 1 - Math.pow(ALPHA_MIN, 1 / steps);
  }
  let alphaTarget = 0;
  let frameRequested = false;
  let dirty = true;
  let fitAfterSettle = false;

  // ── Theme ───────────────────────────────────────────────────────────────
  let theme = readTheme();
  function readTheme() {
    const css = getComputedStyle(document.body);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const dark =
      document.body.classList.contains("vscode-dark") ||
      document.body.classList.contains("vscode-high-contrast") ||
      (!document.body.classList.contains("vscode-light") &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    return {
      dark,
      bg: v("--vscode-editor-background", dark ? "#1e1e1e" : "#ffffff"),
      fg: v("--vscode-editor-foreground", dark ? "#d4d4d4" : "#1f1f1f"),
      muted: v("--vscode-descriptionForeground", dark ? "#9d9d9d" : "#6b6b6b"),
      accent: v("--vscode-focusBorder", dark ? "#3794ff" : "#005fb8"),
      link: dark ? "rgba(160,160,170,0.28)" : "rgba(80,80,90,0.22)",
      linkHot: v("--vscode-focusBorder", dark ? "#3794ff" : "#005fb8"),
      font: v("--vscode-font-family", "system-ui, sans-serif"),
    };
  }
  new MutationObserver(() => {
    theme = readTheme();
    recolour();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // ── Messages from the extension ─────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "loading":
        if (!data) {
          showMessage("Scanning the project…");
        }
        break;
      case "graph":
        showMessage(null);
        if (msg.focus) {
          focusId = msg.focus;
        }
        setData(msg.data);
        break;
      case "focus":
        setFocus(msg.id, settings.follow);
        break;
      case "error":
        showMessage(msg.message, true);
        break;
    }
  });

  function showMessage(text, isError) {
    ui.message.hidden = !text;
    ui.message.textContent = text || "";
    ui.message.classList.toggle("error", !!isError);
  }

  // ── Data ────────────────────────────────────────────────────────────────
  function setData(next) {
    const first = data === null;
    const unchanged = !first && sameGraph(data, next);
    // Remember where everything was, so a refresh does not reshuffle.
    sim.forEach((p, i) => positions.set(data.nodes[i].id, { x: p.x, y: p.y }));

    data = next;
    index = M.buildIndex(data);
    const folders = new Map();
    data.nodes.forEach((n) => {
      const f = M.folderOf(n.id, 1);
      if (!folders.has(f)) {
        folders.set(f, folders.size);
      }
    });
    const spread = 12 * Math.sqrt(data.nodes.length + 1);
    sim = data.nodes.map((n) => {
      const known = positions.get(n.id);
      if (known) {
        return { x: known.x, y: known.y, vx: 0, vy: 0, fx: null, fy: null };
      }
      // New: start near files of the same folder, which converges faster
      // than a uniform scatter.
      const angle = folders.get(M.folderOf(n.id, 1)) * 2.39996;
      const r = spread * (0.5 + Math.random() * 0.6);
      return {
        x: Math.cos(angle) * r + (Math.random() - 0.5) * spread * 0.3,
        y: Math.sin(angle) * r + (Math.random() - 0.5) * spread * 0.3,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
    });

    focus = focusId !== null && index.ids.has(focusId) ? index.ids.get(focusId) : -1;
    if (first && !userChoseLocal && data.nodes.length > LOCAL_BY_DEFAULT_ABOVE && focus >= 0) {
      settings.local = true;
    }
    syncControls();
    recolour();
    // An unchanged graph (a save that changed no import) keeps its layout
    // exactly; a changed one settles from where it was.
    applyFilters(first ? 1 : unchanged ? 0 : 0.15);
    if (first) {
      fitAfterSettle = true;
      fitView(false);
    }
  }

  function sameGraph(a, b) {
    if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
    for (let i = 0; i < a.nodes.length; i++) {
      if (a.nodes[i].id !== b.nodes[i].id) return false;
    }
    for (let i = 0; i < a.edges.length; i++) {
      if (a.edges[i][0] !== b.edges[i][0] || a.edges[i][1] !== b.edges[i][1]) return false;
    }
    return true;
  }

  function recolour() {
    if (!data) {
      return;
    }
    const mode = settings.colour;
    let keys = data.nodes.map((n) => M.colourKey(n, mode, 1));
    // A project with everything under one or two top-level folders (crates/,
    // packages/, src/) is better told apart one level down.
    if (mode === "folder" && new Set(keys).size <= 3 && data.nodes.length > 20) {
      keys = data.nodes.map((n) => M.colourKey(n, mode, 2));
    }
    const counts = new Map();
    keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
    let scale;
    if (mode === "context") {
      scale = new Map([
        ["current", theme.dark ? "hsl(140, 50%, 55%)" : "hsl(140, 55%, 35%)"],
        ["stale", theme.dark ? "hsl(38, 85%, 60%)" : "hsl(35, 90%, 42%)"],
        ["missing", theme.dark ? "hsl(220, 8%, 52%)" : "hsl(220, 8%, 58%)"],
      ]);
    } else {
      const ordered = Array.from(counts.keys()).sort((a, b) => counts.get(b) - counts.get(a));
      const hues = M.palette(ordered.length, theme.dark);
      scale = new Map(ordered.map((k, i) => [k, hues[i]]));
    }
    colours = keys.map((k) => scale.get(k));
    renderLegend(scale, counts);
    requestDraw();
  }

  function renderLegend(scale, counts) {
    const entries = Array.from(scale.keys())
      .filter((k) => counts.has(k))
      .sort((a, b) => counts.get(b) - counts.get(a));
    const shown = entries.slice(0, 14);
    ui.legend.replaceChildren(
      ...shown.map((k) => {
        const row = document.createElement("div");
        row.className = "legend-row";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = scale.get(k);
        const label = document.createElement("span");
        label.textContent = `${k} (${counts.get(k)})`;
        row.append(dot, label);
        return row;
      })
    );
    if (entries.length > shown.length) {
      const more = document.createElement("div");
      more.className = "legend-row muted";
      more.textContent = `+${entries.length - shown.length} more`;
      ui.legend.append(more);
    }
  }

  function applyFilters(reheat) {
    if (!data) {
      return;
    }
    const next = M.visibleNodes(index, data.nodes.length, {
      local: settings.local,
      depth: settings.depth,
      orphans: settings.orphans,
      focus,
    });
    // Nodes that just appeared start next to a visible neighbour.
    for (const i of next) {
      if (!visible.has(i)) {
        const anchor = index.out[i].concat(index.in[i]).find((j) => visible.has(j));
        if (anchor !== undefined && !positions.has(data.nodes[i].id)) {
          sim[i].x = sim[anchor].x + (Math.random() - 0.5) * 30;
          sim[i].y = sim[anchor].y + (Math.random() - 0.5) * 30;
        }
      }
    }
    visible = next;
    visibleList = Array.from(next);
    visibleLinks = index.links.filter(([s, d]) => next.has(s) && next.has(d));
    linkCount = new Array(data.nodes.length).fill(0);
    for (const [s, d] of visibleLinks) {
      linkCount[s]++;
      linkCount[d]++;
    }
    if (hover >= 0 && !visible.has(hover)) {
      hover = -1;
      hideTooltip();
    }
    updateStats();
    heat(reheat);
  }

  function updateStats() {
    const total = data.nodes.length;
    const shown = visibleList.length;
    ui.stats.textContent =
      (shown === total ? `${total} files` : `${shown} of ${total} files`) +
      ` · ${visibleLinks.length} links` +
      (hits.size ? ` · ${hits.size} matches` : "");
  }

  // ── Focus ───────────────────────────────────────────────────────────────
  function setFocus(id, centre) {
    focusId = id;
    if (!data) {
      return;
    }
    const i = index.ids.has(id) ? index.ids.get(id) : -1;
    if (i === focus) {
      return;
    }
    focus = i;
    if (settings.local) {
      applyFilters(0.6);
      fitAfterSettle = true;
    } else if (centre && focus >= 0 && visible.has(focus)) {
      panTo(sim[focus].x, sim[focus].y);
    }
    requestDraw();
  }

  // ── Simulation ──────────────────────────────────────────────────────────
  function heat(a) {
    alpha = Math.max(alpha, a);
    requestDraw();
  }

  /** One step of the layout: repulsion, link springs, a weak pull to the centre. */
  function tick() {
    const list = visibleList;
    if (!list.length) {
      return;
    }
    alpha += (alphaTarget - alpha) * alphaDecay();

    // Repulsion between all visible nodes, approximated with a quadtree.
    const tree = buildTree(list);
    const strength = -70;
    for (const i of list) {
      applyCharge(tree, i, sim[i], strength * alpha);
    }

    // Springs along links (d3's link force: weaker for well-connected nodes).
    for (const [s, d] of visibleLinks) {
      const a = sim[s];
      const b = sim[d];
      let dx = b.x + b.vx - a.x - a.vx;
      let dy = b.y + b.vy - a.y - a.vy;
      let l = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const k = 1 / Math.min(linkCount[s], linkCount[d]);
      l = ((l - 58) / l) * alpha * k;
      dx *= l;
      dy *= l;
      const bias = linkCount[s] / (linkCount[s] + linkCount[d]);
      b.vx -= dx * bias;
      b.vy -= dy * bias;
      a.vx += dx * (1 - bias);
      a.vy += dy * (1 - bias);
    }

    // Gravity keeps disconnected files from drifting away; it is stronger
    // for them than for linked files, whose springs already hold them.
    for (const i of list) {
      const p = sim[i];
      const g = linkCount[i] ? 0.03 : 0.08;
      p.vx -= p.x * g * alpha;
      p.vy -= p.y * g * alpha;
    }

    for (const i of list) {
      const p = sim[i];
      if (p.fx !== null) {
        p.x = p.fx;
        p.y = p.fy;
        p.vx = p.vy = 0;
        continue;
      }
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  function buildTree(list) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of list) {
      const p = sim[i];
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const root = cell(x0, y0, Math.max(x1 - x0, y1 - y0) + 1);
    for (const i of list) {
      insert(root, i, 0);
    }
    accumulate(root);
    return root;
  }

  function cell(x, y, s) {
    return { x, y, s, body: -1, extra: null, kids: null, m: 0, cx: 0, cy: 0 };
  }

  function insert(c, i, depth) {
    for (;;) {
      if (c.kids === null) {
        if (c.body < 0) {
          c.body = i;
          return;
        }
        if (depth > 24) {
          // Same spot as another node: share the leaf.
          (c.extra || (c.extra = [])).push(i);
          return;
        }
        const old = c.body;
        c.body = -1;
        c.kids = [null, null, null, null];
        place(c, old);
      }
      c = place(c, i, true);
      depth++;
      if (c === null) {
        return;
      }
    }
  }

  /** Child of `c` for node `i`; with `descend`, returns it for the caller to continue. */
  function place(c, i, descend) {
    const h = c.s / 2;
    const p = sim[i];
    const right = p.x >= c.x + h ? 1 : 0;
    const down = p.y >= c.y + h ? 1 : 0;
    const q = right + 2 * down;
    if (!c.kids[q]) {
      c.kids[q] = cell(c.x + right * h, c.y + down * h, h);
    }
    if (descend) {
      return c.kids[q];
    }
    c.kids[q].body = i;
    return null;
  }

  function accumulate(c) {
    if (c.kids === null) {
      const bodies = c.extra ? [c.body].concat(c.extra) : [c.body];
      c.m = bodies.length;
      for (const b of bodies) {
        c.cx += sim[b].x;
        c.cy += sim[b].y;
      }
      c.cx /= c.m;
      c.cy /= c.m;
      return;
    }
    for (const k of c.kids) {
      if (k) {
        accumulate(k);
        c.m += k.m;
        c.cx += k.cx * k.m;
        c.cy += k.cy * k.m;
      }
    }
    c.cx /= c.m;
    c.cy /= c.m;
  }

  const THETA2 = 0.81;
  function applyCharge(c, i, p, w) {
    const dx = c.cx - p.x;
    const dy = c.cy - p.y;
    let d2 = dx * dx + dy * dy;
    if (c.kids === null) {
      const m = c.m - (c.body === i || (c.extra && c.extra.includes(i)) ? 1 : 0);
      if (m <= 0) {
        return;
      }
      if (d2 < 1) {
        // Coincident: nudge apart in a random direction.
        p.vx += (Math.random() - 0.5) * 2;
        p.vy += (Math.random() - 0.5) * 2;
        return;
      }
      if (d2 < 36) d2 = Math.sqrt(36 * d2);
      const f = (w * m) / d2;
      p.vx += dx * f;
      p.vy += dy * f;
      return;
    }
    if ((c.s * c.s) / THETA2 < d2) {
      if (d2 < 36) d2 = Math.sqrt(36 * d2);
      const f = (w * c.m) / d2;
      p.vx += dx * f;
      p.vy += dy * f;
      return;
    }
    for (const k of c.kids) {
      if (k) {
        applyCharge(k, i, p, w);
      }
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────────
  function requestDraw() {
    dirty = true;
    if (!frameRequested) {
      frameRequested = true;
      requestAnimationFrame(frame);
    }
  }

  const perf = { ticks: 0, tickMs: 0, draws: 0, drawMs: 0 };
  let lastDraw = 0;
  let drawInterval = 0;

  function frame() {
    frameRequested = false;
    if (alpha > ALPHA_MIN || alphaTarget > 0) {
      // As many steps as fit in a frame's budget, at least one.
      const start = performance.now();
      do {
        tick();
        perf.ticks++;
      } while (performance.now() - start < 14 && alpha > ALPHA_MIN);
      perf.tickMs += performance.now() - start;
      dirty = true;
      if (alpha <= ALPHA_MIN && alphaTarget === 0 && fitAfterSettle) {
        fitAfterSettle = false;
        fitView(true);
      }
    }
    // While a big layout settles, draw only every few frames so most of
    // the time goes to the layout itself; when it is still, draw at once.
    const settling = alpha > ALPHA_MIN || alphaTarget > 0;
    const now = performance.now();
    if (dirty && (!settling || animation || now - lastDraw >= drawInterval)) {
      draw();
      const cost = performance.now() - now;
      perf.draws++;
      perf.drawMs += cost;
      lastDraw = performance.now();
      drawInterval = Math.min(400, cost * 2);
      dirty = false;
    }
    if (alpha > ALPHA_MIN || alphaTarget > 0 || animation || dirty) {
      requestDraw();
    }
  }

  function radius(i) {
    // Never smaller than ~2px on screen, so a zoomed-out graph still shows
    // its colours rather than only its links.
    return Math.max(3.2 + Math.sqrt(index.degree[i]) * 1.6, 2 / view.k);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    stepAnimation();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    if (!data) {
      return;
    }
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    // The part of the world on screen (with a margin for radii and labels).
    const margin = 40 / view.k;
    const vx0 = (-w / 2 - view.x) / view.k - margin;
    const vx1 = (w / 2 - view.x) / view.k + margin;
    const vy0 = (-h / 2 - view.y) / view.k - margin;
    const vy1 = (h / 2 - view.y) / view.k + margin;
    const onScreen = (i) => {
      const p = sim[i];
      return p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1;
    };
    const linkOnScreen = (s, d) => {
      const a = sim[s];
      const b = sim[d];
      return !(
        (a.x < vx0 && b.x < vx0) ||
        (a.x > vx1 && b.x > vx1) ||
        (a.y < vy0 && b.y < vy0) ||
        (a.y > vy1 && b.y > vy1)
      );
    };
    const links = visibleLinks.filter(([s, d]) => linkOnScreen(s, d));
    const shownNodes = visibleList.filter(onScreen);
    // Huge single paths are slow to rasterise; flush every so often.
    const CHUNK = 600;

    // What to emphasise: the hovered node and its links, else search hits.
    const hot = hover >= 0 ? new Set([hover, ...index.out[hover], ...index.in[hover]]) : null;
    const dimmed = (i) => (hot ? !hot.has(i) : hits.size > 0 && !hits.has(i));

    // Links.
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = theme.link;
    ctx.globalAlpha = hot || hits.size ? 0.35 : 1;
    ctx.beginPath();
    let n = 0;
    for (const [s, d] of links) {
      if (hot && (s === hover || d === hover)) {
        continue;
      }
      ctx.moveTo(sim[s].x, sim[s].y);
      ctx.lineTo(sim[d].x, sim[d].y);
      if (++n % CHUNK === 0) {
        ctx.stroke();
        ctx.beginPath();
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const arrows = settings.arrows && view.k > 0.45 && links.length < 6000;
    if (arrows) {
      ctx.fillStyle = theme.link;
      ctx.beginPath();
      n = 0;
      for (const [s, d] of links) {
        if (!(hot && (s === hover || d === hover))) {
          arrowHead(s, d);
          if (++n % CHUNK === 0) {
            ctx.fill();
            ctx.beginPath();
          }
        }
      }
      ctx.fill();
    }
    if (hot) {
      ctx.strokeStyle = theme.linkHot;
      ctx.lineWidth = 1.6 / view.k;
      ctx.beginPath();
      for (const [s, d] of links) {
        if (s === hover || d === hover) {
          ctx.moveTo(sim[s].x, sim[s].y);
          ctx.lineTo(sim[d].x, sim[d].y);
        }
      }
      ctx.stroke();
      ctx.fillStyle = theme.linkHot;
      ctx.beginPath();
      for (const [s, d] of links) {
        if (s === hover || d === hover) {
          arrowHead(s, d);
        }
      }
      ctx.fill();
    }

    // Nodes, batched by colour.
    const batches = new Map();
    for (const i of shownNodes) {
      const key = colours[i] + (dimmed(i) ? "|dim" : "");
      if (!batches.has(key)) {
        batches.set(key, []);
      }
      batches.get(key).push(i);
    }
    for (const [key, list] of batches) {
      const [colour, dim] = key.split("|");
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.fillStyle = colour;
      ctx.beginPath();
      let count = 0;
      for (const i of list) {
        const r = radius(i);
        if (r * view.k < 2.5) {
          // Smaller than a pixel or so: a square looks the same, far cheaper.
          ctx.rect(sim[i].x - r, sim[i].y - r, r * 2, r * 2);
        } else {
          ctx.moveTo(sim[i].x + r, sim[i].y);
          ctx.arc(sim[i].x, sim[i].y, r, 0, Math.PI * 2);
        }
        if (++count % CHUNK === 0) {
          ctx.fill();
          ctx.beginPath();
        }
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Rings: the active file, and search hits.
    if (focus >= 0 && visible.has(focus)) {
      ring(focus, theme.accent, 2.4);
    }
    if (hits.size && hits.size < 400) {
      for (const i of hits) {
        if (visible.has(i)) {
          ring(i, theme.fg, 1.2);
        }
      }
    }

    // Labels: everything when zoomed in on a modest graph; otherwise only
    // what is being looked at.
    const fontPx = 11.5;
    ctx.font = `${fontPx / view.k}px ${theme.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelled = new Set();
    if (view.k >= 1.1 && shownNodes.length < ALL_LABELS_BELOW) {
      shownNodes.forEach((i) => labelled.add(i));
    } else if (view.k >= 0.7 && shownNodes.length < ALL_LABELS_BELOW) {
      shownNodes.forEach((i) => {
        if (index.degree[i] >= 4) labelled.add(i);
      });
    }
    if (hot) hot.forEach((i) => labelled.add(i));
    if (focus >= 0 && visible.has(focus)) labelled.add(focus);
    if (hits.size && hits.size < 60) hits.forEach((i) => visible.has(i) && labelled.add(i));
    for (const i of labelled) {
      if (!visible.has(i)) continue;
      const name = data.nodes[i].id.split("/").pop();
      ctx.globalAlpha = dimmed(i) && !(hot && hot.has(i)) ? 0.3 : 1;
      ctx.fillStyle = i === hover || i === focus ? theme.fg : theme.muted;
      ctx.fillText(name, sim[i].x, sim[i].y + radius(i) + 3 / view.k);
    }
    ctx.globalAlpha = 1;
  }

  function arrowHead(s, d) {
    const a = sim[s];
    const b = sim[d];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = b.x - ux * (radius(d) + 1.5);
    const tipY = b.y - uy * (radius(d) + 1.5);
    const size = 5 / Math.max(view.k, 0.8);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
    ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
    ctx.closePath();
  }

  function ring(i, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width / view.k;
    ctx.beginPath();
    ctx.arc(sim[i].x, sim[i].y, radius(i) + 3 / view.k, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── View ────────────────────────────────────────────────────────────────
  let animation = null;

  function animateView(target) {
    animation = { from: Object.assign({}, view), to: target, start: performance.now(), ms: 380 };
    requestDraw();
  }

  function stepAnimation() {
    if (!animation) return;
    const t = Math.min(1, (performance.now() - animation.start) / animation.ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    for (const key of ["x", "y", "k"]) {
      view[key] = animation.from[key] + (animation.to[key] - animation.from[key]) * e;
    }
    if (t >= 1) animation = null;
  }

  function panTo(x, y) {
    animateView({ x: -x * view.k, y: -y * view.k, k: view.k });
  }

  function fitView(animate) {
    if (!visibleList.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of visibleList) {
      const p = sim[i];
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const k = Math.min(3, Math.max(0.05, 0.88 * Math.min(w / (x1 - x0 + 60), h / (y1 - y0 + 60))));
    const target = { x: (-(x0 + x1) / 2) * k, y: (-(y0 + y1) / 2) * k, k };
    if (animate) {
      animateView(target);
    } else {
      Object.assign(view, target);
      requestDraw();
    }
  }

  function toWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (sx - rect.left - rect.width / 2 - view.x) / view.k,
      y: (sy - rect.top - rect.height / 2 - view.y) / view.k,
    };
  }

  function nodeAt(sx, sy) {
    if (!data) return -1;
    const p = toWorld(sx, sy);
    let best = -1;
    let bestD = Infinity;
    const slack = 4 / view.k;
    for (const i of visibleList) {
      const dx = sim[i].x - p.x;
      const dy = sim[i].y - p.y;
      const d = dx * dx + dy * dy;
      const r = radius(i) + slack;
      if (d <= r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  // ── Pointer ─────────────────────────────────────────────────────────────
  let press = null; // { x, y, node, moved, viewX, viewY }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const node = nodeAt(e.clientX, e.clientY);
    press = { x: e.clientX, y: e.clientY, node, moved: false, viewX: view.x, viewY: view.y };
    animation = null;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (press) {
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.moved && dx * dx + dy * dy > 9) {
        press.moved = true;
        if (press.node >= 0) {
          alphaTarget = 0.25;
          heat(0.25);
        }
      }
      if (press.moved) {
        if (press.node >= 0) {
          const p = toWorld(e.clientX, e.clientY);
          sim[press.node].fx = p.x;
          sim[press.node].fy = p.y;
        } else {
          view.x = press.viewX + dx;
          view.y = press.viewY + dy;
        }
        hideTooltip();
        requestDraw();
      }
      return;
    }
    const node = nodeAt(e.clientX, e.clientY);
    if (node !== hover) {
      hover = node;
      canvas.style.cursor = node >= 0 ? "pointer" : "default";
      requestDraw();
    }
    if (node >= 0) {
      showTooltip(node, e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!press) return;
    const { node, moved } = press;
    press = null;
    if (node >= 0) {
      sim[node].fx = null;
      sim[node].fy = null;
      alphaTarget = 0;
    }
    if (!moved && node >= 0) {
      const id = data.nodes[node].id;
      if (e.shiftKey) {
        vscode.postMessage({ type: "pack", id });
      } else {
        vscode.postMessage({ type: "open", id, beside: e.altKey });
      }
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (!press && hover >= 0) {
      hover = -1;
      hideTooltip();
      requestDraw();
    }
  });

  canvas.addEventListener("dblclick", (e) => {
    const node = nodeAt(e.clientX, e.clientY);
    if (node < 0) return;
    settings.local = true;
    userChoseLocal = true;
    syncControls();
    persist();
    setFocus(data.nodes[node].id, true);
    applyFilters(0.6);
    fitAfterSettle = true;
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      animation = null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const k = Math.min(8, Math.max(0.03, view.k * Math.exp(-e.deltaY * 0.0016)));
      // Keep the point under the cursor where it is.
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      requestDraw();
    },
    { passive: false }
  );

  window.addEventListener("resize", requestDraw);

  // ── Tooltip ─────────────────────────────────────────────────────────────
  function showTooltip(i, sx, sy) {
    const n = data.nodes[i];
    const t = ui.tooltip;
    const title = document.createElement("div");
    title.className = "tt-title";
    title.textContent = n.id;
    const parts = [title];
    if (n.role) {
      const role = document.createElement("div");
      role.className = "tt-role";
      role.textContent = n.role;
      parts.push(role);
    }
    const meta = document.createElement("div");
    meta.className = "tt-meta";
    const state = { current: "context current", stale: "context stale", missing: "no context yet" }[
      n.context
    ];
    meta.textContent =
      `${n.lang} · ${n.lines} lines · ${state}\n` +
      `imports ${index.out[i].length} · imported by ${index.in[i].length}`;
    parts.push(meta);
    t.replaceChildren(...parts);
    t.hidden = false;
    const pad = 14;
    const maxX = window.innerWidth - t.offsetWidth - 8;
    const maxY = window.innerHeight - t.offsetHeight - 8;
    t.style.left = `${Math.min(sx + pad, maxX)}px`;
    t.style.top = `${Math.min(sy + pad, maxY)}px`;
  }

  function hideTooltip() {
    ui.tooltip.hidden = true;
  }

  // ── Controls ────────────────────────────────────────────────────────────
  function syncControls() {
    ui.local.checked = settings.local;
    ui.depth.value = String(settings.depth);
    ui.depthValue.textContent = String(settings.depth);
    ui.depth.disabled = !settings.local;
    ui.follow.checked = settings.follow;
    ui.orphans.checked = settings.orphans;
    ui.arrows.checked = settings.arrows;
    ui.colour.value = settings.colour;
  }

  function persist() {
    vscode.setState({ settings, userChoseLocal });
  }

  ui.local.addEventListener("change", () => {
    settings.local = ui.local.checked;
    userChoseLocal = true;
    syncControls();
    persist();
    applyFilters(0.5);
    fitAfterSettle = true;
  });
  ui.depth.addEventListener("input", () => {
    settings.depth = Number(ui.depth.value);
    ui.depthValue.textContent = ui.depth.value;
    persist();
    applyFilters(0.5);
    fitAfterSettle = true;
  });
  ui.follow.addEventListener("change", () => {
    settings.follow = ui.follow.checked;
    persist();
  });
  ui.orphans.addEventListener("change", () => {
    settings.orphans = ui.orphans.checked;
    persist();
    applyFilters(0.3);
  });
  ui.arrows.addEventListener("change", () => {
    settings.arrows = ui.arrows.checked;
    persist();
    requestDraw();
  });
  ui.colour.addEventListener("change", () => {
    settings.colour = ui.colour.value;
    persist();
    recolour();
  });
  ui.fit.addEventListener("click", () => fitView(true));
  ui.refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));

  ui.search.addEventListener("input", () => {
    hits = data ? M.searchNodes(data.nodes, ui.search.value) : new Set();
    updateStats();
    requestDraw();
  });
  ui.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = Array.from(hits).find((i) => visible.has(i));
      if (first !== undefined) {
        animateView({ x: -sim[first].x * 2, y: -sim[first].y * 2, k: 2 });
      }
    } else if (e.key === "Escape") {
      ui.search.value = "";
      hits = new Set();
      updateStats();
      requestDraw();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== ui.search) {
      e.preventDefault();
      ui.search.focus();
    }
  });

  // Read-only hooks for the browser test (tests/graphView.browser.js).
  if (window.__GENCTX_TEST__) {
    window.__genctxGraph = {
      state: () => ({
        visible: visibleList.length,
        links: visibleLinks.length,
        settled: alpha <= ALPHA_MIN && !animation,
        alpha,
        ticks: perf.ticks,
        tickMs: perf.ticks ? perf.tickMs / perf.ticks : 0,
        drawMs: perf.draws ? perf.drawMs / perf.draws : 0,
        draws: perf.draws,
        drawTotal: perf.drawMs,
        focus: focus >= 0 ? data.nodes[focus].id : null,
        hover: hover >= 0 ? data.nodes[hover].id : null,
        hits: hits.size,
        k: view.k,
      }),
      screenPos(id) {
        const i = index.ids.get(id);
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2 + view.x + sim[i].x * view.k,
          y: rect.top + rect.height / 2 + view.y + sim[i].y * view.k,
        };
      },
    };
  }

  syncControls();
  requestDraw();
  vscode.postMessage({ type: "ready" });
})();
