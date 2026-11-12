// <<<GENCTX
// FILE: crates/core/src/graph.rs
// ROLE: Static dependency graph — scans imports without an LLM, keeps the files/deps tables in the store current, and serves the graph
// EXPORTS: scan_file(), language(), sync(), record(), load(), dependency_map(), Scan, FileSet, Graph, GraphNode, SyncStats, GraphError, MAX_SCAN_BYTES
// IMPORTS: crates/core/src/store.rs, crates/core/src/config.rs, crates/core/src/filter.rs
// USED BY: crates/core/src/process.rs, crates/core/src/pack.rs, crates/cli/src/main.rs, crates/cli/src/mcp.rs
// NOTES: Pure text scanning plus file-existence probes, so it is fast enough to run over a whole project on every request; incremental by (mtime, size)
// GENCTX>>>

//! The project's dependency graph, built by reading import statements.
//!
//! No model is involved: each supported language has a small scanner that
//! finds import statements and resolves them to files of the project by
//! probing the paths the language would look at. That makes the whole map
//! available in seconds — long before Ollama has described a single file —
//! and it is what feeds:
//!
//! - the graph view in the VS Code extension (`genctx graph --json`);
//! - `USED BY` and `pack --with-imports`, now index lookups in the store;
//! - Ollama generation, which is handed the imports instead of being asked
//!   to work them out (less to generate, nothing to get wrong).
//!
//! The graph lives in the same SQLite store as the context (`files`, `deps`
//! and `waits` tables; see `store.rs`). [`sync`] brings it up to date by
//! re-reading only files whose size or modification time changed.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::UNIX_EPOCH,
};

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use thiserror::Error;

use crate::{
    config, filter,
    process::content_hash,
    store::{self, ContextStore, StoreError, CONTEXT_VERSION, DEP_SCANNED},
};

/// Files larger than this are graph nodes but are not scanned for imports
/// (generated bundles, data dumps).
pub const MAX_SCAN_BYTES: u64 = 1024 * 1024;

/// Bump whenever a scanner changes what it finds: the next [`sync`] then
/// rescans every file instead of trusting edges an older scanner recorded.
const SCANNER_VERSION: &str = "1";

/// `files.lang` for files that are not UTF-8 text. Kept so they are not
/// re-read on every sync, but never shown.
const BINARY: &str = "binary";

#[derive(Debug, Error)]
pub enum GraphError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("could not walk the project: {0}")]
    Walk(String),
}

// ── Scanning ────────────────────────────────────────────────────────────────

/// The result of scanning one file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    /// Language name, from the extension (`rust`, `python`, …, `other`).
    pub lang: &'static str,
    /// Project files this one imports, root-relative and sorted. `None`
    /// when there is no scanner for the language — "unknown", not "none".
    pub imports: Option<Vec<String>>,
    /// Paths that would satisfy an import that could not be resolved yet
    /// (a directory, for Go, ends in `/`). If one of them appears later,
    /// this file is scanned again.
    pub waits: Vec<String>,
}

/// The project's files, when they are already known (a full sync). Without
/// one, the scanner asks the file system.
#[derive(Debug, Default)]
pub struct FileSet {
    files: HashSet<String>,
    dirs: HashMap<String, Vec<String>>,
    /// Workspace crates, read once per sync rather than once per file.
    rust_crates: OnceLock<HashMap<String, String>>,
    /// `module` line of each go.mod, by its directory.
    go_modules: std::sync::Mutex<HashMap<String, Option<String>>>,
}

impl FileSet {
    pub fn new<I: IntoIterator<Item = String>>(paths: I) -> Self {
        let mut set = Self::default();
        for p in paths {
            let mut dir = parent_of(&p).to_string();
            set.dirs.entry(dir.clone()).or_default().push(p.clone());
            // Register every ancestor so `dir_exists` works for packages
            // that only contain sub-directories.
            while !dir.is_empty() {
                dir = parent_of(&dir).to_string();
                set.dirs.entry(dir.clone()).or_default();
            }
            set.files.insert(p);
        }
        set
    }
}

/// Scan `source` (the content of `rel_path`, under `root`) for imports of
/// other project files.
///
/// Never panics: a scanner bug on some unusual file costs that file its
/// edges, not the whole sync.
pub fn scan_file(root: &Path, rel_path: &str, source: &str, known: Option<&FileSet>) -> Scan {
    let run = std::panic::AssertUnwindSafe(|| scan_file_inner(root, rel_path, source, known));
    std::panic::catch_unwind(run).unwrap_or_else(|_| Scan {
        lang: language(rel_path),
        imports: None,
        waits: Vec::new(),
    })
}

fn scan_file_inner(root: &Path, rel_path: &str, source: &str, known: Option<&FileSet>) -> Scan {
    let lang = language(rel_path);
    let ctx = Ctx {
        root,
        known,
        rel_path,
        dir: parent_of(rel_path),
    };
    let mut out = Out::default();
    let supported = match lang {
        "javascript" | "typescript" | "vue" | "svelte" => {
            scan_js(&ctx, source, &mut out);
            true
        }
        "css" => {
            scan_css(&ctx, source, &mut out);
            true
        }
        "html" => {
            scan_html(&ctx, source, &mut out);
            true
        }
        "markdown" => {
            scan_markdown(&ctx, source, &mut out);
            true
        }
        "python" => {
            scan_python(&ctx, source, &mut out);
            true
        }
        "rust" => {
            scan_rust(&ctx, source, &mut out);
            true
        }
        "go" => {
            scan_go(&ctx, source, &mut out);
            true
        }
        "java" | "kotlin" | "scala" | "groovy" => {
            scan_jvm(&ctx, source, &mut out);
            true
        }
        "c" | "cpp" | "objc" => {
            scan_c(&ctx, source, &mut out);
            true
        }
        "ruby" => {
            scan_ruby(&ctx, source, &mut out);
            true
        }
        "php" => {
            scan_php(&ctx, source, &mut out);
            true
        }
        _ => false,
    };
    out.imports.remove(rel_path);
    Scan {
        lang,
        imports: supported.then(|| out.imports.into_iter().collect()),
        waits: out.waits.into_iter().collect(),
    }
}

/// Language name for a path, from its extension.
pub fn language(rel_path: &str) -> &'static str {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "rs" => "rust",
        "py" | "pyi" => "python",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "vue" => "vue",
        "svelte" => "svelte",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "groovy" | "gradle" => "groovy",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "ipp" => "cpp",
        "m" | "mm" => "objc",
        "cs" => "csharp",
        "swift" => "swift",
        "rb" => "ruby",
        "php" => "php",
        "css" | "scss" | "sass" | "less" => "css",
        "html" | "htm" => "html",
        "md" | "markdown" | "mdx" => "markdown",
        "json" | "jsonc" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" | "zsh" | "fish" | "ps1" => "shell",
        "sql" => "sql",
        _ => "other",
    }
}

struct Ctx<'a> {
    root: &'a Path,
    known: Option<&'a FileSet>,
    rel_path: &'a str,
    /// Directory of `rel_path` (`""` at the root).
    dir: &'a str,
}

