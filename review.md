# Code Review — genctx

**Second pass 2026-10-02 on branch `cleanup/2026-10-02`: the author's fork
adopted, one bug fixed, the extension tested. 83 Rust tests and 21 extension
tests passing.** The 2026-09-04 review follows below, unchanged; every item in
its checklist is settled, as the table says.

## What changed on 2026-10-02

The author forked this project under `manishmajhimidackertech` and made every
improvement there. The fork, downloaded on 2026-09-28 as `genctx-forked.zip`,
was brought in byte for byte (commit `3178751`), so `git diff 3178751` shows
only what this pass did. Nothing in the archive copy was missing from the fork.

The fork is a different program from the one reviewed below. Context lives in a
SQLite store per project at `.genctx/context.db`, not in NTFS streams, so it
works on any file system and survives zip, sync and git. `ads.rs` survives only
for `genctx migrate`. There is an MCP server, a CI workflow on three OSes, and
81 tests, up from 34.

| 2026-09-04 item | Status, checked in the code |
| --- | --- |
| P1 unauthenticated daemon | **Fixed in the fork.** The first line must carry a per-session token from a user-private discovery file (`crates/daemon/src/main.rs:294`), and saves outside a project are ignored (`process.rs`, `SkippedNoProject`). A token rather than a named pipe, which was the review's second option. |
| P1 `Cargo.lock` ignored | **Fixed in the fork.** Committed, and CI builds `--locked`. |
| P2 verify command for lost streams | **Moot.** Streams are no longer the store. |
| P2 non-interpolating bind error | **Fixed in the fork.** The port is OS-assigned and the error uses `format!`. |
| P3 document what drops streams | **Moot**, for the same reason. The README's history note covers it. |
| P3 `authors`, protocol version | `authors = ["genctx"]` is still a placeholder, left as the author's choice. The welcome message now carries the daemon's version. |
| `config.rs` unwraps | All in its test module. |

What this pass did, one commit each:

- **Tracked this file** (`0eab7b4`). It had never been committed.
- **Re-applied the personal-use licence** (`3428645`). The fork predates the
  licence pass and said MIT again. The four crates must say
  `license-file.workspace` once the workspace does, or Cargo will not load
  them. The first attempt at this commit missed that, and the test run caught
  it before it was kept.
- **Fixed a bug: files with a UTF-8 BOM never got context on save**
  (`4ce909d`). After the 30-second debounce, the daemon re-hashes the file and
  compares it with the hash the extension sent. The extension hashes VS Code's
  document text, which never holds the BOM (read from VSCodium's own
  `workbench.desktop.main.js`: the decoder strips it and `addBOM` writes it
  back on save). So the hashes never matched, the daemon decided the file had
  "changed on disk", and it returned without generating or reporting. The
  status bar stayed on "queued" for good. Visual Studio and Windows PowerShell
  5.1 write BOMs by default. The regression test failed against the original
  comparison before the fix. **The fork on GitHub still has this bug.**
- **Tested the extension** (`07d2145`), which had no tests. There are 17
  `node --test` cases for the daemon client against a real local TCP server,
  and 4 for the content hash, whose vectors are now pinned on the Rust side
  too. No defect turned up there. Three mutations of the compiled client were
  each caught by the test meant to catch them. `npm test` runs them, and so
  does CI.
- **Documented the tests** (`83e18dd`) in `docs/REBUILDING.md`, and added
  `LICENSE`, `docs/REBUILDING.md` and `tests/` to the README's layout.

**Every commit was checked out into its own worktree on D: and tested there.**
Rust: 81, 81, 82, 83, 83. Extension: 21 and 21 for the two commits that have
the suite. `cargo fmt --check` and `clippy -D warnings`, the fork's own CI
gates, are clean.

`docs/genctx_tracker.md` stays: the 2026-09-04 review called it a deliberate,
living document, and the fork keeps it current.

