# genctx

Context for your source files, invisible to your repo.

genctx attaches a per-file context block to every source file in your project. The context lives in genctx's own store, a single SQLite database in a hidden `.genctx/` folder at the project root (much like `.git/`). Your source files are never touched, and the store works the same on any file system: NTFS, ext4, APFS, FAT32, exFAT or a network share. When you paste a file into an LLM, click the status bar button to merge the context in first. MCP clients such as Claude Code can also read it directly.

---

## How it works

1. **Save a file in VS Code.** The extension sends a save notification to the background daemon (`genctxd`), which it starts for you if it isn't running.
2. **Files genctx should not touch are skipped**: anything ignored by `.gitignore`/`.ignore` or `genctx_ignore`, hidden files such as `.env`, binaries, tiny files, and files outside any project.
3. **If the file starts with an `<<<GENCTX` comment block** (written by the LLM that last generated it), the daemon stores it immediately and strips it from the source file. Ollama is never called. Only a block at the very top of a file counts, so documentation that *shows* the format is never rewritten. A block that is already committed in git is stored but left in the file, so nobody's working tree changes.
4. **Otherwise**, the daemon waits 30 seconds (in case you keep typing), then asks a local Ollama model for the context fields. The answer is checked, and retried once if it isn't usable, before being stored.
5. **When you want to use the context**, click the status bar button (or run `genctx: Pack current file to clipboard`). The project header, the file's context and its source are merged and placed on the clipboard. Paste into any LLM.
6. **When you want to see how it all fits together**, run `genctx: Show code graph`: an Obsidian-style map of the project's files and the imports between them (see [Code graph](#code-graph)).

The source files in your repo stay clean. No comments, no markers, nothing visible.

---

## Where context is stored

Each project gets one store at `<project root>/.genctx/context.db`. The project root is the folder holding `gencontext.yaml`. Without one, genctx uses the nearest folder that already has a `.genctx/` store or is a git checkout. Files outside any project are ignored.