impl Ctx<'_> {
    fn is_file(&self, rel: &str) -> bool {
        match self.known {
            Some(k) => k.files.contains(rel),
            None => !rel.is_empty() && self.root.join(rel).is_file(),
        }
    }

    fn is_dir(&self, rel: &str) -> bool {
        match self.known {
            Some(k) => k.dirs.contains_key(rel),
            None => self.root.join(rel).is_dir(),
        }
    }

    /// Files directly inside `dir`.
    fn files_in(&self, dir: &str) -> Vec<String> {
        match self.known {
            Some(k) => k.dirs.get(dir).cloned().unwrap_or_default(),
            None => std::fs::read_dir(self.root.join(dir))
                .map(|rd| {
                    rd.filter_map(Result::ok)
                        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                        .map(|e| join(dir, &e.file_name().to_string_lossy()))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(rel)).ok()
    }
}

#[derive(Default)]
struct Out {
    imports: BTreeSet<String>,
    waits: BTreeSet<String>,
}

impl Out {
    /// Link to the first candidate that exists. If none does and `local` is
    /// set (the import certainly names a project file), wait for them all.
    fn first(&mut self, ctx: &Ctx, candidates: &[String], local: bool) -> bool {
        if let Some(hit) = candidates.iter().find(|c| ctx.is_file(c)) {
            self.imports.insert(hit.clone());
            return true;
        }
        if local {
            self.waits.extend(candidates.iter().cloned());
        }
        false
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

/// Blank out whole-line comments starting with any of `prefixes`, so a
/// commented-out import is not a dependency. Trailing comments are left
/// alone; they rarely hold an import.
fn without_comment_lines(source: &str, prefixes: &[&str]) -> String {
    source
        .lines()
        .map(|l| {
            let t = l.trim_start();
            if prefixes.iter().any(|p| t.starts_with(p)) {
                ""
            } else {
                l
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────────

const JS_EXTS: &[&str] = &[
    ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
    ".json",
];

fn scan_js(ctx: &Ctx, source: &str, out: &mut Out) {
    static FROM: OnceLock<Regex> = OnceLock::new();
    static CALL: OnceLock<Regex> = OnceLock::new();
    let text = without_comment_lines(source, &["//", "*", "/*"]);
    let from = re(&FROM, r#"\b(?:from|import)\s*['"]([^'"\n]+)['"]"#);
    let call = re(
        &CALL,
        r#"\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)"#,
    );
    for cap in from.captures_iter(&text).chain(call.captures_iter(&text)) {
        let spec = cap[1].split(['?', '#']).next().unwrap_or("");
        let base = if let Some(rest) = spec.strip_prefix("@/").or_else(|| spec.strip_prefix("~/")) {
            normalize("src", rest)
        } else if spec.starts_with("./") || spec.starts_with("../") {
            normalize(ctx.dir, spec)
        } else if let Some(rest) = spec.strip_prefix('/') {
            normalize("", rest)
        } else {
            None // a package
        };
        let Some(base) = base else { continue };
        out.first(ctx, &js_candidates(&base), true);
    }
}

fn js_candidates(base: &str) -> Vec<String> {
    let mut c = vec![base.to_string()];
    let name = base.rsplit('/').next().unwrap_or(base);
    let has_ext = name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && JS_EXTS.contains(&format!(".{ext}").as_str())
            || matches!(
                ext,
                "css" | "scss" | "sass" | "less" | "svg" | "png" | "html"
            )
    });
    if has_ext {
        // `./x.js` may be written for a TypeScript `./x.ts` (ESM style),
        // or be described by a `./x.d.ts`.
        for (js, alts) in [
            (".js", &[".ts", ".tsx", ".d.ts"][..]),
            (".jsx", &[".tsx"][..]),
            (".mjs", &[".mts", ".d.mts"][..]),
            (".cjs", &[".cts", ".d.cts"][..]),
        ] {
            if let Some(stem) = base.strip_suffix(js) {
                c.extend(alts.iter().map(|a| format!("{stem}{a}")));
            }
        }
        return c;
    }
    c.extend(JS_EXTS.iter().map(|e| format!("{base}{e}")));
    c.extend(
        [".ts", ".tsx", ".js", ".jsx"]
            .iter()
            .map(|e| format!("{base}/index{e}")),
    );
    c
}

// ── CSS / SCSS / Less ───────────────────────────────────────────────────────

fn scan_css(ctx: &Ctx, source: &str, out: &mut Out) {
    static IMPORT: OnceLock<Regex> = OnceLock::new();
    let import = re(
        &IMPORT,
        r#"@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"\n]+)['"]"#,
    );
    for cap in import.captures_iter(source) {
        let spec = &cap[1];
        if spec.contains(':') || spec.starts_with("//") || spec.starts_with('~') {
            continue; // URL, `sass:math`, or a package
        }
        let Some(base) = (match spec.strip_prefix('/') {
            Some(rest) => normalize("", rest),
            None => normalize(ctx.dir, spec),
        }) else {
            continue;
        };
        let (dir, name) = split_last(&base);
        let mut c = vec![base.clone()];
        for ext in [".scss", ".sass", ".css", ".less"] {
            c.push(format!("{base}{ext}"));
            c.push(join(dir, &format!("_{name}{ext}")));
        }
        c.push(format!("{base}/_index.scss"));
        c.push(format!("{base}/index.scss"));
        out.first(ctx, &c, true);
    }
}

// ── HTML / Markdown (links between files, as in a notes graph) ──────────────

fn scan_html(ctx: &Ctx, source: &str, out: &mut Out) {
    static LINK: OnceLock<Regex> = OnceLock::new();
    let link = re(&LINK, r#"\b(?:src|href)\s*=\s*['"]([^'"\n]+)['"]"#);
    for cap in link.captures_iter(source) {
        link_path(ctx, &cap[1], out);
    }
}

fn scan_markdown(ctx: &Ctx, source: &str, out: &mut Out) {
    static LINK: OnceLock<Regex> = OnceLock::new();
    let link = re(&LINK, r#"\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)"#);
    for cap in link.captures_iter(source) {
        link_path(ctx, &cap[1], out);
    }
}

/// A relative link to another file (no URLs, anchors or queries).
fn link_path(ctx: &Ctx, spec: &str, out: &mut Out) {
    let spec = spec.split(['?', '#']).next().unwrap_or("");
    if spec.is_empty() || spec.contains(':') || spec.starts_with("//") {
        return;
    }
    let target = match spec.strip_prefix('/') {
        Some(rest) => normalize("", rest),
        None => normalize(ctx.dir, spec),
    };
    if let Some(t) = target {
        out.first(ctx, &[t], false);
    }
}

// ── Python ──────────────────────────────────────────────────────────────────

fn scan_python(ctx: &Ctx, source: &str, out: &mut Out) {
    static IMPORT: OnceLock<Regex> = OnceLock::new();
    static FROM: OnceLock<Regex> = OnceLock::new();
    let import = re(&IMPORT, r"^import\s+(.+)$");
    let from = re(&FROM, r"^from\s+(\.*)([\w.]*)\s+import\s+(.+)$");
    let bases = python_bases(ctx);

    for stmt in logical_lines(source, '#') {
        if let Some(cap) = import.captures(&stmt) {
            for module in cap[1].split(',') {
                let module = module.split_whitespace().next().unwrap_or("");
                let parts: Vec<&str> = module.split('.').filter(|p| !p.is_empty()).collect();
                if !parts.is_empty() {
                    python_absolute(ctx, &bases, &parts, out);
                }
            }
        } else if let Some(cap) = from.captures(&stmt) {
            let dots = cap[1].len();
            let module: Vec<&str> = cap[2].split('.').filter(|p| !p.is_empty()).collect();
            let names: Vec<String> = cap[3]
                .replace(['(', ')'], "")
                .split(',')
                .filter_map(|n| n.split_whitespace().next().map(str::to_string))
                .filter(|n| n != "*")
                .collect();

            if dots == 0 {
                // `from pkg import sub` may name a submodule; else the module.
                let found = names.iter().fold(false, |found, name| {
                    let mut parts = module.clone();
                    parts.push(name);
                    python_resolve(ctx, &bases, &parts, None, out) || found
                });
                if !found {
                    python_absolute(ctx, &bases, &module, out);
                }
            } else {
                // Relative: one dot is this package, each more goes up one.
                let mut base = ctx.dir.to_string();
                for _ in 1..dots {
                    if base.is_empty() {
                        break;
                    }
                    base = parent_of(&base).to_string();
                }
                let bases = [base];
                let found = names.iter().fold(false, |found, name| {
                    let mut parts = module.clone();
                    parts.push(name);
                    python_resolve(ctx, &bases, &parts, None, out) || found
                });
                if !found {
                    if module.is_empty() {
                        out.first(ctx, &[join(&bases[0], "__init__.py")], false);
                    } else {
                        python_resolve(ctx, &bases, &module, Some(true), out);
                    }
                }
            }
        }
    }
}

/// Directories an absolute import may be relative to: the project root,
/// `src/`, and the directory above this file's top-level package.
fn python_bases(ctx: &Ctx) -> Vec<String> {
    let mut bases = vec![String::new(), "src".to_string()];
    let mut dir = ctx.dir.to_string();
    while !dir.is_empty() && ctx.is_file(&join(&dir, "__init__.py")) {
        dir = parent_of(&dir).to_string();
    }
    if !bases.contains(&dir) {
        bases.push(dir);
    }
    // A file outside any package imports its neighbours directly.
    if !bases.iter().any(|b| b == ctx.dir) {
        bases.push(ctx.dir.to_string());
    }
    bases
}

/// `import a.b.c`: wait for it only when `a` exists in the project — that
/// filters out the standard library and installed packages.
fn python_absolute(ctx: &Ctx, bases: &[String], parts: &[&str], out: &mut Out) {
    let local = bases.iter().any(|b| {
        let first = join(b, parts[0]);
        ctx.is_dir(&first) || ctx.is_file(&format!("{first}.py"))
    });
    python_resolve(ctx, bases, parts, Some(local), out);
}

/// Link `parts` as a module under any of `bases`. `wait`: `None` never
/// waits; otherwise waits when unresolved and the flag is set.
fn python_resolve(
    ctx: &Ctx,
    bases: &[String],
    parts: &[&str],
    wait: Option<bool>,
    out: &mut Out,
) -> bool {
    let path = parts.join("/");
    let candidates: Vec<String> = bases
        .iter()
        .flat_map(|b| {
            let p = join(b, &path);
            [
                format!("{p}.py"),
                format!("{p}.pyi"),
                format!("{p}/__init__.py"),
            ]
        })
        .collect();
    out.first(ctx, &candidates, wait.unwrap_or(false))
}

// ── Rust ────────────────────────────────────────────────────────────────────

fn scan_rust(ctx: &Ctx, source: &str, out: &mut Out) {
    static MOD: OnceLock<Regex> = OnceLock::new();
    static USE: OnceLock<Regex> = OnceLock::new();
    let module_decl = re(
        &MOD,
        r"^(?:pub(?:\([^)]*\))?\s+)?mod\s+(r#)?([A-Za-z_][A-Za-z0-9_]*)\s*;",
    );
    let use_stmt = re(&USE, r"^(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);");

    let layout = RustLayout::of(ctx);
    let statements = logical_statements(source);
    let mut child_mods = HashSet::new();

    for (indented, stmt) in &statements {
        if *indented {
            continue; // `mod x;` only appears at the top level of a file
        }
        if let Some(cap) = module_decl.captures(stmt) {
            let name = &cap[2];
            child_mods.insert(name.to_string());
            let c = [
                join(&layout.mod_dir, &format!("{name}.rs")),
                join(&layout.mod_dir, &format!("{name}/mod.rs")),
            ];
            out.first(ctx, &c, true);
        }
    }

    let owned;
    let crates = match ctx.known {
        Some(k) => k.rust_crates.get_or_init(|| rust_crates(ctx)),
        None => {
            owned = rust_crates(ctx);
            &owned
        }
    };
    for (indented, stmt) in &statements {
        let Some(cap) = use_stmt.captures(stmt) else {
            continue;
        };
        // Inside an inline module (`mod tests { use super::*; }`) `super`
        // is this file's own module, one level down from usual.
        let nested = usize::from(*indented);
        for path in expand_use_tree(&cap[1]) {
            let segs: Vec<&str> = path.split("::").filter(|s| !s.is_empty()).collect();
            let Some(first) = segs.first() else { continue };
            let (src_root, mut module): (String, Vec<&str>) = match *first {
                "crate" => (layout.src_root.clone(), segs[1..].to_vec()),
                "self" => {
                    let mut m: Vec<&str> = layout.module.iter().map(String::as_str).collect();
                    m.extend(&segs[1..]);
                    (layout.src_root.clone(), m)
                }
                "super" => {
                    let ups = segs.iter().take_while(|s| **s == "super").count();
                    let levels = ups.saturating_sub(nested);
                    let mut m: Vec<&str> = layout.module.iter().map(String::as_str).collect();
                    m.truncate(m.len().saturating_sub(levels));
                    m.extend(&segs[ups..]);
                    (layout.src_root.clone(), m)
                }
                name if child_mods.contains(name) => {
                    let mut m: Vec<&str> = layout.module.iter().map(String::as_str).collect();
                    m.extend(&segs);
                    (layout.src_root.clone(), m)
                }
                name => match crates.get(name) {
                    Some(dir) => (join(dir, "src"), segs[1..].to_vec()),
                    None => continue, // std or an external crate
                },
            };
            // Paths end in items, not modules: link the deepest module file
            // that exists, down to the crate root.
            let mut linked = false;
            while !module.is_empty() {
                let p = join(&src_root, &module.join("/"));
                if out.first(ctx, &[format!("{p}.rs"), format!("{p}/mod.rs")], false) {
                    linked = true;
                    break;
                }
                module.pop();
            }
            if !linked {
                let roots = [join(&src_root, "lib.rs"), join(&src_root, "main.rs")];
                out.first(ctx, &roots, false);
            }
        }
    }
}

/// Where a Rust file sits in its crate's module tree.
struct RustLayout {
    /// `src/` of the crate (or the crate-root file's directory for tests,
    /// examples, benches and `src/bin/*`).
    src_root: String,
    /// Module path of the file below `src_root`.
    module: Vec<String>,
    /// Directory `mod x;` declarations in this file resolve against.
    mod_dir: String,
}

impl RustLayout {
    fn of(ctx: &Ctx) -> Self {
        let file = ctx.rel_path;
        let name = file.rsplit('/').next().unwrap_or(file);
        let stem = name.strip_suffix(".rs").unwrap_or(name);

        // The crate directory: the nearest ancestor holding a Cargo.toml.
        let mut crate_dir = ctx.dir.to_string();
        loop {
            if ctx.is_file(&join(&crate_dir, "Cargo.toml")) || crate_dir.is_empty() {
                break;
            }
            crate_dir = parent_of(&crate_dir).to_string();
        }
        let src = join(&crate_dir, "src");
        let bin = join(&src, "bin");

        let crate_root_file = matches!(stem, "lib" | "main" | "mod" | "build")
            || ctx.dir == bin
            || !(ctx.dir == src || ctx.dir.starts_with(&format!("{src}/")));
        let mod_dir = if crate_root_file {
            ctx.dir.to_string()
        } else {
            join(ctx.dir, stem)
        };

        let in_src = ctx.dir == src || ctx.dir.starts_with(&format!("{src}/"));
        let (src_root, module) =
            if in_src && ctx.dir != bin && !ctx.dir.starts_with(&format!("{bin}/")) {
                let below = ctx
                    .dir
                    .strip_prefix(&src)
                    .unwrap_or("")
                    .trim_start_matches('/');
                let mut module: Vec<String> = below
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                if !matches!(stem, "lib" | "main" | "mod") {
                    module.push(stem.to_string());
                }
                (src, module)
            } else {
                // A crate root of its own: tests/x.rs, examples/x.rs, src/bin/x.rs.
                (ctx.dir.to_string(), Vec::new())
            };
        Self {
            src_root,
            module,
            mod_dir,
        }
    }
}

/// Workspace crates by the name code uses for them (`-` becomes `_`),
/// mapped to their directory.
fn rust_crates(ctx: &Ctx) -> HashMap<String, String> {
    let mut crates = HashMap::new();
    let Some(root_manifest) = ctx.read("Cargo.toml") else {
        return crates;
    };
    let mut dirs = vec![String::new()];
    for member in toml_string_array(&root_manifest, "members") {
        if let Some(parent) = member.strip_suffix("/*") {
            if let Ok(rd) = std::fs::read_dir(ctx.root.join(parent)) {
                for e in rd.filter_map(Result::ok) {
                    dirs.push(join(parent, &e.file_name().to_string_lossy()));
                }
            }
        } else {
            dirs.push(member.trim_end_matches('/').to_string());
        }
    }
    for dir in dirs {
        let manifest = if dir.is_empty() {
            Some(root_manifest.clone())
        } else {
            ctx.read(&join(&dir, "Cargo.toml"))
        };
        if let Some(name) = manifest.as_deref().and_then(package_name) {
            crates.insert(name.replace('-', "_"), dir);
        }
    }
    crates
}

/// `name = "…"` from a Cargo.toml's `[package]` table.
fn package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
        } else if in_package {
            if let Some(rest) = t.strip_prefix("name") {
                let v = rest.trim_start().strip_prefix('=')?.trim();
                return Some(v.trim_matches('"').to_string());
            }
        }
    }
    None
}

/// The strings of a (possibly multi-line) `key = [ "a", "b" ]`.
fn toml_string_array(text: &str, key: &str) -> Vec<String> {
    static STRING: OnceLock<Regex> = OnceLock::new();
    let string = re(&STRING, r#""([^"]*)""#);
    let Some(start) = text.lines().position(|l| {
        l.trim_start()
            .strip_prefix(key)
            .map(|r| r.trim_start().starts_with('='))
            .unwrap_or(false)
    }) else {
        return Vec::new();
    };
    let mut body = String::new();
    for line in text.lines().skip(start) {
        let line = line.split('#').next().unwrap_or("");
        body.push_str(line);
        if line.contains(']') {
            break;
        }
    }
    string
        .captures_iter(&body)
        .map(|c| c[1].to_string())
        .collect()
}

/// `a::{b, c::{d, self}}` → `a::b`, `a::c::d`, `a::c`.
fn expand_use_tree(tree: &str) -> Vec<String> {
    static RENAME: OnceLock<Regex> = OnceLock::new();
    // Drop `as alias` before removing whitespace, which would glue it on.
    let tree = re(&RENAME, r"\s+as\s+[A-Za-z_][A-Za-z0-9_]*").replace_all(tree, "");
    let tree: String = tree.split_whitespace().collect();
    // Anything else is not a use tree (say, prose in a string literal that
    // happened to start a line with "use ").
    if tree.is_empty()
        || !tree
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | ':' | '{' | '}' | ',' | '*'))
    {
        return Vec::new();
    }
    let mut out = Vec::new();
    expand_into("", &tree, &mut out);
    out
}

fn expand_into(prefix: &str, tree: &str, out: &mut Vec<String>) {
    match tree.find('{') {
        None => {
            let item = tree;
            let full = match (prefix.is_empty(), item) {
                (_, "self") => prefix.trim_end_matches("::").to_string(),
                (true, _) => item.to_string(),
                (false, _) => format!("{prefix}{item}"),
            };
            let full = full
                .trim_end_matches("::*")
                .trim_end_matches("::")
                .to_string();
            if !full.is_empty() && full != "*" {
                out.push(full);
            }
        }
        Some(open) => {
            let head = &tree[..open];
            let Some(close) = matching_brace(tree, open) else {
                return;
            };
            let inner = &tree[open + 1..close];
            let prefix = format!("{prefix}{head}");
            for part in split_top_level(inner) {
                expand_into(&prefix, part, out);
            }
        }
    }
}

/// Index of the `}` closing the `{` at `open`.
fn matching_brace(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, ch) in s.char_indices().skip_while(|(i, _)| *i < open) {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn split_top_level(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    for (i, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts.into_iter().filter(|p| !p.is_empty()).collect()
}

/// The `use` and `mod` items of a Rust file, comments removed, each with
/// whether it was indented (inside a block — almost always an inline
/// `mod tests { … }`). A `use` runs to its `;`, across lines; a `mod` is one
/// line.
fn logical_statements(source: &str) -> Vec<(bool, String)> {
    static ITEM: OnceLock<Regex> = OnceLock::new();
    let item = re(&ITEM, r"^(?:pub(?:\([^)]*\))?\s+)?(use|mod)\s");
    // A real `use` ends within a few dozen lines; anything longer started
    // inside a string or a macro and is dropped.
    const MAX_USE_LINES: usize = 64;
    let mut out = Vec::new();
    let mut current = String::new();
    let mut lines_in = 0;
    let mut indented = false;
    for raw in source.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if !current.is_empty() {
            lines_in += 1;
            if lines_in > MAX_USE_LINES {
                current.clear();
            }
        }
        if current.is_empty() {
            lines_in = 0;
            indented = raw.starts_with([' ', '\t']);
            match item.captures(line) {
                Some(c) if &c[1] == "mod" => {
                    out.push((indented, line.to_string()));
                    continue;
                }
                Some(_) => {}
                None => continue,
            }
        } else {
            current.push(' ');
        }
        current.push_str(line);
        if line.ends_with(';') {
            out.push((indented, std::mem::take(&mut current)));
        }
    }
    out
}

/// Python logical lines: comments removed, bracketed and backslash
/// continuations joined.
fn logical_lines(source: &str, comment: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    for line in source.lines() {
        let line = line.split(comment).next().unwrap_or("");
        let continued = line.trim_end().ends_with('\\');
        let line = line.trim_end().trim_end_matches('\\');
        if current.is_empty() {
            current.push_str(line.trim());
        } else {
            current.push(' ');
            current.push_str(line.trim());
        }
        depth += line.matches(['(', '[']).count() as i32 - line.matches([')', ']']).count() as i32;
        if depth <= 0 && !continued {
            out.push(std::mem::take(&mut current));
            depth = 0;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

// ── Go ──────────────────────────────────────────────────────────────────────

fn scan_go(ctx: &Ctx, source: &str, out: &mut Out) {
    static SPEC: OnceLock<Regex> = OnceLock::new();
    let spec = re(&SPEC, r#"^(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$"#);

    // The module this file belongs to: the nearest go.mod above it.
    let mut mod_dir = ctx.dir.to_string();
    let module = loop {
        let go_mod = join(&mod_dir, "go.mod");
        if ctx.is_file(&go_mod) {
            let read = || {
                ctx.read(&go_mod).and_then(|t| {
                    t.lines()
                        .find_map(|l| l.trim().strip_prefix("module "))
                        .map(|m| m.trim().trim_matches('"').to_string())
                })
            };
            break match ctx.known {
                Some(k) => {
                    let mut cache = k.go_modules.lock().unwrap_or_else(|e| e.into_inner());
                    cache.entry(mod_dir.clone()).or_insert_with(read).clone()
                }
                None => read(),
            };
        }
        if mod_dir.is_empty() {
            break None;
        }
        mod_dir = parent_of(&mod_dir).to_string();
    };
    let Some(module) = module else { return };

    let mut in_block = false;
    for line in source.lines() {
        let t = line.split("//").next().unwrap_or("").trim();
        let candidate = if in_block {
            if t.starts_with(')') {
                in_block = false;
                continue;
            }
            t
        } else if t == "import (" || t.starts_with("import (") {
            in_block = true;
            continue;
        } else if t.starts_with("import ") {
            t
        } else {
            continue;
        };
        let Some(cap) = spec.captures(candidate) else {
            continue;
        };
        let path = &cap[1];
        let rest = if path == module {
            ""
        } else if let Some(r) = path.strip_prefix(&format!("{module}/")) {
            r
        } else {
            continue; // standard library or another module
        };
        // A Go import names a package — a directory. Link its files.
        let dir = join(&mod_dir, rest);
        let files: Vec<String> = ctx
            .files_in(&dir)
            .into_iter()
            .filter(|f| f.ends_with(".go") && !f.ends_with("_test.go"))
            .collect();
        if files.is_empty() {
            out.waits.insert(format!("{dir}/"));
        }
        out.imports.extend(files);
    }
}

// ── Java / Kotlin / Scala / Groovy ──────────────────────────────────────────

const JVM_EXTS: &[&str] = &[".java", ".kt", ".kts", ".scala", ".groovy"];

fn scan_jvm(ctx: &Ctx, source: &str, out: &mut Out) {
    static PACKAGE: OnceLock<Regex> = OnceLock::new();
    static IMPORT: OnceLock<Regex> = OnceLock::new();
    let package = re(&PACKAGE, r"(?m)^\s*package\s+([\w.]+)");
    let import = re(
        &IMPORT,
        r"(?m)^\s*import\s+(?:static\s+)?(\w+(?:\.\w+)*)(\.\*)?",
    );

    // Source root: this file's directory minus its package path.
    let source_root = package
        .captures(source)
        .and_then(|c| {
            let pkg = c[1].replace('.', "/");
            if ctx.dir == pkg {
                Some(String::new())
            } else {
                ctx.dir.strip_suffix(&format!("/{pkg}")).map(str::to_string)
            }
        })
        .unwrap_or_else(|| ctx.dir.to_string());

    for cap in import.captures_iter(source) {
        let parts: Vec<&str> = cap[1].split('.').collect();
        if cap.get(2).is_some() {
            // `import a.b.*`: every class of the package.
            let dir = join(&source_root, &parts.join("/"));
            out.imports.extend(
                ctx.files_in(&dir)
                    .into_iter()
                    .filter(|f| JVM_EXTS.iter().any(|e| f.ends_with(e))),
            );
            continue;
        }
        // Deepest prefix that is a file: covers static imports and nested
        // classes (`a.b.Outer.Inner`).
        let package_exists =
            parts.len() > 1 && ctx.is_dir(&join(&source_root, &parts[..parts.len() - 1].join("/")));
        for k in (1..=parts.len()).rev() {
            let base = join(&source_root, &parts[..k].join("/"));
            let c: Vec<String> = JVM_EXTS.iter().map(|e| format!("{base}{e}")).collect();
            let wait = k == parts.len() && package_exists;
            if out.first(ctx, &c, wait) {
                break;
            }
        }
    }
}

// ── C / C++ / Objective-C ───────────────────────────────────────────────────

fn scan_c(ctx: &Ctx, source: &str, out: &mut Out) {
    static INCLUDE: OnceLock<Regex> = OnceLock::new();
    let include = re(
        &INCLUDE,
        r#"(?m)^\s*#\s*(?:include|import)\s*([<"])([^>"\n]+)[>"]"#,
    );
    for cap in include.captures_iter(source) {
        let quoted = &cap[1] == "\"";
        let spec = &cap[2];
        let mut c = Vec::new();
        if quoted {
            c.extend(normalize(ctx.dir, spec));
            c.extend(normalize("", spec));
        }
        c.extend(normalize("include", spec));
        c.extend(normalize("src", spec));
        out.first(ctx, &c, quoted);
    }
}

// ── Ruby / PHP ──────────────────────────────────────────────────────────────

fn scan_ruby(ctx: &Ctx, source: &str, out: &mut Out) {
    static REQ: OnceLock<Regex> = OnceLock::new();
    let req = re(
        &REQ,
        r#"(?m)^\s*(require_relative|require)\s*\(?\s*['"]([^'"]+)['"]"#,
    );
    for cap in req.captures_iter(source) {
        let spec = cap[2].trim_end_matches(".rb");
        if &cap[1] == "require_relative" {
            if let Some(p) = normalize(ctx.dir, spec) {
                out.first(ctx, &[format!("{p}.rb")], true);
            }
        } else if let Some(p) = normalize("lib", spec) {
            out.first(ctx, &[format!("{p}.rb")], false);
        }
    }
}

fn scan_php(ctx: &Ctx, source: &str, out: &mut Out) {
    static REQ: OnceLock<Regex> = OnceLock::new();
    let req = re(
        &REQ,
        r#"\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]"#,
    );
    for cap in req.captures_iter(source) {
        let spec = cap[1].trim_start_matches('/');
        if let Some(p) = normalize(ctx.dir, spec) {
            out.first(ctx, &[p], true);
        }
    }
}

// ── Path helpers ────────────────────────────────────────────────────────────

fn parent_of(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn split_last(rel: &str) -> (&str, &str) {
    rel.rsplit_once('/').unwrap_or(("", rel))
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        dir.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// `dir` + `spec`, with `.` and `..` resolved. `None` if it leaves the root.
fn normalize(dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in spec.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

// ── Keeping the store's graph current ───────────────────────────────────────

/// What [`sync`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SyncStats {
    /// Files in the graph after the sync.
    pub files: usize,
    /// Files read and scanned (new, changed, or waiting for a new file).
    pub scanned: usize,
    /// Files that disappeared.
    pub removed: usize,
}

/// Size and modification time of a file, as stored to detect changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub mtime: i64,
    pub size: i64,
}

impl Stamp {
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        Some(Self {
            mtime,
            size: meta.len() as i64,
        })
    }
}

/// One file's row, ready to be written.
struct Row {
    rel: String,
    hash: String,
    stamp: Stamp,
    lines: i64,
    scan: Scan,
}

/// Bring the graph in `store` up to date with the files under its root.
///
/// Unchanged files (same size and modification time as last time) are not
/// read. Everything is read and scanned first, then written in one short
/// transaction, so the daemon is never kept waiting on a long sync.
pub fn sync(store: &ContextStore) -> Result<SyncStats, GraphError> {
    let root = store.key_root().to_path_buf();
    let (config_dir, ignore) = match config::find_config(&root) {
        Ok(path) => (
            path.parent().map(Path::to_path_buf).unwrap_or(root.clone()),
            config::load_config(&path)
                .map(|c| c.genctx_ignore)
                .unwrap_or_default(),
        ),
        Err(_) => (root.clone(), Vec::new()),
    };

    // ── 1. What is on disk ──────────────────────────────────────────────
    let walker = filter::project_walker(&root, &config_dir, &ignore).map_err(GraphError::Walk)?;
    let mut on_disk: Vec<(String, PathBuf, Stamp)> = Vec::new();
    for entry in walker.build().filter_map(Result::ok) {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.into_path();
        let Ok(rel) = path.strip_prefix(&root) else {
            continue;
        };
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if let Some(stamp) = Stamp::of(&path) {
            on_disk.push((rel, path, stamp));
        }
    }
    let known = FileSet::new(on_disk.iter().map(|(rel, _, _)| rel.clone()));

    // ── 2. What the store remembers ─────────────────────────────────────
    let previous = stored_files(store)?;
    let scanner_changed = stored_scanner_version(store)?.as_deref() != Some(SCANNER_VERSION);

    // ── 3. Read and scan what changed ───────────────────────────────────
    let mut rows = Vec::new();
    let mut touched_only = Vec::new();
    let mut added = Vec::new();
    for (rel, path, stamp) in &on_disk {
        match previous.get(rel) {
            Some((_, old)) if old == stamp && !scanner_changed => continue,
            Some(_) => {}
            None => added.push(rel.clone()),
        }
        match read_row(&root, rel, path, *stamp, Some(&known)) {
            Some(row)
                if !scanner_changed && previous.get(rel).map(|(h, _)| h) == Some(&row.hash) =>
            {
                // Touched, not changed: keep the edges, refresh the stamp.
                touched_only.push((rel.clone(), *stamp));
            }
            Some(row) => rows.push(row),
            None => {}
        }
    }

    // Files waiting for one that just appeared can resolve it now.
    let rescanned: HashSet<String> = rows.iter().map(|r| r.rel.clone()).collect();
    for waiter in waiters_for(store, &added)? {
        if rescanned.contains(&waiter) || !known.files.contains(&waiter) {
            continue;
        }
        let path = root.join(&waiter);
        if let Some(stamp) = Stamp::of(&path) {
            rows.extend(read_row(&root, &waiter, &path, stamp, Some(&known)));
        }
    }

    let present: HashSet<&str> = on_disk.iter().map(|(r, _, _)| r.as_str()).collect();
    let removed: Vec<String> = previous
        .keys()
        .filter(|r| !present.contains(r.as_str()))
        .cloned()
        .collect();

    // ── 4. Write ────────────────────────────────────────────────────────
    let stats = SyncStats {
        files: on_disk.len(),
        scanned: rows.len(),
        removed: removed.len(),
    };
    if rows.is_empty() && removed.is_empty() && touched_only.is_empty() && !scanner_changed {
        return Ok(stats);
    }
    store.savepoint(|| {
        store
            .conn()
            .execute(
                "INSERT OR REPLACE INTO graph_meta (key, value) VALUES ('scanner', ?1)",
                params![SCANNER_VERSION],
            )
            .map_err(store.sql_err())?;
        for row in &rows {
            write_row(store, row)?;
        }
        for (rel, stamp) in &touched_only {
            store
                .conn()
                .execute(
                    "UPDATE files SET mtime = ?2, size = ?3 WHERE rel_path = ?1",
                    params![rel, stamp.mtime, stamp.size],
                )
                .map_err(store.sql_err())?;
        }
        for rel in &removed {
            delete_node(store, rel)?;
        }
        Ok(())
    })?;
    Ok(stats)
}

/// Record the scan of one file that was just processed (a save, or
/// `genctx index`), so the graph stays current without a full sync. If the
/// file is new to the graph, the files waiting for it are rescanned too.
pub fn record(
    store: &ContextStore,
    rel_path: &str,
    source: &str,
    stamp: Stamp,
    scan: &Scan,
) -> Result<(), StoreError> {
    let is_new = store
        .conn()
        .query_row(
            "SELECT 1 FROM files WHERE rel_path = ?1",
            params![rel_path],
            |_| Ok(()),
        )
        .optional()
        .map_err(store.sql_err())?
        .is_none();
    let row = Row {
        rel: rel_path.to_string(),
        hash: content_hash(source),
        stamp,
        lines: source.lines().count() as i64,
        scan: scan.clone(),
    };
    let root = store.key_root().to_path_buf();
    let mut rows = vec![row];
    if is_new {
        for waiter in waiters_for(store, &[rel_path.to_string()])? {
            let path = root.join(&waiter);
            if let Some(stamp) = Stamp::of(&path) {
                rows.extend(read_row(&root, &waiter, &path, stamp, None));
            }
        }
    }
    store.savepoint(|| rows.iter().try_for_each(|r| write_row(store, r)))
}

fn read_row(
    root: &Path,
    rel: &str,
    path: &Path,
    stamp: Stamp,
    known: Option<&FileSet>,
) -> Option<Row> {
    let lang = language(rel);
    let bytes = std::fs::read(path).ok()?;
    let Ok(source) = String::from_utf8(bytes) else {
        return Some(Row {
            rel: rel.to_string(),
            hash: String::new(),
            stamp,
            lines: 0,
            scan: Scan {
                lang: BINARY,
                ..Scan::default()
            },
        });
    };
    let scan = if stamp.size as u64 > MAX_SCAN_BYTES {
        Scan {
            lang,
            imports: None,
            waits: Vec::new(),
        }
    } else {
        scan_file(root, rel, &source, known)
    };
    Some(Row {
        rel: rel.to_string(),
        hash: content_hash(&source),
        stamp,
        lines: source.lines().count() as i64,
        scan,
    })
}

fn write_row(store: &ContextStore, row: &Row) -> Result<(), StoreError> {
    let conn = store.conn();
    let err = store.sql_err();
    conn.execute(
        "INSERT INTO files (rel_path, content_hash, mtime, size, lang, lines)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(rel_path) DO UPDATE SET
             content_hash = excluded.content_hash, mtime = excluded.mtime,
             size = excluded.size, lang = excluded.lang, lines = excluded.lines",
        params![
            row.rel,
            row.hash,
            row.stamp.mtime,
            row.stamp.size,
            row.scan.lang,
            row.lines
        ],
    )
    .map_err(&err)?;
    conn.execute(
        "DELETE FROM deps WHERE src = ?1 AND kind = ?2",
        params![row.rel, DEP_SCANNED],
    )
    .map_err(&err)?;
    conn.execute("DELETE FROM waits WHERE src = ?1", params![row.rel])
        .map_err(&err)?;
    let mut dep = conn
        .prepare_cached("INSERT OR IGNORE INTO deps (src, dst, kind) VALUES (?1, ?2, ?3)")
        .map_err(&err)?;
    for dst in row.scan.imports.iter().flatten() {
        dep.execute(params![row.rel, dst, DEP_SCANNED])
            .map_err(&err)?;
    }
    let mut wait = conn
        .prepare_cached("INSERT OR IGNORE INTO waits (src, candidate) VALUES (?1, ?2)")
        .map_err(&err)?;
    for candidate in &row.scan.waits {
        wait.execute(params![row.rel, candidate]).map_err(&err)?;
    }
    Ok(())
}

fn delete_node(store: &ContextStore, rel: &str) -> Result<(), StoreError> {
    let conn = store.conn();
    let err = store.sql_err();
    conn.execute("DELETE FROM files WHERE rel_path = ?1", params![rel])
        .map_err(&err)?;
    conn.execute(
        "DELETE FROM deps WHERE src = ?1 AND kind = ?2",
        params![rel, DEP_SCANNED],
    )
    .map_err(&err)?;
    conn.execute("DELETE FROM waits WHERE src = ?1", params![rel])
        .map_err(&err)?;
    Ok(())
}

fn stored_scanner_version(store: &ContextStore) -> Result<Option<String>, StoreError> {
    store
        .conn()
        .query_row(
            "SELECT value FROM graph_meta WHERE key = 'scanner'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(store.sql_err())
}

fn stored_files(store: &ContextStore) -> Result<HashMap<String, (String, Stamp)>, StoreError> {
    let mut stmt = store
        .conn()
        .prepare("SELECT rel_path, content_hash, mtime, size FROM files")
        .map_err(store.sql_err())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (
                    r.get::<_, String>(1)?,
                    Stamp {
                        mtime: r.get(2)?,
                        size: r.get(3)?,
                    },
                ),
            ))
        })
        .map_err(store.sql_err())?;
    rows.collect::<Result<_, _>>().map_err(store.sql_err())
}

/// Files whose unresolved imports would be satisfied by one of `added`.
fn waiters_for(store: &ContextStore, added: &[String]) -> Result<BTreeSet<String>, StoreError> {
    let mut out = BTreeSet::new();
    let mut stmt = store
        .conn()
        .prepare_cached("SELECT src FROM waits WHERE candidate = ?1")
        .map_err(store.sql_err())?;
    for rel in added {
        // A Go package waits on its directory.
        let dir = format!("{}/", parent_of(rel));
        for key in [rel.as_str(), dir.as_str()] {
            let rows = stmt
                .query_map(params![key], |r| r.get::<_, String>(0))
                .map_err(store.sql_err())?;
            for src in rows {
                out.insert(src.map_err(store.sql_err())?);
            }
        }
    }
    out.remove("");
    for rel in added {
        out.remove(rel);
    }
    Ok(out)
}

// ── Reading the graph ───────────────────────────────────────────────────────

/// One file in the graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphNode {
    /// Root-relative path.
    pub id: String,
    pub lang: String,
    pub lines: i64,
    /// `ROLE:` from the stored context, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// `current`, `stale` (the file changed since) or `missing`.
    pub context: &'static str,
}

/// The whole project graph, as `genctx graph --json` prints it.
#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    pub root: String,
    pub nodes: Vec<GraphNode>,
    /// `[importer, imported]` pairs.
    pub edges: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync: Option<SyncStats>,
}

/// Read the graph from `store`. Only edges between files in the graph are
/// returned (an `IMPORTS:` entry naming a file that no longer exists is not).
pub fn load(store: &ContextStore) -> Result<Graph, StoreError> {
    let conn = store.conn();
    let err = store.sql_err();
    let mut stmt = conn
        .prepare(
            "SELECT f.rel_path, f.lang, f.lines, f.content_hash, c.content_hash, c.fields
             FROM files f
             LEFT JOIN context c ON c.rel_path = f.rel_path AND c.version = ?1
             WHERE f.lang <> ?2
             ORDER BY f.rel_path",
        )
        .map_err(&err)?;
    let nodes = stmt
        .query_map(params![CONTEXT_VERSION, BINARY], |r| {
            let file_hash: String = r.get(3)?;
            let ctx_hash: Option<String> = r.get(4)?;
            let fields: Option<String> = r.get(5)?;
            Ok(GraphNode {
                id: r.get(0)?,
                lang: r.get(1)?,
                lines: r.get(2)?,
                role: fields
                    .as_deref()
                    .and_then(|f| store::field_value(f, "ROLE"))
                    .filter(|r| !r.is_empty())
                    .map(str::to_string),
                context: match ctx_hash {
                    None => "missing",
                    Some(h) if h == file_hash && !h.is_empty() => "current",
                    Some(_) => "stale",
                },
            })
        })
        .map_err(&err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(&err)?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT d.src, d.dst FROM deps d
             JOIN files a ON a.rel_path = d.src AND a.lang <> ?1
             JOIN files b ON b.rel_path = d.dst AND b.lang <> ?1
             WHERE d.src <> d.dst
             ORDER BY d.src, d.dst",
        )
        .map_err(&err)?;
    let edges = stmt
        .query_map(params![BINARY], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(&err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(&err)?;

    Ok(Graph {
        root: store.root().display().to_string(),
        nodes,
        edges,
        sync: None,
    })
}

/// The graph as text for an LLM: one line per file that imports anything,
/// `file -> a, b`, under a one-line summary.
pub fn dependency_map(graph: &Graph) -> String {
    let mut by_src: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for (src, dst) in &graph.edges {
        by_src.entry(src).or_default().push(dst);
    }
    let mut out = format!(
        "=== DEPENDENCIES ({} files, {} links) ===\n",
        graph.nodes.len(),
        graph.edges.len()
    );
    for (src, dsts) in by_src {
        out.push_str(&format!("{src} -> {}\n", dsts.join(", ")));
    }
    out
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tree(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (rel, content) in files {
            let p = dir.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
        dir
    }

    fn imports(dir: &TempDir, rel: &str) -> Vec<String> {
        let source = fs::read_to_string(dir.path().join(rel)).unwrap();
        scan_file(dir.path(), rel, &source, None)
            .imports
            .expect("supported language")
    }

    #[test]
    fn typescript_relative_imports_resolve_to_files() {
        let dir = tree(&[
            (
                "src/app.ts",
                "import { a } from './lib/a';\nimport b from \"../shared/b.js\";\n\
                 // import { gone } from './gone';\nimport React from 'react';\n\
                 export * from './lib';\nconst c = require('./c.json');\n\
                 const lazy = () => import('@/views/page');\nimport {\n  x,\n} from './lib/x';",
            ),
            ("src/lib/a.ts", ""),
            ("src/lib/index.ts", ""),
            ("src/lib/x.tsx", ""),
            ("src/c.json", "{}"),
            ("src/views/page.vue", ""),
            ("shared/b.ts", ""),
        ]);
        assert_eq!(
            imports(&dir, "src/app.ts"),
            vec![
                "shared/b.ts",
                "src/c.json",
                "src/lib/a.ts",
                "src/lib/index.ts",
                "src/lib/x.tsx",
                "src/views/page.vue"
            ]
        );
    }

    #[test]
    fn python_absolute_relative_and_from_imports() {
        let dir = tree(&[
            (
                "backend/app/services/users.py",
                "import os\nfrom app.models import User\nfrom . import helpers\n\
                 from ..core import (\n    config,\n    db as database,\n)\nimport app.util as u\n",
            ),
            ("backend/app/__init__.py", ""),
            ("backend/app/services/__init__.py", ""),
            ("backend/app/services/helpers.py", ""),
            ("backend/app/models.py", ""),
            ("backend/app/util.py", ""),
            ("backend/app/core/__init__.py", ""),
            ("backend/app/core/config.py", ""),
        ]);
        assert_eq!(
            imports(&dir, "backend/app/services/users.py"),
            vec![
                "backend/app/core/config.py",
                "backend/app/models.py",
                "backend/app/services/helpers.py",
                "backend/app/util.py"
            ]
        );
    }

    #[test]
    fn rust_modules_use_trees_and_workspace_crates() {
        let dir = tree(&[
            (
                "Cargo.toml",
                "[workspace]\nmembers = [\n  \"crates/*\",\n]\n",
            ),
            ("crates/core/Cargo.toml", "[package]\nname = \"my-core\"\n"),
            (
                "crates/core/src/lib.rs",
                "pub mod store;\npub mod graph;\nmod missing;\n",
            ),
            (
                "crates/core/src/graph.rs",
                "use std::fs;\nuse crate::{\n    store::{self, Store},\n    config::Thing,\n};\nuse super::lib_item;\n",
            ),
            ("crates/core/src/store/mod.rs", ""),
            ("crates/core/src/config.rs", ""),
            ("crates/cli/Cargo.toml", "[package]\nname = \"cli\"\n"),
            (
                "crates/cli/src/main.rs",
                "mod mcp;\nuse my_core::graph::load;\nuse my_core::Root;\nuse mcp::serve;\n",
            ),
            ("crates/cli/src/mcp.rs", ""),
        ]);
        let source = fs::read_to_string(dir.path().join("crates/core/src/lib.rs")).unwrap();
        let scan = scan_file(dir.path(), "crates/core/src/lib.rs", &source, None);
        assert_eq!(
            scan.imports.unwrap(),
            vec!["crates/core/src/graph.rs", "crates/core/src/store/mod.rs"]
        );
        assert_eq!(
            scan.waits,
            vec![
                "crates/core/src/missing.rs",
                "crates/core/src/missing/mod.rs"
            ]
        );
        assert_eq!(
            imports(&dir, "crates/core/src/graph.rs"),
            vec![
                "crates/core/src/config.rs",
                "crates/core/src/lib.rs",
                "crates/core/src/store/mod.rs"
            ]
        );
        assert_eq!(
            imports(&dir, "crates/cli/src/main.rs"),
            vec![
                "crates/cli/src/mcp.rs",
                "crates/core/src/graph.rs",
                "crates/core/src/lib.rs"
            ]
        );
    }

    #[test]
    fn use_tree_parsing_survives_prose_and_odd_braces() {
        assert_eq!(
            expand_use_tree("a::{b::{c as d, self}, e}"),
            vec!["a::b::c", "a::b", "a::e"]
        );
        assert!(expand_use_tree("a smaller model.\" )] Timeout { url }").is_empty());
        assert!(expand_use_tree("x}::{y").is_empty());
        let src = "const MSG: &str = \"\nuse a smaller model.\";\nfn f() {}\n\
                   #[cfg(test)]\nmod tests {\n    use super::*;\n}\n";
        let dir = tree(&[
            ("Cargo.toml", "[package]\nname = \"x\"\n"),
            ("src/lib.rs", src),
        ]);
        assert_eq!(imports(&dir, "src/lib.rs"), Vec::<String>::new());
    }

    #[test]
    fn go_packages_link_their_files() {
        let dir = tree(&[
            ("go.mod", "module example.com/shop\n\ngo 1.22\n"),
            (
                "cmd/api/main.go",
                "package main\n\nimport (\n\t\"fmt\"\n\tdb \"example.com/shop/internal/db\"\n\t\"example.com/shop/internal/later\"\n)\n",
            ),
            ("internal/db/db.go", "package db"),
            ("internal/db/query.go", "package db"),
            ("internal/db/db_test.go", "package db"),
        ]);
        let source = fs::read_to_string(dir.path().join("cmd/api/main.go")).unwrap();
        let scan = scan_file(dir.path(), "cmd/api/main.go", &source, None);
        assert_eq!(
            scan.imports.unwrap(),
            vec!["internal/db/db.go", "internal/db/query.go"]
        );
        assert_eq!(scan.waits, vec!["internal/later/"]);
    }

    #[test]
    fn java_c_ruby_php_css_and_markdown() {
        let dir = tree(&[
            (
                "src/main/java/com/acme/App.java",
                "package com.acme;\nimport com.acme.util.Strings;\nimport static com.acme.util.Math.max;\nimport java.util.List;\n",
            ),
            ("src/main/java/com/acme/util/Strings.java", ""),
            ("src/main/java/com/acme/util/Math.java", ""),
            ("native/main.c", "#include \"util.h\"\n#include <stdio.h>\n#include <proj/api.h>\n"),
            ("native/util.h", ""),
            ("include/proj/api.h", ""),
            ("lib/a.rb", "require_relative 'b'\nrequire 'json'\n"),
            ("lib/b.rb", ""),
            ("web/index.php", "<?php require_once __DIR__ . '/inc/db.php';"),
            ("web/inc/db.php", ""),
            ("styles/main.scss", "@use 'colors';\n@import \"https://x/y.css\";"),
            ("styles/_colors.scss", ""),
            ("docs/guide.md", "See [the API](../include/proj/api.h) and [site](https://x.dev)."),
        ]);
        assert_eq!(
            imports(&dir, "src/main/java/com/acme/App.java"),
            vec![
                "src/main/java/com/acme/util/Math.java",
                "src/main/java/com/acme/util/Strings.java"
            ]
        );
        assert_eq!(
            imports(&dir, "native/main.c"),
            vec!["include/proj/api.h", "native/util.h"]
        );
        assert_eq!(imports(&dir, "lib/a.rb"), vec!["lib/b.rb"]);
        assert_eq!(imports(&dir, "web/index.php"), vec!["web/inc/db.php"]);
        assert_eq!(
            imports(&dir, "styles/main.scss"),
            vec!["styles/_colors.scss"]
        );
        assert_eq!(imports(&dir, "docs/guide.md"), vec!["include/proj/api.h"]);
    }

    #[test]
    fn unsupported_languages_report_unknown_not_none() {
        let dir = tree(&[("a.swift", "import Foundation")]);
        let scan = scan_file(dir.path(), "a.swift", "import Foundation", None);
        assert_eq!(scan.lang, "swift");
        assert_eq!(scan.imports, None);
        drop(dir);
    }

    #[test]
    fn normalize_never_leaves_the_root() {
        assert_eq!(normalize("a/b", "../c"), Some("a/c".into()));
        assert_eq!(normalize("a", "../../c"), None);
        assert_eq!(normalize("", "./x/./y"), Some("x/y".into()));
    }

    fn project(files: &[(&str, &str)]) -> (TempDir, ContextStore) {
        let mut all = vec![(config::CONFIG_FILENAME, "project: G\n")];
        all.extend_from_slice(files);
        let dir = tree(&all);
        let store = ContextStore::open(dir.path()).unwrap();
        (dir, store)
    }

    fn edges(store: &ContextStore) -> Vec<(String, String)> {
        load(store).unwrap().edges
    }

    #[test]
    fn sync_is_incremental_and_follows_changes() {
        let (dir, store) = project(&[("a.ts", "import './b';"), ("b.ts", "export const b = 1;")]);
        fs::write(dir.path().join("logo.png"), [0x89, 0xff, 0xfe, 0x00]).unwrap();
        let first = sync(&store).unwrap();
        assert_eq!(first.scanned, 4); // config, a, b, logo
        assert_eq!(edges(&store), vec![("a.ts".into(), "b.ts".into())]);
        let ids: Vec<String> = load(&store)
            .unwrap()
            .nodes
            .into_iter()
            .map(|n| n.id)
            .collect();
        assert!(
            !ids.contains(&"logo.png".to_string()),
            "binary files are hidden"
        );

        // Nothing changed: nothing is read.
        assert_eq!(sync(&store).unwrap().scanned, 0);

        // A different scanner rescans everything once.
        store
            .conn()
            .execute(
                "UPDATE graph_meta SET value = 'old' WHERE key = 'scanner'",
                [],
            )
            .unwrap();
        assert_eq!(sync(&store).unwrap().scanned, 4);
        assert_eq!(sync(&store).unwrap().scanned, 0);

        // An edit is picked up; a deletion removes the node and its edges.
        fs::write(dir.path().join("b.ts"), "import './a'; // now circular").unwrap();
        bump_mtime(&dir.path().join("b.ts"));
        sync(&store).unwrap();
        assert_eq!(
            edges(&store),
            vec![
                ("a.ts".into(), "b.ts".into()),
                ("b.ts".into(), "a.ts".into())
            ]
        );
        fs::remove_file(dir.path().join("a.ts")).unwrap();
        let stats = sync(&store).unwrap();
        assert_eq!(stats.removed, 1);
        assert!(edges(&store).is_empty());
    }

    #[test]
    fn a_new_file_resolves_imports_that_were_waiting_for_it() {
        let (dir, store) = project(&[("a.ts", "import { x } from './later';")]);
        sync(&store).unwrap();
        assert!(edges(&store).is_empty());

        // a.ts itself did not change, yet it now links to the new file.
        fs::write(dir.path().join("later.ts"), "export const x = 1;").unwrap();
        let stats = sync(&store).unwrap();
        assert_eq!(stats.scanned, 2);
        assert_eq!(edges(&store), vec![("a.ts".into(), "later.ts".into())]);

        // The same through record(), as the daemon does on save.
        fs::write(dir.path().join("b.ts"), "import './c';").unwrap();
        sync(&store).unwrap();
        let c = dir.path().join("c.ts");
        fs::write(&c, "export {}").unwrap();
        let scan = scan_file(dir.path(), "c.ts", "export {}", None);
        record(&store, "c.ts", "export {}", Stamp::of(&c).unwrap(), &scan).unwrap();
        assert!(edges(&store).contains(&("b.ts".into(), "c.ts".into())));
    }

    #[test]
    fn graph_carries_roles_and_context_state_and_follows_renames() {
        let (dir, store) = project(&[("a.py", "import b\n"), ("b.py", "X = 1\n")]);
        sync(&store).unwrap();
        store
            .put(
                "b.py",
                &content_hash("X = 1\n"),
                "llm",
                "FILE: b.py\nROLE: Holds X\nIMPORTS: NONE",
            )
            .unwrap();
        store
            .put(
                "a.py",
                "old-hash",
                "llm",
                "FILE: a.py\nROLE: Uses b\nIMPORTS: b.py",
            )
            .unwrap();
        let graph = load(&store).unwrap();
        let b = graph.nodes.iter().find(|n| n.id == "b.py").unwrap();
        assert_eq!(b.role.as_deref(), Some("Holds X"));
        assert_eq!(b.context, "current");
        let a = graph.nodes.iter().find(|n| n.id == "a.py").unwrap();
        assert_eq!(a.context, "stale");
        // Scanned and declared edges are one link.
        assert_eq!(graph.edges, vec![("a.py".into(), "b.py".into())]);
        assert_eq!(store.importers_of("b.py").unwrap(), vec!["a.py"]);

        // A rename made in the editor moves the node and the edges into it.
        fs::rename(dir.path().join("b.py"), dir.path().join("c.py")).unwrap();
        store.rename_path("b.py", "c.py").unwrap();
        assert_eq!(edges(&store), vec![("a.py".into(), "c.py".into())]);
        assert!(dependency_map(&load(&store).unwrap()).contains("a.py -> c.py\n"));
    }

    fn bump_mtime(path: &Path) {
        // Some file systems have coarse timestamps; make the change visible.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(later).unwrap();
    }
}
