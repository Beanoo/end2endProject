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
const {
  buildConfirmationStage,
  completeConfirmationStage,
  requiresConfirmation,
} = require("./skills/requirementConfirmation");
const { generateAndApplyPatch } = require("./skills/patchGenerator");
const { reviewGeneratedCode } = require("./skills/codeReviewer");
const { bootstrapWorktreeRuntime, runVerification } = require("./verification");
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

function buildNeedsRepairResult({
  runId,
  requirement,
  startedAt,
  target,
  repoStatus,
  gitWorktree,
  stages,
  artifacts,
  reason,
}) {
  return {
    runId,
    status: "needs_repair_continuation",
    requirement,
    startedAt,
    completedAt: new Date().toISOString(),
    targetRepo: target,
    repoStatus,
    gitWorktree,
    stages,
    artifacts,
    nextAction: {
      type: "continue_repair",
      endpoint: `POST /api/workflows/${runId}/continue`,
      reason,
    },
  };
}

function findLastStage(stages, name) {
  return [...(stages || [])].reverse().find((stage) => stage.name === name);
}

function buildContinuationFeedback(stages) {
  const reviewStage = findLastStage(stages, "code_review");
  if (reviewStage?.data?.verdict && reviewStage.data.verdict !== "pass") {
    return buildReviewFeedback(reviewStage);
  }
  const verificationStage = findLastStage(stages, "verification");
  if (verificationStage?.status && verificationStage.status !== "completed") {
    return buildVerificationFeedback(verificationStage);
  }
  return null;
}