- **Invisible to git.** `.genctx/` contains its own `.gitignore` (`*`), so it never shows up in `git status`, and your own `.gitignore` is never edited. The VS Code extension hides the folder from the Explorer and file watcher. On Windows the folder also gets the hidden attribute.
- **Travels with the project.** Copying, zipping, syncing or backing up the project folder with any tool keeps the context, because it is just a file inside the folder.
- **Only the file's own fields are stored.** Each entry holds the six fields (`FILE` … `NOTES`). The project header (PROJECT/TASK/CONVENTIONS) is rendered from the current `gencontext.yaml` every time context is packed, so editing the task takes effect everywhere at once. `USED BY` is computed from the dependency graph rather than guessed.
- **The dependency graph lives next to it.** The same database holds which file imports which, found by scanning import statements (no model involved), indexed in both directions. See [Code graph](#code-graph).
- **Survives renames and moves.** Renames, moves and deletes made in VS Code are applied to the store directly, even when the file was also edited. For anything done outside VS Code, each entry is also findable by a hash of its content: the next save or `genctx index` carries the context over with no Ollama call, including between a project and a nested one. A copied file gets its own copy of the context the same way.
- **One key per file.** Keys are paths relative to the project root, using the on-disk spelling. On Windows and macOS, `SRC\Main.rs` and `src\main.rs` are the same entry.
- **Safe to share between processes.** The daemon and the CLI can write at the same time. SQLite serialises the writes, and each one is all-or-nothing.
- **Disposable.** Deleting `.genctx/` loses nothing that `genctx index` can't rebuild.

---

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/USAGE.md`](docs/USAGE.md) | Walking through genctx on a real project day-to-day - writing code, packing context for an LLM, reindexing after a clone, etc. |
| [`docs/genctx.md`](docs/genctx.md) | The skill file - give this to an LLM so it emits `<<<GENCTX` blocks itself when writing your source files. |
| [`docs/genctx_architecture_v5.svg`](docs/genctx_architecture_v5.svg) | Architecture diagram of the extension/daemon/core/cpctx pieces. |
| [`docs/genctx_tracker.md`](docs/genctx_tracker.md) | Internal project tracker/dev log - upload it to a Claude session to resume work on genctx itself. |

This README covers installation and reference. Start with `docs/USAGE.md` if you just want to know how to use the tool day-to-day.

---

## Installing Rust (step-by-step)

If you have never used Rust before, follow these steps. This takes about five minutes.

### Step 1 - Download the Rust installer

Go to **https://rustup.rs** in your browser. Click the button to download `rustup-init.exe` (on Windows) and run it.

Alternatively, open PowerShell and paste this one command:

```powershell
winget install Rustlang.Rustup
```

Either way, a small program called **rustup** is installed. rustup is the official Rust version manager - it downloads and updates the Rust compiler (`rustc`) and the build tool (`cargo`) for you.

### Step 2 - Run the installer

If you downloaded `rustup-init.exe`, double-click it. You will see a terminal prompt like:

```
1) Proceed with standard installation (default)
2) Customise installation
3) Cancel installation
```

Press **1** and then Enter. This installs:

- `rustc` - the Rust compiler
- `cargo` - the build tool and package manager (used for everything in this project)
- The standard library

The installer adds Rust to your `PATH` automatically.

### Step 3 - Open a new terminal

Close your current PowerShell or Command Prompt window and open a fresh one. Then verify the installation:

```powershell
rustc --version
cargo --version
```

You should see output like:

```
rustc 1.94.1 (e408947bf 2026-03-25)
cargo 1.94.1 (29ea6fb6a 2026-03-24)
```

Any version from **1.88** onwards works. If yours is older, run `rustup update`.

### Step 4 - Install the Visual C++ Build Tools (Windows only)

Rust on Windows needs the Microsoft C++ linker. If you do not already have Visual Studio installed, run:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

When the installer opens, tick **"Desktop development with C++"** and click Install. This is a one-time step.

The same tools also compile SQLite, which is built into genctx for its context store. On macOS and Linux the system C compiler is enough (`xcode-select --install` on macOS; `gcc` or `clang` on Linux).

### Step 5 - You are ready

You can now build any Rust project by running `cargo build` inside its folder. For this project specifically, continue with the Installation section below.

> **Keeping Rust up to date:** run `rustup update` at any time to get the latest stable compiler.

---

## Installing Ollama (step-by-step)

genctx needs a **local Ollama server, with at least one model pulled**, running in the
background at all times. This is what actually generates context for any file an LLM
didn't write for you (see "How it works" above) - without it, the daemon has nothing to
call, and every file just sits in `error` state. If you don't have Ollama yet, follow
these steps. Installing it takes a minute; pulling a model takes a few minutes more
depending on your connection.

### Step 1 - Download and install Ollama

Go to **https://ollama.com/download**, download the Windows installer, and run it.

Alternatively, open PowerShell and paste this one command:

```powershell
winget install Ollama.Ollama
```

The installer registers Ollama to run automatically at login and puts a llama icon in
your system tray. Ollama itself is not a one-shot program you launch when you need it -
once installed, it runs continuously as a background service, serving a local API on
`http://127.0.0.1:11434`.

### Step 2 - Verify Ollama is actually running

Open a **new** terminal window and run:

```powershell
ollama --version
```

If that fails or you don't see the tray icon, log out and back in (or restart) so the
auto-start entry takes effect. You can also check **Task Manager** for an `ollama.exe` (or
`ollama app.exe`) process - this is the process `genctxd` needs to reach.

### Step 3 - Pull a model

**Installing Ollama does not download any model on its own.** This is the step that's
easy to miss - Ollama can be fully installed and running and genctx will still fail, because
there's no model to actually call. genctx's default is `phi3:mini` (small and fast, more
than enough for the six short fields it asks Ollama to generate):

```powershell
ollama pull phi3:mini
```

This downloads a few hundred MB. Let it finish before moving on.

### Step 4 - Confirm the model is there

```powershell
ollama list
```

`phi3:mini` should be in the output. To sanity-check that it actually responds:

```powershell
ollama run phi3:mini "Say hello in one word."
```

### Step 5 - You are ready

`genctxd` will now be able to reach Ollama on the default URL and generate context for any
file that doesn't already carry an `<<<GENCTX` block. Continue with the Installation
section below.

> **Testing phase - rebuild after every source change.** There is no auto-update.
> Editing the source does nothing until you run `cargo build --release` *and*
> replace the binaries that are actually on your PATH. A stale binary reads your
> new `gencontext.yaml` without complaint, so it can look updated while behaving
> exactly like the old build. See [`docs/REBUILDING.md`](docs/REBUILDING.md).

