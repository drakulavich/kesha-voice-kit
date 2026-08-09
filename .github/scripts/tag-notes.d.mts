// The module stays .mjs: both release workflows run their scripts under node.
export function git(args: string[]): string | undefined;
export function readTagNotes(tag: string): string | undefined;
