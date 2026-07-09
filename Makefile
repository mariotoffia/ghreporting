SHELL := /bin/bash
.PHONY: help setup generate serve-backend serve-frontend serve-all lint lint-fix vet test \
        test-integration build package bench clean

help: ## Show all targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

setup: ## Install toolchain dependencies (requires bun >= 1.3)
	@command -v bun >/dev/null 2>&1 || { echo "bun missing — install with: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	bun install

generate: ## Code generation (embed manifest for packaging — arrives with T10.1)
	@echo "nothing to generate yet (see IMPLEMENTATION_PLAN.md task T10.1)"

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

package: ## Package as a single executable (see IMPLEMENTATION_PLAN.md task T10.1)
	@echo "not implemented yet — see IMPLEMENTATION_PLAN.md task T10.1"; exit 1

bench: ## Run benchmarks (see IMPLEMENTATION_PLAN.md task T11.2)
	@echo "not implemented yet — see IMPLEMENTATION_PLAN.md task T11.2"; exit 1

clean: ## Remove installed dependencies and build artifacts
	rm -rf node_modules apps/server/node_modules apps/web/node_modules packages/domain/node_modules apps/web/dist dist