> **Using a different model or port:** override `ollama_url`, `ollama_model`,
> `ollama_concurrency`, `ollama_timeout_secs`, `ollama_max_bytes` or `ollama_num_ctx`
> per-project in that project's `gencontext.yaml` (see the `gencontext.yaml` section
> further down). All of them are commented out by default, using the values above.
>
> **Using a remote Ollama instance:** `ollama_url` in `gencontext.yaml` may only point at
> this machine, because that file comes with the repository. Set the `GENCTX_OLLAMA_URL`
> environment variable instead, or `genctx.ollamaUrl` in your VS Code user settings. See
> "Security model" below.

---

## Installation

### Prerequisites

- Windows, macOS or Linux, on any file system (the setup commands below use Windows PowerShell; adapt paths for other platforms)
- Ollama installed, running, and with a model pulled (see "Installing Ollama" above if you haven't done this yet - it's easy to install Ollama and still miss the model-pull step)
- Rust 1.88 or newer (see "Installing Rust" above if you need to install it)

### 1. Clone or unzip the project

```powershell
# If you have Git:
git clone https://github.com/manishmajhimidackertech/genctx.git
cd genctx

# Or unzip the downloaded archive and open a terminal in the genctx folder.
```

### 2. Build all binaries

```powershell
cargo build --release -p genctxd -p genctx -p cpctx
```

The three binaries appear at:

```
target\release\genctxd.exe    ← background daemon
target\release\genctx.exe     ← CLI tool
target\release\cpctx.exe      ← context-preserving copy tool
```

### 3. Put the binaries on your PATH

Copy all three `.exe` files into a folder that is on your `PATH`, for example `C:\Tools\genctx\`.

```powershell
# Example: create the folder and copy the binaries
New-Item -ItemType Directory -Force -Path "C:\Tools\genctx"
Copy-Item target\release\genctxd.exe, target\release\genctx.exe, target\release\cpctx.exe `
    -Destination "C:\Tools\genctx\"
```

