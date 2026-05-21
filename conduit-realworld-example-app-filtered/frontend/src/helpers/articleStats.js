export function getArticleStats(body) {
  if (!body || typeof body !== "string") {
    return { wordCount: 0, readingMinutes: 0 };
  }

  const text = body
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#>*_`~\-]/g, "")
    .replace(/\s+/g, "");
  const wordCount = text.length;
  const readingMinutes = wordCount > 0 ? Math.max(1, Math.ceil(wordCount / 200)) : 0;

  return { wordCount, readingMinutes };
}
