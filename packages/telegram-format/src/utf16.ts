export function clampUtf16Boundary(text: string, index: number): number {
  let boundedIndex = Math.max(0, Math.min(index, text.length));

  if (
    boundedIndex > 0 &&
    boundedIndex < text.length &&
    isHighSurrogate(text.charCodeAt(boundedIndex - 1)) &&
    isLowSurrogate(text.charCodeAt(boundedIndex))
  ) {
    boundedIndex -= 1;
  }

  return boundedIndex;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
