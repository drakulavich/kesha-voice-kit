.PHONY: test unit integration lint smoke-test release publish help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

test: unit integration ## Run all tests

unit: ## Run unit tests
	bun run test:unit

integration: ## Run integration tests
	bun run test:integration

lint: ## Type-check with tsc
	bunx tsc --noEmit

smoke-test: ## Run smoke tests against fixtures
	bun link
	parakeet install
	bun scripts/smoke-test.ts

benchmark-coreml: ## Run CoreML vs CoreML benchmark (macOS only)
	bun scripts/benchmark-coreml.ts

release: lint test smoke-test ## Verify everything before publish
	@echo "All checks passed. Ready to publish."

publish: release ## Publish to npm
	npm publish --access public
