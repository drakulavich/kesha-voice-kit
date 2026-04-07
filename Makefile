.PHONY: test unit integration lint smoke-test release publish

test: unit integration

unit:
	bun run test:unit

integration:
	bun run test:integration

lint:
	bunx tsc --noEmit

smoke-test:
	bun link
	parakeet install
	bun scripts/smoke-test.ts

release: lint test smoke-test
	@echo "All checks passed. Ready to publish."

publish: release
	npm publish --access public
