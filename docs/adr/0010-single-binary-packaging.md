# 0010 — Single-binary packaging with `bun build --compile`

Status: accepted

## Context

Requirement 9: package the whole app as one executable that runs like a Mac
application, bonus for Windows/Linux. Electron-class shells are out of proportion for a
tool that is already a local web server.

## Decision

- `bun build --compile apps/server/src/index.ts --outfile dist/ghreporting` produces a
  single self-contained executable (Bun's supported, well-trodden path).
- The frontend is **embedded**: `scripts/gen-embed.ts` (make `generate`) walks
  `apps/web/dist/` and emits `apps/server/src/embedded.ts` with
  `import … with { type: "file" }` entries — files imported that way are packed into
  the compiled binary and served by a static route when no Vite dev server exists.
- Cross-compile via `--target=bun-darwin-arm64 | bun-windows-x64 | bun-linux-x64`
  (make `package-all`).
- macOS niceness: `make package-app` wraps the binary in a minimal
  `GH Reporting.app` bundle (Info.plist + launcher script that starts the server and
  opens `http://localhost:8787`). No signing/notarization in scope — local tool,
  right-click-open is acceptable; revisit only if the tool is ever distributed.

## Consequences

- One artifact, no runtime install for end users; SQLite, server, and UI travel
  together.
- The embed manifest is generated code — `make generate` must run after every
  frontend build (encoded in the `package` target's dependency chain, not in docs
  memory).
- Keychain/WebAuthn behavior is identical in packaged mode; only the origin changes
  (allow-listed per ADR 0007).

## Rejected alternatives

- **Electron/Tauri:** an app shell duplicating the browser for a tool whose UI is
  already a web page; heavier builds, native toolchains (Tauri needs Rust).
- **Docker:** wrong shape for a desktop tool needing Keychain + Touch ID.
- **`npm pack` + "install bun first":** fails the "runs as a Mac application" ask.
