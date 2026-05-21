function clarifyRequirement(requirement) {
  const text = requirement.trim();
  const wordCount = /字数|阅读|word|read/i.test(text);

  return {
    name: "requirement_clarification",
    status: "completed",
    summary: wordCount
      ? "识别为 Conduit L1 文章详情页字数统计需求。"
      : "已将 PM 输入转成待确认的 Conduit 增量需求草案。",
    data: {
      originalRequirement: text,
      normalizedTitle: wordCount ? "文章详情页新增字数统计" : "Conduit 增量需求",
      userStory: wordCount
        ? "作为读者，我希望在文章详情页看到字数和预计阅读时间，以便判断阅读成本。"
        : "作为 Conduit 用户，我希望该需求被拆解为可实现、可测试的工程任务。",
      acceptanceCriteria: wordCount
        ? [
            "在文章详情页正文下方展示总字数。",
            "在文章详情页正文下方展示预计阅读分钟数。",
            "P1 优先基于 Article.body 在前端计算，不改数据库 schema。",
          ]
        : ["必须定位真实 Conduit 模块。", "实现前必须确认改动边界。"],
      openQuestions: ["字数统计是否需要排除 Markdown 标记？"],
    },
  };
}

module.exports = clarifyRequirement;

