export class Tokenizer {
  private idToToken: Map<number, string>;
  readonly vocabSize: number;
  readonly blankId: number;

  private constructor(idToToken: Map<number, string>, blankId: number) {
    this.idToToken = idToToken;
    this.vocabSize = idToToken.size;
    this.blankId = blankId;
  }

  static async fromFile(path: string): Promise<Tokenizer> {
    const content = await Bun.file(path).text();
    const idToToken = new Map<number, string>();
    let blankId = -1;

    for (const line of content.trim().split("\n")) {
      const lastSpace = line.lastIndexOf(" ");
      if (lastSpace === -1) continue;
      const token = line.slice(0, lastSpace);
      const id = parseInt(line.slice(lastSpace + 1), 10);
      if (isNaN(id)) continue;
      idToToken.set(id, token);
      if (token === "<blk>") blankId = id;
    }

    if (blankId === -1) {
      blankId = idToToken.size - 1;
    }

    return new Tokenizer(idToToken, blankId);
  }

  detokenize(tokenIds: number[]): string {
    const pieces: string[] = [];
    for (const id of tokenIds) {
      if (id === this.blankId) continue;
      const token = this.idToToken.get(id);
      if (token !== undefined) pieces.push(token);
    }
    return pieces.join("").replaceAll("\u2581", " ").trim();
  }

  isAsciiDominant(tokenIds: number[], threshold = 0.9): boolean {
    const nonBlank = tokenIds.filter((id) => id !== this.blankId);
    if (nonBlank.length === 0) return false;

    let asciiCount = 0;
    for (const id of nonBlank) {
      const token = this.idToToken.get(id) ?? "";
      const cleaned = token.replaceAll("\u2581", "");
      if (cleaned.length > 0 && /^[\x00-\x7F]+$/.test(cleaned)) {
        asciiCount++;
      }
    }

    return asciiCount / nonBlank.length >= threshold;
  }
}
