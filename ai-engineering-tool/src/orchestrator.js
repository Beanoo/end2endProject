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
const { reviewGeneratedCode } = require("./skills/codeReviewer");
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

function buildReviewFeedback(reviewStage) {
  const data = reviewStage?.data || {};
  return {
    reason: "code_review_reject",
    summary: data.summary,
    risks: data.risks || [],
    requiredChanges: data.requiredChanges || [],
    suggestions: data.suggestions || [],
  };
}

function buildVerificationFeedback(verificationStage) {
  const data = verificationStage?.data || {};
  return {
    reason: "verification_blocked",
    summary: verificationStage?.summary,
    test: data.test,
    build: data.build,
    backendSmoke: data.backendSmoke,
  };
}

function buildCodeGenerationFeedback(error) {
  return {
    reason: "code_generation_failed",
    error: error.message,
    status: error.status || 500,
  };
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

    const stages = [requirementStage, planStage];
    let feedback = null;
    let finalAttempt = null;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (feedback) {
        writeEvent(runDir, {
          type: "boundary_retry_started",
          attempt,
          feedback,
        });
      }

      const moduleStage = completeStage(
        runDir,
        await locateModules(worktreeTargetPath, { requirementStage, runDir, feedback }),
      );
      stages.push(moduleStage);

      let codeStage;
      try {
        codeStage = completeStage(
          runDir,
          await generateAndApplyPatch({
            runDir,
            worktreePath: worktreeTargetPath,
            gitRootPath: gitWorktree.path,
            targetRelativePath,
            requirementStage,
            planStage,
            moduleStage,
            feedback,
          }),
        );
      } catch (error) {
        if (attempt + 1 < maxAttempts) {
          feedback = buildCodeGenerationFeedback(error);
          continue;
        }
        throw error;
      }
      stages.push(codeStage);

      const reviewStage = completeStage(
        runDir,
        await reviewGeneratedCode({
          runDir,
          worktreePath: worktreeTargetPath,
          gitRootPath: gitWorktree.path,
          targetRelativePath,
          requirementStage,
          planStage,
          moduleStage,
          codeStage,
        }),
      );
      stages.push(reviewStage);

      if (reviewStage.data.verdict !== "pass") {
        if (attempt + 1 < maxAttempts) {
          feedback = buildReviewFeedback(reviewStage);
          continue;
        }
        const result = {
          runId,
          status: "rejected_by_code_review",
          requirement,
          startedAt,
          completedAt: new Date().toISOString(),
          targetRepo: target,
          repoStatus,
          gitWorktree,
          stages,
          artifacts,
        };
        writeJson(runDir, "result.json", result);
        writeDeliveryReport({ runDir, result });
        writeEvent(runDir, { type: "run_completed", runId, status: result.status });
        return result;
      }

      const testStage = completeStage(runDir, planTests({ moduleStage, codeStage }));
      stages.push(testStage);
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
      stages.push(verificationStage);

      if (verificationStage.status !== "completed") {
        if (attempt + 1 < maxAttempts) {
          feedback = buildVerificationFeedback(verificationStage);
          continue;
        }
        const result = {
          runId,
          status: "blocked_by_verification",
          requirement,
          startedAt,
          completedAt: new Date().toISOString(),
          targetRepo: target,
          repoStatus,
          gitWorktree,
          stages,
          artifacts,
        };
        writeJson(runDir, "result.json", result);
        writeDeliveryReport({ runDir, result });
        writeEvent(runDir, { type: "run_completed", runId, status: result.status });
        return result;
      }

      finalAttempt = { moduleStage, codeStage, reviewStage };
      break;
    }

    const { moduleStage, codeStage, reviewStage } = finalAttempt;
    const deliveryStage = completeStage(
      runDir,
      packageDelivery({ gitWorktree, moduleStage, planStage, requirementStage, codeStage, reviewStage }),
    );
    stages.push(deliveryStage);
    const knowledgeStage = completeStage(
      runDir,
      writeKnowledge({ targetRepo: target, gitWorktree, moduleStage }),
    );
    stages.push(knowledgeStage);

    const result = {
      runId,
      status: "completed_with_gates",
      requirement,
      startedAt,
      completedAt: new Date().toISOString(),
      targetRepo: target,
      repoStatus,
      gitWorktree,
      stages,
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
