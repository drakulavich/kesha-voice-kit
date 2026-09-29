/** Errnos that mean the path itself is wrong for writing, so the fix is a different path; anything else is not a bad argument. */
export const PATH_ERRNOS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOTDIR: "a component of it is a file, not a directory",
  // mkdir(recursive) raises this, not ENOTDIR, when the directory itself is an existing file.
  EEXIST: "it already exists as a file, not a directory",
  EROFS: "the filesystem is read-only",
  ELOOP: "the path loops through symlinks",
  ENAMETOOLONG: "the path is too long",
};
