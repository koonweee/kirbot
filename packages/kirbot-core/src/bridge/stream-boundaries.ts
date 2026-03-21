export function hasFlushBoundary(text: string): boolean {
  return splitFlushablePrefix(text)[0].length > 0;
}

export function splitFlushablePrefix(text: string): [string, string] {
  if (text.length === 0) {
    return ["", ""];
  }

  let inCodeFence = false;
  let lastBoundaryIndex = -1;
  let lineStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    const next = text[index + 1];
    const nextTwo = text.slice(index, index + 3);

    if (nextTwo === "```") {
      inCodeFence = !inCodeFence;
      index += 2;
      continue;
    }

    if (!inCodeFence && current === "\n") {
      const previous = text[index - 1];
      if (previous === "\n") {
        lastBoundaryIndex = index + 1;
      } else if (isStructuredLine(text.slice(lineStart, index))) {
        lastBoundaryIndex = index + 1;
      }
      lineStart = index + 1;
      continue;
    }

    if (
      !inCodeFence &&
      isSentenceTerminator(current, text[index - 1] ?? "") &&
      (next === undefined || isBoundaryFollower(next))
    ) {
      lastBoundaryIndex = index + 1;
    }
  }

  if (lastBoundaryIndex < 0) {
    return ["", text];
  }

  return [text.slice(0, lastBoundaryIndex), text.slice(lastBoundaryIndex)];
}

function isSentenceTerminator(char: string, previousChar: string): boolean {
  if (char === "." && /\d/.test(previousChar)) {
    return false;
  }

  return char === "." || char === "?" || char === "!";
}

function isBoundaryFollower(char: string): boolean {
  return /\s/.test(char);
}

function isStructuredLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) {
    return false;
  }

  if (/^[-*+]\s+\S/.test(trimmed)) {
    return true;
  }

  if (/^\d+\.\s+\S/.test(trimmed)) {
    return true;
  }

  return false;
}
