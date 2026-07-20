const MAX_SOURCE_LENGTH = 10_000;
const MAX_DEPTH = 12;
const MAX_ALTERNATIVES = 50;

export function renderSpintax(source: string, seed: string): string {
  if (source.length < 1 || source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`Spintax source must contain 1-${MAX_SOURCE_LENGTH} characters`);
  }
  const state = { source, index: 0, random: seededRandom(seed) };
  const rendered = renderSequence(state, 0, false);
  if (state.index !== source.length) throw new Error("Invalid Spintax expression");
  return rendered;
}

interface ParserState {
  readonly source: string;
  index: number;
  readonly random: () => number;
}

function renderSequence(state: ParserState, depth: number, insideGroup: boolean): string {
  let output = "";
  while (state.index < state.source.length) {
    const character = state.source[state.index];
    if (character === "\\") {
      state.index += 1;
      if (state.index >= state.source.length) throw new Error("Spintax cannot end with an escape");
      output += state.source[state.index];
      state.index += 1;
      continue;
    }
    if (insideGroup && (character === "|" || character === "}")) break;
    if (character === "}") throw new Error("Spintax contains an unmatched closing brace");
    if (character !== "{") {
      output += character;
      state.index += 1;
      continue;
    }
    if (depth >= MAX_DEPTH) throw new Error(`Spintax nesting cannot exceed ${MAX_DEPTH}`);
    state.index += 1;
    const alternatives: string[] = [];
    while (true) {
      alternatives.push(renderSequence(state, depth + 1, true));
      if (alternatives.length > MAX_ALTERNATIVES) {
        throw new Error(`Spintax group cannot exceed ${MAX_ALTERNATIVES} alternatives`);
      }
      const separator = state.source[state.index];
      if (separator === "|") {
        state.index += 1;
        continue;
      }
      if (separator !== "}") throw new Error("Spintax contains an unclosed group");
      state.index += 1;
      break;
    }
    if (alternatives.length < 2 || alternatives.some((alternative) => alternative.length === 0)) {
      throw new Error("Spintax groups require at least two non-empty alternatives");
    }
    output += alternatives[Math.floor(state.random() * alternatives.length)];
  }
  return output;
}

function seededRandom(seed: string): () => number {
  let value = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}
