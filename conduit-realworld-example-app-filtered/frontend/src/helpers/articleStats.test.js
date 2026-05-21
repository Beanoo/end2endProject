import { getArticleStats } from "./articleStats";

describe("getArticleStats", () => {
  it("returns zero stats for empty input", () => {
    expect(getArticleStats("")).toEqual({ wordCount: 0, readingMinutes: 0 });
    expect(getArticleStats(null)).toEqual({ wordCount: 0, readingMinutes: 0 });
  });

  it("counts non-whitespace content", () => {
    expect(getArticleStats("Hello world 中文测试").wordCount).toBe(14);
  });

  it("estimates reading minutes with a minimum of one minute", () => {
    expect(getArticleStats("a".repeat(100)).readingMinutes).toBe(1);
    expect(getArticleStats("a".repeat(250)).readingMinutes).toBe(2);
  });
});
