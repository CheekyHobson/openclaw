// The supported browser floor includes Segmenter; don't split emoji into code points.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const truncations = new Map<string, string>();

export function takeGraphemes(input: string, limit: number): string {
  // Bound both entry count and retained text; long content is not reusable identity chrome.
  const key = input.length <= 1_024 ? `${limit}:${input}` : undefined;
  const cached = key === undefined ? undefined : truncations.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(input)) {
    result += segment;
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  if (key !== undefined) {
    if (truncations.size >= 256) {
      truncations.clear();
    }
    truncations.set(key, result);
  }
  return result;
}