Then run the setup command from `cpctx` - this registers `C:\Tools\genctx\` on your user PATH permanently and patches your PowerShell profile:

```powershell
C:\Tools\genctx\cpctx.exe setup --bin-dir "C:\Tools\genctx"
```

Open a **new** terminal window and verify:

```powershell
genctx --version
genctxd --version
cpctx --version
```

### 4. The daemon

You normally don't start it yourself: the VS Code extension launches `genctxd` in the background when none is running (turn that off with `genctx.autoStartDaemon`). One daemon serves every VS Code window and keeps running after they close. To run it by hand instead:

```powershell
genctxd
```

The daemon listens on a port the OS picks, on `127.0.0.1` only, and publishes the port with a random token in a file only you can read:

| Platform | Discovery file |
|---|---|
| Windows | `%LOCALAPPDATA%\genctx\daemon.json` |
| Linux | `$XDG_RUNTIME_DIR/genctx/daemon.json`, else `~/.cache/genctx/daemon.json` |
| macOS | `~/.cache/genctx/daemon.json` |

Clients must present the token, so other users and programs on the machine can't drive the daemon, and the extension never talks to some other program sitting on a well-known port. Set `GENCTX_RUNTIME_DIR` to move the file, `GENCTX_DAEMON_PORT` to pin the port, and `GENCTX_NO_UPDATE_CHECK=1` to skip the startup check for new releases. Starting a second daemon is harmless: it sees the first and exits.

### 5. Install the VS Code extension

```powershell
cd vscode-extension
npm install
npm run package       # produces genctx-0.1.0.vsix
code --install-extension genctx-0.1.0.vsix
```

### 6. Initialise a project

Open the project folder in VS Code, then open the Command Palette (`Ctrl+Shift+P`) and run:

```
genctx: Open gencontext.yaml
```

This creates `gencontext.yaml` at the project root. Edit it to describe your project, stack, and current task.

### VS Code settings

| Setting | Default | What it does |
|---|---|---|
| `genctx.autoStartDaemon` | `true` | Start `genctxd` in the background when it isn't running |
| `genctx.daemonPath` | *(PATH)* | Path to `genctxd`, if it isn't on your PATH |
| `genctx.cliPath` | *(PATH)* | Path to `genctx`, if it isn't on your PATH |
| `genctx.ollamaUrl` | *(unset)* | Ollama server to use instead of the project's; the only way to use a remote one |
| `genctx.statusBarAlignment` | `right` | Which side of the status bar the indicator sits on |

The three path/URL settings can only be set in your *user* settings, never by a workspace's `.vscode/settings.json`. Otherwise a repository could choose which binary runs or where your code is sent. The extension also hides `.genctx/` from the Explorer, search and file watcher.

Commands: **Pack current file to clipboard** (also the status bar button), **Pack current file with the context of its imports**, **Copy project map to clipboard**, **Show code graph** (also on folders in the Explorer's context menu), **Reindex current file**, **Open gencontext.yaml**.

---

## Code graph

`genctx: Show code graph` opens a map of the project in the style of Obsidian's graph view: every file is a dot, every import is a link, and well-connected files are drawn bigger.

- **Hover** a file to light up what it imports and what imports it, with its role, size and context state.
- **Click** opens the file (Alt+click: beside the graph). **Shift+click** packs it, with the context of its imports, to the clipboard.
- **Local** shows only the files within *Depth* links of the file open in the editor; **double-click** a file to centre the local graph on it. **Follow editor** keeps the view on whatever file you switch to.
- **Search** dims everything that doesn't match a path or role; Enter jumps to the first match, `/` focuses the box.
- **Colour** by folder, language, or context state (current, stale, none yet). **Orphans** hides files with no links; **Arrows** shows link direction.

The graph refreshes by itself when files are saved, created, renamed or deleted, and keeps its layout when it does. Projects of more than 3,000 files open on the local graph of the active file; the full graph is one tick away (about 7 seconds to lay out 20,000 files).

### Where the graph comes from

The graph is built by **scanning import statements, not by asking Ollama**. Each language has a small scanner that finds imports and resolves them to project files the way the language would: relative paths and `index` files for JS/TS, packages and `__init__.py` for Python, `mod`/`use` and workspace crates for Rust, `go.mod` packages for Go, package roots for Java/Kotlin/Scala, include paths for C/C++, `require_relative` for Ruby, `require`/`include` for PHP, `@import`/`@use` for CSS/SCSS, and links between files for HTML and Markdown. Packages from outside the project (`react`, `std`, `os`) are not files of the project and are not linked.

The result is stored in the project's `.genctx/context.db`, and it pays for itself beyond the picture:

- **Less work for Ollama.** Before a file is sent for context generation, its imports are already known. The model is told them instead of being asked for them, and they become the `IMPORTS:` field verbatim. A small local model has less to write and nothing to get wrong.
- **`USED BY` and `--with-imports` are lookups, not guesses.** Both come from the graph, so a file whose stored `IMPORTS:` line missed a dependency still gets the right answer.
- **It is available immediately.** Scanning a 20,000-file project takes about 2 seconds the first time and a fraction of a second afterwards, because only files whose size or modification time changed are read again. A file created later re-scans exactly the files whose imports were waiting for it. `genctx index` builds the graph before generating anything.

From the command line, `genctx graph` prints the same map as text (`file -> imports`) to paste into an LLM, and `genctx graph --json` prints the whole graph. MCP clients get it through the `get_dependencies` tool.

## Using genctx from Claude Code and other MCP clients

`genctx mcp` serves the project's stored context over the Model Context Protocol, so an assistant can look up what a file is for without you pasting anything. Register it once per project, from the project root:

```powershell
claude mcp add genctx -- genctx mcp
```

Or add it to the project's `.mcp.json` (or your client's MCP config):

```json
{ "mcpServers": { "genctx": { "command": "genctx", "args": ["mcp"] } } }
```

It offers four read-only tools:
- `project_map` gives one line per file, with its role.
- `get_file_context` gives one file's context.
- `get_dependencies` lists what one file imports and what imports it, each with its role.
- `search_context` finds files by path or context text.

Paths are confined to the project root.

---

## Security model

- **A repository can't send your code anywhere.** `ollama_url` in `gencontext.yaml` is honoured only when it points at this machine (`localhost`, `127.0.0.1`, `::1`). A remote server has to be chosen by you, through `GENCTX_OLLAMA_URL` or the machine-scoped `genctx.ollamaUrl` setting.
- **Ignored files stay private.** Anything `.gitignore`, `.ignore` or `genctx_ignore` excludes, and hidden files like `.env`, is never read, sent to Ollama or stored. This applies to saves in the editor as well as to `genctx index`.
- **Only you can drive the daemon.** Its port and token live in a per-user file (mode `0600` on Linux and macOS, under `%LOCALAPPDATA%` on Windows). Connections without the token are dropped.
- **Your files are rewritten safely.** Removing a block writes a temporary file and renames it over the original. The original's permissions and line endings (CRLF stays CRLF) are kept, and symlinks stay symlinks.
- **Generated context is still model output.** Treat what Ollama wrote about a file the way you would treat a comment from a colleague who skimmed it.

---

## Upgrading from llmctx

genctx was called llmctx. Projects set up under the old name keep working without any action:

- a `.llmctx/` store is moved to `.genctx/` the first time genctx opens it;
- `llmcontext.yaml` is still read (and its `llmctx_ignore` key), so renaming it to `gencontext.yaml` is optional; when both exist, `gencontext.yaml` wins;
- the binaries, environment variables and VS Code settings were renamed: `llmctx`/`llmctxd` are now `genctx`/`genctxd`, `LLMCTX_*` variables are `GENCTX_*`, and `llmctx.*` settings are `genctx.*`. LLMs should now write `<<<GENCTX` blocks (see `docs/genctx.md`).

The first `genctx graph` or `genctx index` after upgrading also builds the dependency graph; existing context is kept.

### NTFS streams (llmctx 0.1)

llmctx 0.1 kept context in NTFS Alternate Data Streams. To bring that context into the new store without regenerating it, run this once in each project root on Windows:

```powershell
genctx migrate                   # copy stream context into .genctx/context.db
genctx migrate --remove-streams  # ...and delete each stream once it is stored
```

`migrate` is safe to run more than once. It never overwrites context that is already in the store. If you skip it, `genctx index` regenerates the context instead, which takes longer. Until you migrate, `genctx pack` prints a hint when a file still has an old stream.

---

## cpctx - Context-preserving copy

Copying a whole project folder keeps its context automatically, since the store lives inside the folder. `cpctx` is for the other case: copying files or folders **into a different project**. It copies the file content, then carries each file's context from the source project's store into the destination project's store, with the `FILE:` field updated to the new path.

If a copied folder lands outside every project, it becomes a project of its own: cpctx creates a `.genctx/` store at the top of the copy.

### Usage

```powershell
# Copy a single file
cpctx copy src\auth\middleware.py D:\backup\middleware.py