## Notes for a future session

Rust is installed at `D:\dev-tools\rustup` and `D:\dev-tools\cargo` (stable,
`x86_64-pc-windows-gnu`; `rustup-init` added nothing to `PATH`). The GNU target
needs a MinGW with `libgcc_eh`, which TDM-GCC, first on `PATH` here, lacks. Put
MSYS2's first. Keep `target/` out of the archive with `CARGO_TARGET_DIR`:

```bash
export RUSTUP_HOME='D:\dev-tools\rustup' CARGO_HOME='D:\dev-tools\cargo' \
       CARGO_TARGET_DIR='D:\dev-tools\tmp\genctx-target' GENCTX_NO_UPDATE_CHECK=1 \
       PATH="/d/dev-tools/cargo/bin:/d/dev-tools/msys64/mingw64/bin:$PATH"
cargo test --workspace --locked                            # 83
cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings
cd vscode-extension && npm test                            # 21
```

The real home is the fork. Anything fixed here, starting with `4ce909d`, has
to be carried there by the author.

---

Reviewed 2026-09-04 against the working tree. Scope: workspace `Cargo.toml`, `crates/core`
(`ads.rs`, `config.rs`, `extract.rs`, `ollama.rs`, `process.rs`), `crates/daemon`, `crates/cli`,
`crates/cpctx`, `README.md`, `docs/`, `.gitignore`.

## What this project is

A Windows tool that stores a per-file LLM context block in an NTFS Alternate Data Stream so it never
appears in the repository. A VS Code extension notifies a background daemon on save; the daemon
either extracts an inline `<<<GENCTX` block or, after a debounce, asks a local Ollama model to
generate one, then writes it to the hidden stream. A CLI packs context plus source to the clipboard,
and `cpctx` is a copy tool that preserves the streams.

## Verdict

Structurally this is the most professional project in the archive. A four-crate workspace with a
clear role per crate, `unsafe` confined entirely to the Win32 ADS wrapper in `ads.rs`, almost no
`unwrap()` outside config and test code, 34 test annotations, `thiserror`/`anyhow` used correctly,
`tracing` instead of `println!` in the daemon, a bounded semaphore around Ollama calls, and a
port-fallback bind that reports the port it actually got. The documentation set is excellent, and
`cpctx` exists specifically because you recognised that ADS data silently dies on an ordinary copy —
that is the kind of foresight most projects skip.

Two things need attention: the daemon accepts commands from any local process with no authentication,
and `Cargo.lock` is being ignored in a workspace that ships binaries.

## Critical issues

**1. The daemon's control port is unauthenticated and unscoped.**
`handle_connection` (`crates/daemon/src/main.rs:195`) reads newline-delimited JSON and acts on
`InboundMessage::Save { path, hash }` with no credential check and no validation that `path` is
inside a known workspace. Binding to `127.0.0.1` limits this to the local machine, which is the right
first step — but on a desktop, "any local process running as you" includes every npm postinstall
script, every VS Code extension, and anything else you have ever run.

The concrete abuse: scan ports from the documented base port upward, send
`{"type":"save","path":"C:\\Users\\you\\.ssh\\id_rsa", ...}`, and the daemon will read that file and
hand its contents to the Ollama endpoint, then write a hidden stream onto it. Whether that is
"exfiltration" depends on where the configured Ollama endpoint points — which is exactly the sort of
thing that should not depend on configuration.

Two fixes, both straightforward:

- **Replace the TCP listener with a Windows named pipe** and an ACL limited to the current user. This
  is the idiomatic local-IPC mechanism on Windows and removes the port-scanning surface entirely.
- **If TCP stays, require a shared secret.** Write a random token to a file under `%LOCALAPPDATA%`
  with user-only permissions at daemon startup, have the extension read it, and reject any connection
  that does not present it as its first line.

