# Stable release-tag helper

Create a stable engine tag only from a clean, current root checkout:

```bash
just release-tag vX.Y.Z notes.md
```

The helper fetches `origin/main`, refuses a used local or remote tag, makes the annotated tag
target that exact commit, pushes it, then reads the remote ref and tag object back. It verifies the
annotation, target, tagger identity, and the `build-engine.yml` push-triggered run.

If an SSH push cannot be attempted, choose the GitHub API path before creating anything:

```bash
just release-tag vX.Y.Z notes.md api
```

The fallback uses the authenticated maintainer's `gh` session. It creates the annotated tag object
and only then `refs/tags/vX.Y.Z`, as required by GitHub's Git database API. Because an API-created
ref does not provide the human `push` event used by the normal release lane, the helper explicitly
dispatches `build-engine.yml` at the new tag and verifies that run.

Never retry through `api` after a failed `push` without first proving the remote tag is absent. A
timeout can mean the remote accepted the tag; tags are one-use, so the helper fails closed instead
of guessing. This helper creates no release and does not publish npm packages.

Sources: [Create a tag object](https://docs.github.com/en/rest/git/tags?apiVersion=2022-11-28#create-a-tag-object), [Create a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference).
