/**
 * Reading release notes out of a tag, for the one lane and the other.
 *
 * `%(contents)` does not fall through to an empty string on a lightweight tag — git resolves the
 * ref to the commit and hands back the *commit message*, so an unguarded read publishes an
 * internal commit subject as a release body (#815). `git cat-file -t` is what tells a real tag
 * object from a commit, and both release lanes gate on it here rather than each keeping a copy.
 */
import { spawnSync } from "node:child_process";

/** Undefined rather than a throw when git exits non-zero: every caller has a fallback. */
export function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : undefined;
}

export function readTagNotes(tag) {
  const kind = git(["cat-file", "-t", tag])?.trim();
  if (kind !== "tag") {
    console.error(
      `::notice::${tag} carries no annotation (git reads it as ${kind ?? "unreadable"}), so no authored ` +
        `notes go into the release body. To author them: git tag -a --cleanup=verbatim ${tag} -F notes.md`,
    );
    return undefined;
  }

  const notes = git(["tag", "-l", "--format=%(contents)", tag]);
  if (notes === undefined) {
    console.error(`::notice::the annotation on ${tag} could not be read, so the release body carries no notes.`);
  }
  return notes;
}
