import { describe, test, expect } from "bun:test";
import { Tokenizer } from "../../src/tokenizer";

describe("tokenizer", () => {
  test("loads vocab from file", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    expect(tok.vocabSize).toBe(6);
    expect(tok.blankId).toBe(5);
  });

  test("detokenizes token IDs to text", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    const text = tok.detokenize([0, 1]);
    expect(text).toBe("hello world");
  });

  test("handles blank tokens by skipping them", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    const text = tok.detokenize([0, 5, 1]);
    expect(text).toBe("hello world");
  });

  test("handles empty token list", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    const text = tok.detokenize([]);
    expect(text).toBe("");
  });

  test("handles only blank tokens", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    const text = tok.detokenize([5, 5, 5]);
    expect(text).toBe("");
  });

  test("joins subword tokens correctly", async () => {
    const tok = await Tokenizer.fromFile("fixtures/test-vocab.txt");
    const text = tok.detokenize([3, 4]);
    expect(text).toBe("cats");
  });

});
