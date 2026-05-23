const path = require("path");
const { defaultTargetRepo } = require("./config");
const { createPlanningWorktree, getRepoStatus, resetWorktreeChanges } = require("./git");
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

const STAGE_ORDER = [
  "requirement_clarification",
  "solution_planning",
  "requirement_confirmation",
  "worktree_runtime_bootstrap",
  "module_location",
  "code_generation",
  "code_review",
  "test_planning",
  "verification",
  "delivery_packaging",
  "knowledge_writing",
];

const activeRepairRuns = new Set();

function calculateProgress(stageName) {
  const index = STAGE_ORDER.indexOf(stageName);
  if (index === -1) return 0;
  return Math.round(((index + 1) / STAGE_ORDER.length) * 100);
}

function completeStage(runDir, stage) {
  const progress = calculateProgress(stage.name);
  writeEvent(runDir, {
    type: "stage_completed",
    stage: stage.name,
    status: stage.status,
    summary: stage.summary,
    progress,
    completedAt: new Date().toISOString(),
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

function buildRepairRunningResult({ existing, runId, target, repoStatus, gitWorktree, stages, artifacts, feedback }) {
  return {
    ...existing,
    runId,
    status: "repair_running",
    repairStartedAt: new Date().toISOString(),
    targetRepo: target,
    repoStatus,
    gitWorktree,
    stages,
    artifacts,
    currentRepair: {
      feedback,
    },
  };
}

function reviewFailureFingerprint(reviewStage) {
  if (!reviewStage || reviewStage.name !== "code_review" || reviewStage.data?.verdict === "pass") {
    return null;
  }
  const requiredChanges = Array.isArray(reviewStage.data?.requiredChanges)
    ? reviewStage.data.requiredChanges
    : [];
  const risks = Array.isArray(reviewStage.data?.risks) ? reviewStage.data.risks : [];
  return JSON.stringify({
    summary: reviewStage.summary || "",
    requiredChanges,
    risks,
  });
}

function shouldFuseRepeatedReviewFailure(stages, currentReviewStage) {
  const currentFingerprint = reviewFailureFingerprint(currentReviewStage);
  if (!currentFingerprint) return false;
  const previousReviewStage = [...stages]
    .reverse()
    .find((stage) => stage.name === "code_review" && stage !== currentReviewStage);
  return reviewFailureFingerprint(previousReviewStage) === currentFingerprint;
}

function resetDirtyRepairWorktree({ runDir, gitRootPath, targetRelativePath, reason }) {
  const pathspec = targetRelativePath || ".";
  const status = resetWorktreeChanges(gitRootPath, pathspec);
  writeEvent(runDir, {
    type: "repair_worktree_reset",
    reason,
    pathspec,
    status,
  });
  return status;
}

function shouldResetBeforeRetry(feedback) {
  return feedback?.reason === "code_generation_failed";
}

function writeRetryStartedEvent({ runDir, type, attempt, feedback, resetStatus }) {
  writeEvent(runDir, {
    type,
    attempt,
    feedback,
    worktreeMode: resetStatus ? "reset_before_retry" : "incremental_retry",
    ...(resetStatus ? { resetStatus } : {}),
  });
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

function cloneStage(stage) {
  return JSON.parse(JSON.stringify(stage));
}

function stabilizeModuleStage(moduleStage, boundaryState) {
  if (!boundaryState) return moduleStage;

  const stableStage = cloneStage(moduleStage);
  const data = stableStage.data || {};
  const currentEditBoundary = data.editBoundary || [];
  const currentReadOnlyFiles = data.readOnlyFiles || [];
  const currentRelatedTests = data.relatedTests || [];

  boundaryState.editBoundary = [
    ...new Set([...(boundaryState.editBoundary || []), ...currentEditBoundary]),
  ];
  boundaryState.readOnlyFiles = [
    ...new Set([...(boundaryState.readOnlyFiles || []), ...currentReadOnlyFiles]),
  ];
  boundaryState.relatedTests = [
    ...new Set([...(boundaryState.relatedTests || []), ...currentRelatedTests]),
  ];

  data.editBoundary = boundaryState.editBoundary;
  data.primaryEditBoundary = boundaryState.editBoundary;
  data.readOnlyFiles = boundaryState.readOnlyFiles.filter((file) => !data.editBoundary.includes(file));
  data.relatedTests = boundaryState.relatedTests;
  data.boundaryStability = {
    mode: "retry_union",
    stableEditBoundaryCount: data.editBoundary.length,
    stableReadOnlyCount: data.readOnlyFiles.length,
  };
  data.files = [
    ...new Map([
      ...((data.files || []).map((file) => [file.path, file])),
      ...data.editBoundary.map((file) => [file, { exists: true, path: file, role: "editable" }]),
      ...data.readOnlyFiles.map((file) => [file, { exists: true, path: file, role: "context" }]),
    ]).values(),
  ];
  stableStage.data = data;
  stableStage.summary = `${moduleStage.summary} 边界稳定后可编辑文件 ${data.editBoundary.length} 个。`;
  return stableStage;
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
    const boundaryState = { editBoundary: [], readOnlyFiles: [], relatedTests: [] };
    stages.push(runtimeBootstrapStage);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (feedback) {
        const resetStatus = shouldResetBeforeRetry(feedback)
          ? resetDirtyRepairWorktree({
              runDir,
              gitRootPath: gitWorktree.path,
              targetRelativePath: targetRelativePath || ".",
              reason: feedback.reason || "retry",
            })
          : null;
        writeRetryStartedEvent({
          runDir,
          type: "boundary_retry_started",
          attempt,
          feedback,
          resetStatus,
        });
      }

      const moduleStage = completeStage(
        runDir,
        stabilizeModuleStage(
          await locateModules(worktreeTargetPath, { requirementStage, runDir, feedback }),
          boundaryState,
        ),
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
  if (activeRepairRuns.has(runId)) {
    const error = new Error(`Workflow ${runId} repair continuation is already running`);
    error.status = 409;
    throw error;
  }
  const existing = readWorkflow(runId);
  const allowedStatuses = new Set([
    "repair_running",
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
  const previousModuleStages = stages.filter((stage) => stage.name === "module_location");
  const boundaryState = {
    editBoundary: [...new Set(previousModuleStages.flatMap((stage) => stage.data?.editBoundary || []))],
    readOnlyFiles: [...new Set(previousModuleStages.flatMap((stage) => stage.data?.readOnlyFiles || []))],
    relatedTests: [...new Set(previousModuleStages.flatMap((stage) => stage.data?.relatedTests || []))],
  };
  activeRepairRuns.add(runId);

  try {
    writeEvent(runDir, { type: "repair_continuation_started", runId, feedback });
    writeJson(
      runDir,
      "result.json",
      buildRepairRunningResult({ existing, runId, target, repoStatus, gitWorktree, stages, artifacts, feedback }),
    );

    for (let attempt = 0; attempt < Number(maxAttempts || 3); attempt += 1) {
      const resetStatus = shouldResetBeforeRetry(feedback)
        ? resetDirtyRepairWorktree({
            runDir,
            gitRootPath: gitWorktree.path,
            targetRelativePath: gitWorktree.targetRelativePath === "." ? "." : gitWorktree.targetRelativePath,
            reason: feedback.reason || "repair_continuation",
          })
        : null;
      writeRetryStartedEvent({
        runDir,
        type: "repair_retry_started",
        attempt,
        feedback,
        resetStatus,
      });

      const moduleStage = completeStage(
        runDir,
        stabilizeModuleStage(
          await locateModules(gitWorktree.targetPath, { requirementStage, runDir, feedback }),
          boundaryState,
        ),
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
        if (shouldFuseRepeatedReviewFailure(stages, reviewStage)) {
          feedback = {
            ...feedback,
            reason: "repeated_review_failure",
            summary: `${feedback.summary || "修复失败"} 同类 code review 失败连续出现，已停止自动 rerun。`,
          };
          writeEvent(runDir, {
            type: "repair_fuse_tripped",
            runId,
            reason: feedback.reason,
            feedback,
          });
          break;
        }
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
  } finally {
    activeRepairRuns.delete(runId);
  }
}

module.exports = {
  confirmWorkflow,
  continueWorkflow,
  runWorkflow,
  readWorkflow,
};
