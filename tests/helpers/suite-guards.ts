/**
 * Reads an integration suite and answers two questions: does it drive a real engine, and is
 * every case it declares behind one of the sanctioned guards. `tests/unit/model-suite-guards.test.ts`
 * turns the answers into a gate; `tests/integration/README.md` states the convention.
 *
 * Detection is by named import and by the source-built engine path — never by grepping test
 * bodies for words like "spawn". A guard lint that misfires teaches people to ignore it, so
 * this one is deliberately blind to a suite that reaches the engine by some other route.
 */

export interface ImportStatement {
  bindings: string;
  specifier: string;
}

export interface UngatedCase {
  line: number;
  declaration: string;
  reason: string;
}

const BUILT_ENGINE_PATH = "rust/target/release/kesha-engine";

/** Windows checks out CRLF; nothing here is about line endings. */
function normalize(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

const IMPORT = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm;

export function importStatements(source: string): ImportStatement[] {
  return [...normalize(source).matchAll(IMPORT)].map((m) => ({
    bindings: m[1]!,
    specifier: m[2]!,
  }));
}

const SEAMS: Array<{
  dependency: string;
  detect: (imports: ImportStatement[], source: string) => boolean;
}> = [
  {
    dependency: "a functional installed engine (engineGate)",
    detect: (imports) =>
      imports.some((i) => i.specifier.endsWith("helpers/model-gate") && /\bengineGate\b/.test(i.bindings)),
  },
  {
    dependency: "the weights a lane promised (modelsRequired)",
    detect: (imports) =>
      imports.some((i) => i.specifier.endsWith("helpers/model-gate") && /\bmodelsRequired\b/.test(i.bindings)),
  },
  {
    dependency: "the installed engine binary (getEngineBinPath)",
    detect: (imports) =>
      imports.some((i) => i.specifier.endsWith("src/engine") && /\bgetEngineBinPath\b/.test(i.bindings)),
  },
  {
    dependency: `a source-built engine (${BUILT_ENGINE_PATH})`,
    detect: (_imports, source) => source.includes(BUILT_ENGINE_PATH),
  },
];

/** Which real-engine dependencies the suite names, or `[]` when it drives only fakes. */
export function engineDependencies(source: string): string[] {
  const normalized = normalize(source);
  const imports = importStatements(normalized);
  return SEAMS.filter((s) => s.detect(imports, normalized)).map((s) => s.dependency);
}

/** What a guard constant may ultimately be derived from. */
const GATE_SEEDS = [
  /\bengineGate\s*\(/,
  /\bmodelsRequired\s*\(/,
  /\bgetEngineBinPath\s*\(/,
  /\bprocess\.env\.KOKORO_(?:MODEL|VOICE)\b/,
  new RegExp(BUILT_ENGINE_PATH.replace(/\//g, "\\/")),
];

const CONST_DECL = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);[ \t]*$/gm;

/**
 * Top-level constants a `skipIf` may legitimately name: those seeded by a real-engine probe,
 * plus anything derived from one (`engineGateResult` → `engineInstalled`), to a fixpoint.
 */
export function gateIdentifiers(source: string): string[] {
  const declarations = [...normalize(source).matchAll(CONST_DECL)].map((m) => ({
    name: m[1]!,
    initializer: m[2]!,
  }));
  const gates = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, initializer } of declarations) {
      if (gates.has(name)) continue;
      const seeded = GATE_SEEDS.some((seed) => seed.test(initializer));
      const derived = [...gates].some((gate) => new RegExp(`\\b${gate}\\b`).test(initializer));
      if (seeded || derived) {
        gates.add(name);
        changed = true;
      }
    }
  }
  return [...gates];
}

const DECLARATION = /^([ \t]*)(describe|test|it)((?:\.[A-Za-z]+(?:\([^\n]*?\))?)*)\s*\(/;

function coveringGate(modifiers: string, gates: string[]): boolean {
  const skipIf = modifiers.match(/\.skipIf\(([^\n]*?)\)/);
  if (!skipIf) return false;
  return gates.some((gate) => new RegExp(`\\b${gate}\\b`).test(skipIf[1]!));
}

/**
 * Cases the suite declares unconditionally with no sanctioned guard above or on them.
 *
 * Scope comes from indentation, which prettier makes reliable here. Two consequences worth
 * knowing: a case nested in a `describe` inherits that describe's guard, and a case declared
 * outside every `describe` but still indented sits inside a conditional block — the shape the
 * `requiredFailure` raisers use to fail a lane that promised an engine (#741, #857) — so it is
 * left alone rather than reported.
 */
export function ungatedCases(source: string): UngatedCase[] {
  const gates = gateIdentifiers(source);
  const findings: UngatedCase[] = [];
  const scopes: Array<{ indent: number; gated: boolean }> = [];
  const lines = normalize(source).split("\n");

  lines.forEach((line, index) => {
    const match = line.match(DECLARATION);
    if (!match) return;
    const [, indent, callee, modifiers] = match as unknown as [string, string, string, string];
    const depth = indent.length;

    while (scopes.length > 0 && scopes[scopes.length - 1]!.indent >= depth) scopes.pop();

    const inherited = scopes.some((s) => s.gated);
    const covered = inherited || coveringGate(modifiers, gates);

    if (callee === "describe") {
      scopes.push({ indent: depth, gated: covered });
      return;
    }
    if (covered) return;
    // Outside every describe and still indented: declared inside a conditional block.
    if (scopes.length === 0 && depth > 0) return;

    const declaration = line.trim();
    findings.push({
      line: index + 1,
      // Prettier breaks a long case onto the next line, where its name is.
      declaration: declaration.endsWith("(") ? `${declaration} ${lines[index + 1]?.trim() ?? ""}` : declaration,
      reason: /\.skipIf\(/.test(modifiers)
        ? "its skipIf names no constant derived from a real-engine probe"
        : "neither it nor an enclosing describe carries a skipIf naming a real-engine gate",
    });
  });

  return findings;
}
