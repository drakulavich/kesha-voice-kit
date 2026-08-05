import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return out.trim();
}

/** A work tree with a real bare remote, so a script's push is exercised rather than stubbed. */
export async function gitRepoWithRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kesha-git-"));
  created.push(dir);
  const work = join(dir, "work");

  await git(dir, "init", "--bare", "-q", join(dir, "remote.git"));
  await git(dir, "init", "-q", work);
  await git(work, "config", "user.email", "test@example.com");
  await git(work, "config", "user.name", "test");
  await git(work, "remote", "add", "origin", join(dir, "remote.git"));
  await Bun.write(join(work, "f"), "base\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-qm", "base");
  return work;
}

export async function commit(work: string, subject: string): Promise<void> {
  await Bun.write(join(work, "f"), `${subject}\n`);
  await git(work, "commit", "-qam", subject);
}

export function cleanupGitRepos(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