# Copy a file into a directory (filename is preserved)
cpctx copy src\auth\middleware.py D:\backup\

# Copy an entire directory tree recursively
cpctx copy C:\Projects\myapp D:\Projects\myapp

# Verbose - print each file as it is copied
cpctx copy --verbose src\ D:\backup\src\
```

### Setting up cpctx system-wide

Running `cpctx setup` once adds the binary to your user PATH both in the Windows registry (permanent, survives restarts) and in your PowerShell profile (takes effect immediately in new sessions):

```powershell
cpctx setup
```

After that you can use `cpctx copy` from any terminal or script on the machine without specifying the full path.

### When to use cpctx vs genctx index

| Situation | What to do |
|---|---|
| Copying, zipping, syncing or backing up a whole project folder | Nothing: `.genctx/` goes along with it |
| Renaming or moving a file inside a project | Nothing: the next save or `genctx index` carries its context over by content hash |
| Copying files into a different project | `cpctx copy` |
| A fresh `git clone` (the store is not committed) | `genctx index` to generate context |
| Files deleted or renamed outside VS Code piling up stale entries | `genctx gc` |

---

## gencontext.yaml

```yaml
project: "MyApp"
stack: "Python, FastAPI, PostgreSQL"
task: "Build the payments module"

conventions:
  - "No bare except clauses"
  - "All DB calls go through the repository layer"

genctx_ignore:
  - "generated/**"
  - "migrations/**"

# Optional Ollama overrides (defaults shown)
# ollama_url: "http://127.0.0.1:11434"   # this machine only - see "Security model"
# ollama_model: "phi3:mini"
# ollama_concurrency: 1      # Ollama serialises requests unless
#                            # OLLAMA_NUM_PARALLEL is raised
# ollama_timeout_secs: 300   # per-request budget for one generation
# ollama_max_bytes: 16384    # files above this are skipped, not sent
# ollama_num_ctx: 7168       # context window requested; the default fits
#                            # a file of ollama_max_bytes plus the prompt
```

Edits take effect immediately. The PROJECT/TASK/CONVENTIONS header is rendered from this file whenever context is packed, and is never stored per file.

---

## CLI reference

```
genctx init              Write a gencontext.yaml template here
genctx index [dir]       Walk all files and generate/extract context
                         (resumable - skips files whose context is current;
                         removes context for files deleted under dir)
