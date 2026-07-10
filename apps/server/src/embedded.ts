// Overwritten by `make generate` for packaged builds. Keep the empty default committed.
// (A non-empty manifest carries `import … with { type: "file" }` lines that only the
// Bun bundler resolves — never commit them; `make package` restores this file after.)
export const embedded: Record<string, string> = {};
