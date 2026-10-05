# Stable release-tag helper

Create a stable release tag only from a clean, current root checkout:

```bash
just release-tag vX.Y.Z notes.md
```

The helper refuses notes without a fully ticked `## Dogfood` checklist ([docs/dogfood.md](../dogfood.md)), fetches `origin/main`, refuses a used local or remote tag, makes the annotated tag
target that exact commit, pushes it, then reads the remote ref and tag object back. It verifies the
annotation, target, tagger identity, and the push-triggered `release.yml` run.

If an SSH push cannot be attempted, choose the GitHub API path before creating anything:

```bash
just release-tag vX.Y.Z notes.md api
```

The fallback uses the authenticated maintainer's `gh` session. It creates the annotated tag object
and only then `refs/tags/vX.Y.Z`, as required by GitHub's Git database API, and then waits for the
same push-triggered `release.yml` run. A ref created with the maintainer's own token fires `push`
like a `git push`; only one created with `GITHUB_TOKEN` starts no run. This repository has not yet
exercised the API mode against `release.yml`, so prefer the default `push` mode. `release.yml` refuses a stable dispatch, so there is no
dispatch fallback: if no run appears, check the Actions tab before doing anything else.

Never retry through `api` after a failed `push` without first proving the remote tag is absent. A
timeout can mean the remote accepted the tag; tags are one-use, so the helper fails closed instead
of guessing. The helper itself creates no release; the `release.yml` run it starts publishes
everything. The full procedure is the `release` skill.

Sources: [Create a tag object](https://docs.github.com/en/rest/git/tags?apiVersion=2022-11-28#create-a-tag-object), [Create a reference](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference).
