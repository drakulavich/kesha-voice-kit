#!/usr/bin/env bun
/** Fails when a documented `just <recipe>` does not exist, or a recipe has no doc comment (#797). */
type Recipe = { doc?: string | null; private?: boolean };
export type JustDump = { recipes?: Record<string, Recipe>; aliases?: Record<string, unknown> };
export type CommandLine = { line: number; text: string };
export type Reference = { line: number; recipe: string; text: string };

export function isSwept(_path: string): boolean {
  return false;
}

export function sweptFiles(_root: string): string[] {
  return [];
}

export function commandLines(_path: string, _contents: string): CommandLine[] {
  return [];
}

export function referencedRecipes(_path: string, _contents: string): Reference[] {
  return [];
}

export function knownRecipeNames(_dump: JustDump): Set<string> {
  return new Set();
}

export function unknownReferences(_path: string, _contents: string, _known: Set<string>): string[] {
  return [];
}

export function undocumentedRecipes(_dump: JustDump): string[] {
  return [];
}
