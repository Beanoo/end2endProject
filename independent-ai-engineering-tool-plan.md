# Independent AI Engineering Tool Plan

## Correction

The AI engineering tool must be an independent project. It must not be implemented inside the Conduit application.

Correct boundary:

```text
end2endProject/
├── ai-engineering-tool/                  # independent AI engineering platform
└── conduit-realworld-example-app-filtered/ # target sandbox Conduit repo
```

The tool operates on Conduit through controlled filesystem, git, test, and patch operations. Conduit remains the experimental target repository.

## Hard Constraints

- All generated product requirements must be implemented incrementally on Conduit.
- The tool itself must live outside the Conduit repo.
- Conduit changes must be managed with git:
  - inspect status before changing files
  - create a run branch or worktree
  - write patch files
  - run tests/build
  - produce PR-ready output
- The tool must include three real layers:
  - frontend conversation page
  - Node backend API
  - orchestrator / skill layer

## Minimal Runnable P0

P0 should prove that an independent tool can operate on Conduit without embedding itself into Conduit.

Flow:

```text
PM input in AI tool frontend
  -> AI tool backend API
  -> Orchestrator
  -> Skill registry
  -> Inspect target Conduit repo
  -> Create run branch in Conduit
  -> Locate modules
  -> Produce plan / test / delivery draft
  -> Persist run events in AI tool workspace
```

P0 intentionally does not auto-edit Conduit yet. It creates a git-managed run context and returns a gated delivery plan.

## P1

Use the first L1 requirement:

```text
文章详情页新增字数统计：在文章正文下方显示“本文共 XXX 字，预计阅读 X 分钟”，前端基于 Article.body 计算。
```

P1 should:

1. Create git branch or worktree.
2. Apply a small frontend patch to Conduit.
3. Add/adjust tests.
4. Run `npm run test`.
5. Run `npm run build -w frontend`.
6. Save diff and verification report.
7. Produce PR-ready summary.

## Project Structure

```text
ai-engineering-tool/
├── package.json
├── server.js
├── public/
│   └── index.html
├── src/
│   ├── config.js
│   ├── orchestrator.js
│   ├── workspace.js
│   ├── git.js
│   └── skills/
│       ├── requirementClarifier.js
│       ├── solutionPlanner.js
│       ├── moduleLocator.js
│       ├── testPlanner.js
│       ├── deliveryPackager.js
│       └── knowledgeWriter.js
└── workspace/
    └── runs/
```

## API

```text
POST /api/workflows
GET  /api/workflows/:runId
GET  /api/target/status
```

`POST /api/workflows` input:

```json
{
  "requirement": "string",
  "targetRepo": "/absolute/path/to/conduit"
}
```

## Git Strategy

For P0:

- Validate target repo is a git repo.
- Read current branch and status.
- Refuse to overwrite dirty user changes.
- Create or reuse a branch:

```text
ai/<runId>-planning
```

For P1:

- Prefer git worktree per run:

```text
ai-engineering-tool/workspace/worktrees/<runId>
```

- Apply patches in worktree.
- Save diff to:

```text
ai-engineering-tool/workspace/runs/<runId>/changes.patch
```

## P0 Acceptance Criteria

- AI tool starts on its own port, independent from Conduit.
- Frontend page can submit PM requirement.
- Backend creates a workflow run.
- Orchestrator runs all deterministic skills.
- Tool reads real Conduit git status.
- Tool creates a git-managed run branch or reports why it cannot.
- Module locator returns real Conduit paths.
- Run artifacts are persisted under `ai-engineering-tool/workspace/runs/<runId>`.
- No AI platform code is added to Conduit.

## Immediate Execution Steps

1. Remove the mistakenly embedded AI workflow files from Conduit.
2. Keep baseline Conduit fixes that are required for tests/dev environment unless explicitly reverted later.
3. Create `ai-engineering-tool`.
4. Implement P0 independent Node backend + static frontend.
5. Verify with the L1 word-count requirement.
6. Record result in `ai-engineering-tool/docs/p0-result.md`.

