const path = require("path");
const { defaultTargetRepo } = require("./config");
const { createPlanningWorktree, getRepoStatus } = require("./git");
const { ensureRunWorkspace, readJson, writeEvent, writeJson } = require("./workspace");
const clarifyRequirement = require("./skills/llmRequirementClarifier");
const planSolution = require("./skills/solutionPlanner");
const locateModules = require("./skills/moduleLocator");
const planTests = require("./skills/testPlanner");
const packageDelivery = require("./skills/deliveryPackager");
const writeKnowledge = require("./skills/knowledgeWriter");
const { generateAndApplyPatch } = require("./skills/patchGenerator");
const { runVerification } = require("./verification");
const { writeDeliveryReport } = require("./report");

function createRunId() {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function completeStage(runDir, stage) {
  writeEvent(runDir, {
    type: "stage_completed",
    stage: stage.name,
    status: stage.status,
    summary: stage.summary,
  });
  return stage;
}

async function runWorkflow({ requirement, targetRepo = defaultTargetRepo }) {
  if (!requirement || !requirement.trim()) {
    const error = new Error("requirement is required");
    error.status = 400;
    throw error;
  }

  const runId = createRunId();
  const runDir = ensureRunWorkspace(runId);
  const startedAt = new Date().toISOString();
  const target = path.resolve(targetRepo);

  writeEvent(runDir, { type: "run_started", runId, requirement, targetRepo: target });

  const repoStatus = getRepoStatus(target);
  writeEvent(runDir, { type: "target_repo_inspected", repoStatus });

  const artifacts = {
    events: `workspace/runs/${runId}/events.jsonl`,
    result: `workspace/runs/${runId}/result.json`,
    knowledge: `workspace/runs/${runId}/knowledge-draft.json`,
  };

  try {
    const requirementStage = completeStage(
      runDir,
      await clarifyRequirement({ requirement, runDir }),
    );
    const planStage = completeStage(runDir, planSolution({ requirement: requirementStage }));

    const gitWorktree = createPlanningWorktree(target, runId);
    const targetRelativePath = path.relative(repoStatus.root, target);
    const worktreeTargetPath = targetRelativePath
      ? path.join(gitWorktree.path, targetRelativePath)
      : gitWorktree.path;
    gitWorktree.targetPath = worktreeTargetPath;
    gitWorktree.targetRelativePath = targetRelativePath || ".";
    writeEvent(runDir, { type: "worktree_created", gitWorktree });

    const moduleStage = completeStage(
      runDir,
      await locateModules(worktreeTargetPath, { requirementStage, runDir }),
    );
    const codeStage = completeStage(
      runDir,
      await generateAndApplyPatch({
        runDir,
        worktreePath: worktreeTargetPath,
        gitRootPath: gitWorktree.path,
        targetRelativePath,
        requirementStage,
        planStage,
        moduleStage,
      }),
    );
    const testStage = completeStage(runDir, planTests({ moduleStage }));
    const verificationStage = completeStage(
      runDir,
      await runVerification({
        worktreePath: worktreeTargetPath,
        gitRootPath: gitWorktree.path,
        targetRelativePath,
        targetRepo: target,
        runDir,
        moduleStage,
      }),
    );
    const deliveryStage = completeStage(
      runDir,
      packageDelivery({ gitWorktree, moduleStage, planStage, requirementStage, codeStage }),
    );
    const knowledgeStage = completeStage(
      runDir,
      writeKnowledge({ targetRepo: target, gitWorktree, moduleStage }),
    );

    const result = {
      runId,
      status: "completed_with_gates",
      requirement,
      startedAt,
      completedAt: new Date().toISOString(),
      targetRepo: target,
      repoStatus,
      gitWorktree,
      stages: [
        requirementStage,
        planStage,
        moduleStage,
        codeStage,
        testStage,
        verificationStage,
        deliveryStage,
        knowledgeStage,
      ],
      artifacts,
    };

    writeJson(runDir, "result.json", result);
    writeJson(runDir, "knowledge-draft.json", knowledgeStage.data);
    writeDeliveryReport({ runDir, result });
    writeEvent(runDir, { type: "run_completed", runId, status: result.status });

    return result;
  } catch (error) {
    const failedResult = {
      runId,
      status: "failed",
      requirement,
      startedAt,
      completedAt: new Date().toISOString(),
      targetRepo: target,
      repoStatus,
      error: {
        message: error.message,
        status: error.status || 500,
      },
      artifacts,
    };
    writeJson(runDir, "result.json", failedResult);
    writeEvent(runDir, {
      type: "run_failed",
      runId,
      status: failedResult.status,
      error: failedResult.error,
    });
    throw error;
  }
}

function readWorkflow(runId) {
  return readJson(path.join(__dirname, "..", "workspace", "runs", runId, "result.json"));
}

module.exports = {
  runWorkflow,
  readWorkflow,
};
