import { closest, distance } from "fastest-levenshtein";

export function suggestCommand(input: string, commands: string[]): string | null {
  if (!input || commands.length === 0) return null;

  const lowerInput = input.toLowerCase();
  const lowerCommands = commands.map((c) => c.toLowerCase());

  // Exact match — return as-is
  const exactIdx = lowerCommands.indexOf(lowerInput);
  if (exactIdx !== -1) return commands[exactIdx];

  const match = closest(lowerInput, lowerCommands);
  const dist = distance(lowerInput, match);

  // Threshold: distance <= 3 AND distance <= 40% of target length
  const maxDist = Math.min(3, Math.ceil(match.length * 0.4));
  if (dist > maxDist) return null;

  // Return the original-cased command
  const idx = lowerCommands.indexOf(match);
  return commands[idx];
}
