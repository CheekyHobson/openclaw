import { describe, expect, it, vi } from "vitest";
import { takeGraphemes } from "./graphemes.ts";

describe("takeGraphemes", () => {
  it("reuses each string and limit without splitting grapheme clusters", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const text = "👩🏽‍💻e\u0301🇦🇹suffix";
    expect(takeGraphemes(text, 2)).toBe("👩🏽‍💻e\u0301");
    expect(takeGraphemes(text, 3)).toBe("👩🏽‍💻e\u0301🇦🇹");
    expect(takeGraphemes(text, 2)).toBe("👩🏽‍💻e\u0301");
    expect(segment).toHaveBeenCalledTimes(2);
  });

  it("bounds retained entries and leaves large strings uncached", () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    takeGraphemes("evicted-label", 1);
    for (let index = 0; index < 256; index += 1) {
      takeGraphemes(`bounded-label-${index}`, 1);
    }
    segment.mockClear();
    expect(takeGraphemes("evicted-label", 1)).toBe("e");
    const large = "x".repeat(1_025);
    expect(takeGraphemes(large, 2)).toBe("xx");
    expect(takeGraphemes(large, 2)).toBe("xx");
    expect(segment).toHaveBeenCalledTimes(3);
  });
});