Independently of the transport, **validate that `path` lies under a configured root** before reading
it. That single check turns "read any file on the machine" into "read files in projects the user has
opted in to".

**2. `Cargo.lock` is in `.gitignore`.** For a workspace whose members are binaries, the lock file
should be committed — that is the Cargo convention precisely because it makes a build reproducible.
It matters more than usual here: the workspace manifest pins `clap = "=4.4.18"` and
`zeroize = "=1.8.1"` specifically to keep transitive dependencies off edition2024, with a comment
saying so. Without the lock file, some *other* transitive dependency makes the same jump and the
build breaks for the next person who clones, for reasons that have nothing to do with your code. Take
`Cargo.lock` out of `.gitignore` and commit it.

## Design considerations worth documenting

**3. ADS is an unusually fragile place for data you care about.** The README is honest about this and
`cpctx` addresses the copy case directly, which is more than most projects would do. But the failure
list is longer than copying: the streams are lost when a file is zipped, emailed, uploaded to any
web service, checked into git and checked out again, synced through OneDrive or Dropbox, or written
to a FAT32/exFAT USB stick — and in every one of those cases the loss is **silent**. Nothing warns
you; the context is simply gone.

Worth adding: a `genctx doctor` or `genctx verify` command that walks a project and reports which
files have lost their stream. That turns silent data loss into something you can detect, and it is
maybe fifty lines given `ads.rs` already exists.

**4. The 30-second Ollama debounce runs against an in-memory `DebounceMap`.** If the daemon restarts
during that window, pending work is dropped with no record. Acceptable for the use case, but say so
in the docs so a user who restarts the daemon does not wonder why a file never got context.

## Smaller notes

- `authors = ["genctx"]` in the workspace package is a placeholder. Either put your name there or
  drop the field.
- The `.context("failed to bind on any port in range {DAEMON_PORT}–{DAEMON_PORT+PORT_RETRY_COUNT}")`
  at `daemon/src/main.rs:128` uses braces inside a plain string literal, not a format macro — the
  message will print the literal `{DAEMON_PORT}` rather than the value. Use `format!` or
  `with_context(|| format!(...))`.
- `config.rs` holds 10 of the workspace's 16 `unwrap`/`expect` calls. Worth a pass to confirm they are
  all in test code or on genuinely infallible paths.
- The version is `0.1.0` across a project with three shipped binaries and an extension. Once the
  named-pipe or token change lands, the extension and daemon must agree on the protocol — bump the
  version and have the daemon reject mismatched clients with a clear message rather than a parse
  warning.

## Cleanup

Very little to do. `docs/genctx_tracker.md` is a deliberate, documented artifact — the README
describes it as the internal dev log to hand to a session resuming work, and it is doing that job.
Keep it and keep it current. The `println!` usage is confined to the CLI tools where printing is the
output, and the daemon uses `tracing` properly.

No secrets, no dead code, no committed build artifacts, no analytics. `.gitignore` is otherwise
well-formed.

## Action checklist

- [ ] **P1** Authenticate the daemon channel (named pipe preferred) and validate `path` against a
      configured root.
- [ ] **P1** Remove `Cargo.lock` from `.gitignore` and commit it.
- [ ] **P2** Add a verify command that reports files whose ADS context has been lost.
- [ ] **P2** Fix the non-interpolating `.context(...)` string in the daemon's bind error.
- [ ] **P3** Document the full list of operations that silently drop ADS data.
- [ ] **P3** Replace the placeholder `authors` field; add protocol version negotiation.

## Notes for a future session

Build with `cargo build --release` from the workspace root; the three binaries land in
`target/release`. Run the tests with `cargo test --workspace`. Read `docs/genctx_tracker.md` first —
it is the project's own current-state document. The `unsafe` in `crates/core/src/ads.rs` is the only
place memory safety is on you rather than the compiler; every handle opened there needs its
`CloseHandle`, so review that file as a unit rather than editing individual calls.
