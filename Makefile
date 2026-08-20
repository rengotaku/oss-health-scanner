SHELL := /bin/zsh
PORT ?= 3210
D1_NAME := oss-health
SEED := dev/seed-local.sql
SHOT_DIR ?= .shots

# Secrets live in `pass`, never in a committed file. `.dev.vars` is generated at
# run time and is gitignored; delete it with `make clean-secrets`.
PASS_GITHUB_TOKEN ?= oss-health-scanner/GITHUB_TOKEN

.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install dependencies from the lockfile
	npm ci

.PHONY: dev-vars
dev-vars: ## Generate .dev.vars from pass (fails closed if the secret is absent)
	@pass show $(PASS_GITHUB_TOKEN) >/dev/null 2>&1 || { \
		echo "pass entry '$(PASS_GITHUB_TOKEN)' not found. Add it with: pass insert $(PASS_GITHUB_TOKEN)" >&2; \
		exit 1; }
	@umask 077 && { \
		printf 'GITHUB_TOKEN=%s\n' "$$(pass show $(PASS_GITHUB_TOKEN))"; \
		printf 'OSSHS_RATE_LIMIT_PER_HOUR=10\n'; \
	} > .dev.vars
	@echo "wrote .dev.vars (gitignored)"

.PHONY: clean-secrets
clean-secrets: ## Remove the generated local secrets file
	rm -f .dev.vars

.PHONY: migrate
migrate: ## Apply D1 migrations to the local database
	npx wrangler d1 migrations apply $(D1_NAME) --local

.PHONY: migrate-remote
migrate-remote: ## Apply D1 migrations to the deployed database
	npx wrangler d1 migrations apply $(D1_NAME) --remote

.PHONY: seed
seed: ## Load the local UI fixture into the local D1 database
	npx wrangler d1 execute $(D1_NAME) --local --file $(SEED)

.PHONY: run
run: ## Start the dev server on $(PORT)
	npx next dev -p $(PORT)

.PHONY: stop
stop: ## Stop whatever is listening on $(PORT)
	@pids=$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN); \
	if [ -z "$$pids" ]; then echo "nothing listening on $(PORT)"; else \
		echo "$$pids" | while read -r pid; do echo "killing $$pid"; kill "$$pid"; done; fi

.PHONY: status
status: ## Show what is listening on $(PORT)
	@lsof -i tcp:$(PORT) -sTCP:LISTEN || echo "nothing listening on $(PORT)"

.PHONY: test
test: ## Run the unit tests
	npx vitest run

.PHONY: typecheck
typecheck: ## Type-check without emitting
	npx tsc --noEmit

.PHONY: lint
lint: ## Lint
	npx eslint . --ignore-pattern next-env.d.ts --ignore-pattern cloudflare-env.d.ts

.PHONY: build
build: ## Production build (this is what CI checks; `test` alone does not type-check JSX)
	npx next build

.PHONY: ci
ci: typecheck lint test build ## Everything CI runs

.PHONY: types
types: ## Regenerate cloudflare-env.d.ts from wrangler.jsonc
	npx wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts

.PHONY: shots
shots: ## Screenshot the three breakpoints in both colour schemes (needs `make run` + `make seed`)
	@mkdir -p $(SHOT_DIR)
	node dev/shot.mjs $(SHOT_DIR) light
	node dev/shot.mjs $(SHOT_DIR) dark

.PHONY: preview
preview: ## Build for Workers and run it locally through workerd
	npx opennextjs-cloudflare build && npx opennextjs-cloudflare preview

.PHONY: deploy
deploy: ## Build and deploy to Cloudflare Workers
	npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy
