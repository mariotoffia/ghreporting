SHELL := /bin/bash
PREFIX ?= $(HOME)/.local
.PHONY: help setup generate serve-backend serve-frontend serve-all lint lint-fix vet test \
        test-integration build package package-app package-all install bench clean

help: ## Show all targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

setup: ## Install toolchain dependencies (requires bun >= 1.3)
	@command -v bun >/dev/null 2>&1 || { echo "bun missing — install with: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	bun install

generate: ## Regenerate the embedded UI manifest (apps/server/src/embedded.ts) from apps/web/dist
	bun scripts/gen-embed.ts

serve-backend: ## Run API server with hot reload on :8787
	cd apps/server && bun run dev

serve-frontend: ## Run Vite dev server on :5173 (proxies /api to :8787)
	cd apps/web && bun run dev

serve-all: ## Run backend + frontend together
	@$(MAKE) -j2 serve-backend serve-frontend

lint: ## Biome lint + format check (see LINT.md)
	bunx biome check .

lint-fix: ## Auto-fix lint and formatting issues
	bunx biome check --write .

vet: ## Typecheck every workspace with tsc --noEmit
	bunx tsc -p packages/domain && bunx tsc -p apps/server && bunx tsc -p apps/web

test: ## Unit tests (live GitHub integration tests are skipped by default)
	bun test

test-integration: ## Unit + live GitHub integration tests (needs GH_TOKEN; see TESTS.md)
	RUN_GH_LIVE=1 bun test

build: ## Typecheck + build the production frontend bundle
	$(MAKE) vet
	cd apps/web && bun run build

package: ## Build UI + compile one self-contained executable → dist/ghreporting
	$(MAKE) build
	$(MAKE) generate
	@echo "compiling dist/ghreporting …"
	bun build --compile apps/server/src/index.ts --outfile dist/ghreporting; \
	  status=$$?; git checkout -- apps/server/src/embedded.ts; \
	  find . -maxdepth 1 -name '*.bun-build' -delete; exit $$status

package-app: ## Wrap the binary in a double-clickable dist/GH Reporting.app (macOS)
	$(MAKE) package
	bash scripts/make-app.sh

package-all: ## Cross-compile darwin-arm64 / windows-x64 / linux-x64 binaries → dist/
	$(MAKE) build
	$(MAKE) generate
	@set -e; status=0; \
	  for t in bun-darwin-arm64 bun-windows-x64 bun-linux-x64; do \
	    out="dist/ghreporting-$${t#bun-}"; [ "$$t" = bun-windows-x64 ] && out="$$out.exe"; \
	    echo "compiling $$out …"; \
	    bun build --compile --target=$$t apps/server/src/index.ts --outfile "$$out" || status=$$?; \
	  done; \
	  git checkout -- apps/server/src/embedded.ts || true; \
	  find . -maxdepth 1 -name '*.bun-build' -delete; exit $$status

install: package ## Install the compiled binary to $(PREFIX)/bin (override PREFIX=/usr/local)
	install -d "$(PREFIX)/bin"
	install -m 755 dist/ghreporting "$(PREFIX)/bin/ghreporting"
	@echo "installed → $(PREFIX)/bin/ghreporting (ensure $(PREFIX)/bin is on your PATH)"

bench: ## Run benchmarks (see IMPLEMENTATION_PLAN.md task T11.2)
	@echo "not implemented yet — see IMPLEMENTATION_PLAN.md task T11.2"; exit 1

clean: ## Remove installed dependencies and build artifacts
	rm -rf node_modules apps/server/node_modules apps/web/node_modules packages/domain/node_modules apps/web/dist dist
	find . -maxdepth 1 -name '*.bun-build' -delete
