// The module stays .mjs: the workflows run its callers under node, which cannot import a .ts.
export function isEntry(moduleUrl: string): boolean;
export function entryArg(moduleUrl: string, usage: string): string | undefined;
