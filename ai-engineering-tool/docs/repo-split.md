# 仓库拆分说明

## 当前结构

AI 工程工具和 Conduit 目标项目已经拆成两个独立 Git 仓库。

AI 工程工具仓库：

```text
/Users/doumengyao/work/end2endProject
git@github.com:Beanoo/end2endProject.git
```

Conduit 目标仓库：

```text
/Users/doumengyao/work/Conduiteg
git@github.com:Beanoo/Conduiteg.git
```

## 为什么拆分

拆分后职责更清楚：

```text
end2endProject:
  AI 工程工具代码、workflow、skills、运行报告。

Conduiteg:
  被 AI 工程工具操作的 Conduit 全栈业务代码。
```

这样后续 AI 生成的业务代码改动会落在 Conduit 仓库的独立分支和 PR 中；AI 工具自身的迭代会落在 `end2endProject` 仓库中。

## 工具配置

AI 工程工具默认目标仓库：

```text
/Users/doumengyao/work/Conduiteg
```

也可以通过环境变量覆盖：

```bash
TARGET_REPO=/path/to/conduit npm start
```

## Git 管理方式

后续建议：

```text
1. AI 工程工具能力改动提交到 end2endProject。
2. PM 需求导致的 Conduit 代码改动提交到 Conduiteg。
3. 每次 workflow 创建 Conduiteg 的 ai/run_xxx 分支。
4. PR 创建能力优先对接 Conduiteg 仓库。
```

## 迁移记录

已完成：

```text
1. 从原内嵌目录复制 Conduit 源码。
2. 排除 .env、node_modules、dist/build。
3. 初始化 /Users/doumengyao/work/Conduiteg。
4. 推送到 git@github.com:Beanoo/Conduiteg.git。
5. 从 end2endProject 移除旧的 conduit-realworld-example-app-filtered 目录。
6. 更新 AI 工具默认 target repo。
```

## 迁移后验证

独立 Conduit 仓库验证：

```text
npm run test: passed
npm run build -w frontend: passed
```

AI 工程工具指向独立 Conduit 仓库后的端到端验证：

```text
runId: run_20260521142246741_97ix7p
targetRepo: /Users/doumengyao/work/Conduiteg
status: completed_with_gates
branch: ai/run_20260521142246741_97ix7p-planning
targetRelativePath: .
```

验证需求：

```text
热门标签区域为空时显示占位文案：当接口返回空标签列表时，在首页右侧热门标签模块显示 暂无标签，而不是空白。
```

结果：

```text
module_location: model_with_index
editBoundary: frontend/src/components/PopularTags/PopularTags.jsx
code_generation: model_patch
test: passed
build: passed
```
