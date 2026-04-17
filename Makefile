.PHONY: install test unit integration lint smoke-test release publish help

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

test: unit integration ## Run all tests

unit: ## Run unit tests
	bun run test:unit

integration: ## Run integration tests
	bun run test:integration

lint: ## Type-check with tsc
	bunx tsc --noEmit

smoke-test: ## Run smoke tests against fixtures
	bun link @drakulavich/kesha-voice-kit
	kesha install
	bun scripts/smoke-test.ts

smoke-test-tts: ## Run smoke tests with TTS (requires espeak-ng)
	bun link @drakulavich/kesha-voice-kit
	kesha install --tts
	bun scripts/smoke-test.ts --tts

benchmark: ## Run benchmark (openai-whisper vs faster-whisper vs Kesha)
	bun scripts/benchmark.ts

release: lint test smoke-test ## Verify everything before publish
	@echo "All checks passed. Ready to publish."

publish: release ## Publish to npm
	npm publish --access public