genctx index --force     Regenerate everything, ignoring stored context
genctx pack <file>       Merge project header + context + source → clipboard
genctx pack <file> --with-imports   ...plus the context of the files it imports
genctx pack <file> --stdout         ...printed instead of copied
genctx map [dir]         One line per file: path and role (--copy to clipboard)
genctx graph [dir]       Dependency map: which file imports which (no Ollama)
genctx graph --json      ...the whole graph as JSON (what the VS Code view reads)
genctx mcp               Serve the project's context to MCP clients over stdio
genctx reindex <file>    Force Ollama regeneration for one file
genctx extract <file>    Run extraction/generation (same as daemon, once)
genctx extract --force   ...even if stored context is already current
genctx gc [dir]          Remove stored context for files that no longer exist
genctx migrate [dir]     Import context from genctx 0.1 NTFS streams (Windows)
genctx migrate --remove-streams   ...and delete the streams afterwards

cpctx copy <src> <dest>  Copy file or directory, carrying context to the destination project
cpctx setup              Register cpctx on the system PATH permanently
```

---

## The `<<<GENCTX` comment block

When an LLM generates a source file for your project, it includes this block at the top:

```python
# <<<GENCTX
# FILE: auth/middleware.py
# ROLE: JWT verification middleware for protected routes
# EXPORTS: verify_token(), require_auth
# IMPORTS: models/user.py, config/settings.py
# USED BY: routers/orders.py, routers/profile.py
# NOTES: NONE
# GENCTX>>>

def verify_token():
    ...
```

On the next save, the daemon detects the block, cuts it out of the source file, and writes it to the context store. The file on disk ends up exactly as if the block was never there.

The block has to be the first thing in the file. Only a shebang, a Rust `#![…]` attribute, an encoding line, `<?php` and the like may come before it. A block anywhere else (say, an example in a Markdown file) is ordinary content and is never touched. If the block is already committed in git, it is stored but left in the file, since removing it would change everyone's working tree.

See [`docs/genctx.md`](docs/genctx.md) (the skill file used by the LLM) for the full format specification and per-language examples.

---

## Repository layout

```
genctx/
├── Cargo.toml                  # Workspace root - shared dependency versions, rust-version
├── Cargo.lock                  # Locked dependency versions (builds are reproducible)
├── gencontext.yaml             # genctx config for the genctx project itself
├── README.md
├── LICENSE
├── .gitignore
├── .github/workflows/ci.yml    # CI: Linux/macOS/Windows tests, clippy, fmt, MSRV, extension
│
├── docs/
│   ├── USAGE.md                 # Day-to-day usage walkthrough on a real project
│   ├── REBUILDING.md            # Rebuilding and testing after a source change
│   ├── genctx.md                 # Skill file - teaches LLMs the <<<GENCTX comment format
│   ├── genctx_architecture_v5.svg
│   └── genctx_tracker.md         # Internal dev tracker for the genctx project itself
│
├── crates/
│   ├── core/                   # genctx-core - shared library (no binary)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs          # Re-exports all public modules
│   │       ├── process.rs      # plan() + process_file() - single decision function
│   │       ├── store.rs        # Context store: .genctx/context.db (SQLite)
│   │       ├── pack.rs         # Packed text, project map, search (read-only)
│   │       ├── graph.rs        # Dependency graph: import scanners, incremental sync
│   │       ├── filter.rs       # Ignore rules for a single file
│   │       ├── extract.rs      # Top-of-file <<<GENCTX block detection and stripping
│   │       ├── ollama.rs       # Ollama client: URL policy, JSON answers, validation
│   │       ├── runtime.rs      # Daemon discovery file and auth token
│   │       ├── config.rs       # gencontext.yaml parsing & walk-up resolution
│   │       ├── fsutil.rs       # Atomic file replacement, path helpers
│   │       ├── git.rs          # Reads HEAD versions (committed-block check)
│   │       ├── migrate.rs      # genctx 0.1 NTFS streams → store
│   │       └── ads.rs          # Legacy NTFS stream reader/writer
│   │
│   ├── daemon/                 # genctxd - background daemon binary
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── main.rs         # Authenticated listener, plan-first saves, debounce, per-server limits
│   │
│   ├── cli/                    # genctx - CLI binary
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs         # init, index, pack, map, graph, reindex, extract, migrate, gc, mcp
│   │       └── mcp.rs          # MCP server over stdio
│   │
│   └── cpctx/                  # cpctx - context-preserving copy binary
│       ├── Cargo.toml
│       └── src/
│           └── main.rs         # copy + setup subcommands; PATH registration
│
└── vscode-extension/           # VS Code extension
    ├── package.json            # Extension manifest, commands, config schema
    ├── package-lock.json
    ├── tsconfig.json
    ├── .eslintrc.json
    ├── .vscodeignore
    ├── src/
    │   ├── extension.ts        # activate/deactivate - wires everything together
    │   ├── daemon.ts           # Daemon discovery, token handshake, auto-start, reconnect
    │   ├── statusBar.ts        # Per-file status bar item (queued/generating/ready/skipped/error)
    │   ├── pack.ts             # Runs `genctx pack/map/reindex`, writes the clipboard
    │   ├── graphView.ts        # Code graph panel: runs `genctx graph --json`, follows the editor
    │   ├── graphHtml.ts        # The graph page's markup and Content Security Policy
    │   ├── graphPaths.ts       # Editor paths ↔ graph node ids
    │   └── hash.ts             # SHA-256 matching process::content_hash() on Rust side
    ├── media/
    │   ├── graph.js            # Graph webview: Barnes-Hut layout, canvas drawing, interaction
    │   ├── graph-model.js      # Pure graph logic (neighbourhoods, search, filters, colours)
    │   └── graph.css
    └── tests/                  # node --test (npm test); graphView.browser.js drives the page in Chromium
```

