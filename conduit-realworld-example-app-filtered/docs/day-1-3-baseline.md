# Day 1-3 Conduit Baseline

## 固定实验仓库

本项目固定使用当前仓库作为 Conduit 前后端单仓 monorepo 实验田。

- 仓库来源：`https://github.com/TonyMckes/conduit-realworld-example-app.git`
- 本地路径：`/Users/doumengyao/work/end2endProject/conduit-realworld-example-app-filtered`
- 当前 commit：`d9500b503cfdf17394cb1091d33684b22d44c5d7`
- 克隆方式：`git -c http.version=HTTP/1.1 clone --depth 1 --filter=blob:none ...`

该仓库符合硬约束：

- RealWorld/Conduit 全栈博客业务域。
- 前端和后端位于同一个 monorepo。
- 根目录使用 npm workspaces 管理 `frontend` 和 `backend`。
- README 声明技术栈为 React/Vite、Express.js、Sequelize、PostgreSQL。

## 技术栈识别

### 根目录

- 包管理：npm workspaces
- 工作区：`backend`、`frontend`
- 并发启动：`concurrently`
- 测试框架：Vitest

关键命令：

```bash
npm install
npm run dev
npm run test
npm run start
npm run sqlz -- db:create
npm run sqlz -- db:seed:all
```

### Frontend

- React
- Vite
- React Router
- Axios
- markdown-to-jsx
- Testing Library

关键命令：

```bash
npm run dev -w frontend
npm run build -w frontend
```

默认端口：

- `http://localhost:3000`

### Backend

- Express
- Sequelize
- PostgreSQL driver: `pg`, `pg-hstore`
- JWT authentication
- bcrypt
- dotenv

关键命令：

```bash
npm run dev -w backend
npm run start -w backend
npm run sqlz -- db:create
npm run sqlz -- db:seed:all
```

默认端口：

- `http://localhost:3001/api`

## 本地环境

实际检测结果：

```text
node: v23.11.0
npm: 11.5.2
docker: 29.4.3
docker compose: v5.1.3
psql: PostgreSQL 16.9
mysql: MySQL 9.3.0
```

注意：

- README 要求 Node.js `v18.11.0+`。
- 当前安装的 Vitest `4.0.18` 声明支持 `^20.0.0 || ^22.0.0 || >=24.0.0`，因此在 Node `v23.11.0` 下会出现 engine warning。
- Docker Desktop 已安装并可运行容器。
- PostgreSQL 和 MySQL 已通过 Homebrew 安装并启动。
- Conduit 后端当前使用本机 PostgreSQL 作为 development 数据库。

服务状态：

```text
mysql         started
postgresql@16 started
```

Docker 验证：

```bash
docker run --rm hello-world
```

结果：

```text
Hello from Docker!
```

## 已完成基线

### 依赖安装

命令：

```bash
npm install
```

结果：

- 安装成功。
- npm audit 报告 `8 vulnerabilities`，其中 `3 moderate`、`5 high`。
- 出现 Vitest engine warning。

### 测试环境修复

首次执行：

```bash
npm run test
```

失败原因：

```text
MISSING DEPENDENCY Cannot find dependency 'jsdom'
```

原因分析：

- 根目录 `vitest.config.js` 配置了 `environment: "jsdom"`。
- 原始 `package.json` 未声明 `jsdom`。

已执行修复：

```bash
npm install -D jsdom
```

影响文件：

- `package.json`
- `package-lock.json`

该修复属于测试环境依赖补齐，不改变业务逻辑。

### 单元测试基线

命令：

```bash
npm run test
```

结果：

```text
Test Files  3 passed (3)
Tests       12 passed (12)
Duration    918ms
```

通过的测试文件：

- `backend/helper/helpers.test.js`
- `frontend/src/helpers/errorHandler.test.js`
- `frontend/src/helpers/dateFormatter.test.js`

### 前端构建基线

命令：

```bash
npm run build -w frontend
```

结果：

```text
191 modules transformed
dist/index.html
dist/assets/index-*.css
dist/assets/index-*.js
build completed in 1.33s
```

结论：

- 前端生产构建可用。

### 数据库基线

本地 PostgreSQL 数据库：

```text
database_development
database_testing
```

本地 `.env` 使用 PostgreSQL：

```text
DEV_DB_USERNAME=doumengyao
DEV_DB_NAME=database_development
DEV_DB_HOSTNAME=127.0.0.1
DEV_DB_DIALECT=postgres
DEV_DB_LOGGING=false
```

已执行迁移：

```bash
npm run sqlz -- db:migrate
```

结果：

```text
20220129140530-create-tag migrated
20220129140808-create-article migrated
20220129140956-create-user migrated
20220129141319-create-comment migrated
```

已执行 seed：

```bash
npm run sqlz -- db:seed:all
```

结果：

```text
20220427123216-create-users migrated
20220427123222-create-articles migrated
```

### 后端 API 基线

命令：

```bash
npm run dev -w backend
```

结果：

```text
Server running on http://localhost:3001
Connection with development database has been established.
```

浏览器或 curl 验证：

```bash
curl -s http://localhost:3001/
```

结果：

```json
{"status":"API is running on /api"}
```

### 后端配置修复

首次连接 PostgreSQL 时发现：

```text
TypeError: options.logging is not a function
```

原因：

- `backend/config/config.js` 直接将 `DEV_DB_LOGGING=false` 作为字符串传给 Sequelize。
- Sequelize 的 `logging` 选项需要 `false` 或函数，而不是字符串 `"false"`。

已修复：

- 增加 `parseLogging`，将 `"false"` 转为 `false`，将 `"true"` 转为 `console.log`。

影响文件：

- `backend/config/config.js`

### Seed 前置问题

首次执行 seed 时发现：

```text
ERROR: column "userId" of relation "Articles" does not exist
```

原因：

- migration 文件没有创建部分关联字段。
- 后端启动时 `sequelize.sync({ alter: true })` 会根据 model 补齐 schema。

处理：

1. 启动后端，让 Sequelize sync 补齐表结构。
2. 重新执行 `npm run sqlz -- db:seed:all`。
3. seed 成功。

## 仍需处理项

README 描述项目使用 PostgreSQL，`backend/package.json` 也已安装 `pg` 和 `pg-hstore`。

但 `backend/.env.example` 默认写的是：

```text
DEV_DB_DIALECT=mysql
TEST_DB_DIALECT=mysql
PROD_DB_DIALECT=mysql
```

建议下一步修正为 PostgreSQL 示例配置：

```text
DEV_DB_DIALECT=postgres
TEST_DB_DIALECT=postgres
PROD_DB_DIALECT=postgres
```

还需要补充：

- Docker Compose PostgreSQL 服务定义。
- 前后端一键启动脚本。
- API smoke test 脚本。
- E2E 测试基线。

## 第 1-3 天结论

已完成：

- 固定 Conduit 前后端单仓 monorepo。
- 识别技术栈和启动命令。
- 安装依赖。
- 补齐缺失的 `jsdom` 测试依赖。
- 跑通自带 Vitest 基线测试。
- 跑通前端生产构建。
- 安装并验证 Docker Desktop。
- 安装并启动 PostgreSQL client/server。
- 安装并启动 MySQL client/server。
- 创建 Conduit development/testing 数据库。
- 跑通 Sequelize migration。
- 跑通 Sequelize seed。
- 跑通后端 API 服务。

下一步必须补齐：

- `.env` 示例与 README 技术栈一致性。
- Docker Compose PostgreSQL 配置。
- 前后端联调验证。
- API smoke test 和 E2E 测试。