async function runWorkflow({
  requirement,
  targetRepo = defaultTargetRepo,
  confirmed = false,
  confirmationOverrides = null,
} = {}) {
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
      await clarifyRequirement({ requirement, runDir, confirmationOverrides }),
    );
    const planStage = completeStage(runDir, planSolution({ requirement: requirementStage }));
    const stages = [requirementStage, planStage];

    if (requiresConfirmation(requirementStage) && !confirmed) {
      const confirmationStage = completeStage(
        runDir,
        buildConfirmationStage({ requirementStage, planStage, confirmationOverrides }),
      );
      stages.push(confirmationStage);
      const result = {
        runId,
        status: "needs_confirmation",
        requirement,
        startedAt,
        completedAt: new Date().toISOString(),
        targetRepo: target,
        repoStatus,
        stages,
        artifacts,
        nextAction: {
          type: "confirm_requirement",
          endpoint: "POST /api/workflows",
          body: { requirement, targetRepo: target, confirmed: true, confirmationOverrides: {} },
        },
      };
      writeJson(runDir, "result.json", result);
      writeEvent(runDir, { type: "run_completed", runId, status: result.status });
      return result;
    }

    if (requiresConfirmation(requirementStage) && confirmed) {
      stages.push(
        completeStage(
          runDir,
          completeConfirmationStage({ requirementStage, planStage, confirmationOverrides }),
        ),
      );
    }

    const gitWorktree = createPlanningWorktree(target, runId);
    const targetRelativePath = path.relative(repoStatus.root, target);
    const worktreeTargetPath = targetRelativePath
      ? path.join(gitWorktree.path, targetRelativePath)
      : gitWorktree.path;
    gitWorktree.targetPath = worktreeTargetPath;
    gitWorktree.targetRelativePath = targetRelativePath || ".";
    writeEvent(runDir, { type: "worktree_created", gitWorktree });
    const runtimeBootstrapStage = completeStage(runDir, {
      name: "worktree_runtime_bootstrap",
      status: "completed",
      summary: "已为 Conduit worktree 链接依赖和本地运行配置。",
      data: bootstrapWorktreeRuntime({
        worktreePath: worktreeTargetPath,
        targetRepo: target,
        runDir,
      }),
    });

    let feedback = null;
    let finalAttempt = null;
    const maxAttempts = Number(process.env.WORKFLOW_MAX_ATTEMPTS || 5);
    stages.push(runtimeBootstrapStage);

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
        const result = buildNeedsRepairResult({
          runId,
          requirement,
          startedAt,
          target,
          repoStatus,
          gitWorktree,
          stages,
          artifacts,
          reason: "code_review_reject",
        });
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
          requirementStage,
        }),
      );
      stages.push(verificationStage);

      if (verificationStage.status !== "completed") {
        if (attempt + 1 < maxAttempts) {
          feedback = buildVerificationFeedback(verificationStage);
          continue;
        }
        const result = buildNeedsRepairResult({
          runId,
          requirement,
          startedAt,
          target,
          repoStatus,
          gitWorktree,
          stages,
          artifacts,
          reason: "verification_blocked",
        });
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

async function confirmWorkflow(runId, { confirmationOverrides = null, targetRepo } = {}) {
  const existing = readWorkflow(runId);
  if (existing.status !== "needs_confirmation") {
    const error = new Error(`Workflow ${runId} is not waiting for confirmation`);
    error.status = 409;
    throw error;
  }

  return runWorkflow({
    requirement: existing.requirement,
    targetRepo: targetRepo || existing.targetRepo || defaultTargetRepo,
    confirmed: true,
    confirmationOverrides,
  });
}

async function continueWorkflow(runId, { maxAttempts = 3 } = {}) {
  const existing = readWorkflow(runId);
  const allowedStatuses = new Set([
    "needs_repair_continuation",
    "rejected_by_code_review",
    "blocked_by_verification",
  ]);
  if (!allowedStatuses.has(existing.status)) {
    const error = new Error(`Workflow ${runId} is not waiting for repair continuation`);
    error.status = 409;
    throw error;
  }

  const runDir = path.join(__dirname, "..", "workspace", "runs", runId);
  const target = path.resolve(existing.targetRepo || defaultTargetRepo);
  const repoStatus = existing.repoStatus || getRepoStatus(target);
  const gitWorktree = existing.gitWorktree;
  if (!gitWorktree?.targetPath) {
    const error = new Error(`Workflow ${runId} has no repairable worktree`);
    error.status = 409;
    throw error;
  }

  const stages = existing.stages || [];
  const requirementStage = stages.find((stage) => stage.name === "requirement_clarification");
  const planStage = stages.find((stage) => stage.name === "solution_planning");
  if (!requirementStage || !planStage) {
    const error = new Error(`Workflow ${runId} is missing requirement or plan stage`);
    error.status = 409;
    throw error;
  }

  const artifacts = existing.artifacts || {
    events: `workspace/runs/${runId}/events.jsonl`,
    result: `workspace/runs/${runId}/result.json`,
    knowledge: `workspace/runs/${runId}/knowledge-draft.json`,
  };
  let feedback = buildContinuationFeedback(stages) || {
    reason: "manual_repair_continuation",
    summary: "用户要求继续修复当前 worktree。",
  };
  writeEvent(runDir, { type: "repair_continuation_started", runId, feedback });

  for (let attempt = 0; attempt < Number(maxAttempts || 3); attempt += 1) {
    writeEvent(runDir, {
      type: "repair_retry_started",
      attempt,
      feedback,
    });

    const moduleStage = completeStage(
      runDir,
      await locateModules(gitWorktree.targetPath, { requirementStage, runDir, feedback }),
    );
    stages.push(moduleStage);

    let codeStage;
    try {
      codeStage = completeStage(
        runDir,
        await generateAndApplyPatch({
          runDir,
          worktreePath: gitWorktree.targetPath,
          gitRootPath: gitWorktree.path,
          targetRelativePath: gitWorktree.targetRelativePath === "." ? "" : gitWorktree.targetRelativePath,
          requirementStage,
          planStage,
          moduleStage,
          feedback,
        }),
      );
    } catch (error) {
      feedback = buildCodeGenerationFeedback(error);
      continue;
    }
    stages.push(codeStage);

    const reviewStage = completeStage(
      runDir,
      await reviewGeneratedCode({
        runDir,
        worktreePath: gitWorktree.targetPath,
        gitRootPath: gitWorktree.path,
        targetRelativePath: gitWorktree.targetRelativePath === "." ? "" : gitWorktree.targetRelativePath,
        requirementStage,
        planStage,
        moduleStage,
        codeStage,
      }),
    );
    stages.push(reviewStage);

    if (reviewStage.data.verdict !== "pass") {
      feedback = buildReviewFeedback(reviewStage);
      continue;
    }

    const testStage = completeStage(runDir, planTests({ moduleStage, codeStage }));
    stages.push(testStage);
    const verificationStage = completeStage(
      runDir,
      await runVerification({
        worktreePath: gitWorktree.targetPath,
        gitRootPath: gitWorktree.path,
        targetRelativePath: gitWorktree.targetRelativePath === "." ? "" : gitWorktree.targetRelativePath,
        targetRepo: target,
        runDir,
        moduleStage,
        requirementStage,
      }),
    );
    stages.push(verificationStage);

    if (verificationStage.status !== "completed") {
      feedback = buildVerificationFeedback(verificationStage);
      continue;
    }

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
      ...existing,
      status: "completed_with_gates",
      completedAt: new Date().toISOString(),
      stages,
      artifacts,
    };
    writeJson(runDir, "result.json", result);
    writeJson(runDir, "knowledge-draft.json", knowledgeStage.data);
    writeDeliveryReport({ runDir, result });
    writeEvent(runDir, { type: "run_completed", runId, status: result.status });
    return result;
  }

  const result = buildNeedsRepairResult({
    runId,
    requirement: existing.requirement,
    startedAt: existing.startedAt,
    target,
    repoStatus,
    gitWorktree,
    stages,
    artifacts,
    reason: feedback.reason || "repair_budget_exhausted",
  });
  writeJson(runDir, "result.json", result);
  writeDeliveryReport({ runDir, result });
  writeEvent(runDir, { type: "run_completed", runId, status: result.status });
  return result;
}

module.exports = {
  confirmWorkflow,
  continueWorkflow,
  runWorkflow,
  readWorkflow,
};
