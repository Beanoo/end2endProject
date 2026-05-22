# 验证门禁说明

## 问题背景

P2 初版验证只包含：

```text
npm run test
npm run build -w frontend
```

这能证明单元测试和前端构建通过，但不能证明 `npm run dev` 的运行时链路正常。

实际暴露的问题是：

```text
后端 index.js 启动失败
Vite proxy 请求 /api/articles、/api/tags 时 ECONNREFUSED
```

这说明前端 dev server 能启动，但后端没有成功监听端口。旧验证门禁漏掉了这个问题。

## 当前验证流程

现在 verification 阶段包含三类门禁：

```text
1. 单元测试: ./node_modules/.bin/vitest --run
2. 前端构建: npm run build -w frontend
3. 后端 smoke: 临时启动 backend，先请求通用健康入口，再按模块边界请求安全 API
```

只有三项都通过，workflow 才会标记为：

```text
verification.status = completed
```

任意一项失败都会标记为：

```text
verification.status = blocked
```

## Runtime 引导

AI 生成代码发生在 Git worktree 中，而 `.env` 和 `node_modules` 不会提交到 Git。

因此 verification 会在 worktree 中自动引导本地运行时文件：

```text
node_modules -> 链接目标 Conduit 仓库 node_modules
.env -> 链接目标 Conduit 仓库 .env
backend/.env -> 链接目标 Conduit 仓库 backend/.env
```

引导结果写入：

```text
runtime-bootstrap.json
dependency-bootstrap.json
```

## 后端 Smoke Test

后端 smoke test 会使用随机本地端口启动后端，例如：

```text
PORT=3427 npm run dev -w backend
```

然后先请求通用健康入口：

```text
GET /
```

这一步只验证后端进程能启动、Express 能监听端口、数据库初始化没有直接导致进程退出。

随后根据本次模块定位结果动态追加安全 API smoke targets：

```text
tag 相关需求      -> GET /api/tags
article 相关需求  -> GET /api/articles?limit=1&offset=0
其他需求          -> 暂不强行猜测业务接口，只保留 GET /
```

这样不会把 `/api/tags` 硬编码成所有需求的唯一验证路径。

期望所有 smoke targets 返回 2xx/3xx。成功时产物类似：

```json
{
  "status": "passed",
  "health": {
    "statusCode": 200,
    "body": "{\"status\":\"API is running on /api\"}"
  },
  "targets": [
    { "name": "backend-root", "path": "/" },
    { "name": "tags-index", "path": "/api/tags" }
  ]
}
```

后端启动日志写入：

```text
backend-smoke-output.txt
```

## 已验证结果

在已有 AI worktree 上重跑新 verification：

```text
worktree: ai-engineering-tool/workspace/worktrees/run_20260521142246741_97ix7p
targetRepo: /Users/doumengyao/work/Conduiteg
```

结果：

```text
test: passed
build: passed
backendSmoke: passed
GET /: {"status":"API is running on /api"}
GET /api/tags: {"tags":[]}
```

## 仍未覆盖

当前门禁还不是完整 E2E。

仍需后续补齐：

```text
1. Playwright 打开真实页面并检查 UI 文案。
2. 前后端同时启动后的浏览器级验收。
3. 由模型根据需求生成更细粒度 API smoke plan。
4. 需要认证、slug、username 的接口参数准备。
5. 测试失败后的模型修复循环。
6. PR 前的人工确认节点。
```