---

## Architecture

```
VS Code extension
  │  finds genctxd via the per-user discovery file (starts it if needed)
  │  hello{token} → save / rename / delete events → TCP NDJSON → genctxd
  │  status push ← (queued / generating / ready / skipped / error)
  │  pack / map → `genctx … --stdout` → VS Code clipboard
  │
genctxd (daemon)
  │  plan() first: skip, up to date, carry over and extract are answered at once
  │      detect <<<GENCTX → write store → strip source (atomic)
  │  Ollama path (debounced 30 s, one limit per Ollama server from config)
  │      hash check → acquire semaphore → call Ollama → validate → write store
  │
genctx CLI
  │  index / pack / map / reindex / extract / gc / migrate
  │  mcp → Model Context Protocol server over stdio (read-only)
  │
genctx-core (library)
  ├── process.rs    plan() + process_file() - the single decision function
  ├── store.rs      <project>/.genctx/context.db - six fields, keyed by path and content hash
  ├── pack.rs       packed text, project map, search - header and USED BY computed at read time
  ├── filter.rs     .gitignore/.ignore/genctx_ignore/hidden checks for one file
  ├── extract.rs    top-of-file <<<GENCTX block detection and stripping
  ├── ollama.rs     Ollama client: local-only repo URLs, JSON answers, validation, retry
  ├── runtime.rs    daemon discovery file and token
  ├── config.rs     gencontext.yaml - per-file walk-up resolution
  ├── fsutil.rs     atomic file replacement
  ├── git.rs        "is this block committed?" check
  ├── migrate.rs    genctx 0.1 NTFS streams → store
  └── ads.rs        legacy NTFS stream reader/writer (migrate only)

cpctx (standalone binary)
      cpctx copy src dest   →  std::fs::copy, then source store → destination store
      cpctx setup           →  HKCU\Environment\Path + PowerShell profile
```

---

## Caveats

- **Context is per machine unless you share the folder.** `.genctx/` ignores itself in git, so a fresh clone starts without context. Run `genctx index` after cloning.
- **Files outside a project get no context.** The daemon ignores saves for files with no `gencontext.yaml`, `.genctx/` or `.git` above them, so it never scatters `.genctx/` folders next to stray files. Run `genctx init` to make a folder a project.
- **Renames outside VS Code are matched by content.** A file renamed *and* edited outside VS Code no longer matches its old context by hash, so it is regenerated. The old entry is removed by the next `genctx index` (or `genctx gc`).
- **Ollama must be running, with a model pulled.** If Ollama isn't running, or is running but no model has been pulled, the file is marked `error` in the status bar. Check Task Manager for `ollama.exe`, and run `ollama list` to confirm a model is present - see "Installing Ollama" above. Save the file again once Ollama is up to retry.
- **cpctx setup requires no admin rights.** It writes to `HKCU\Environment` (user-level, not system-level) and your PowerShell profile. No UAC prompt will appear.

## Licence

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
