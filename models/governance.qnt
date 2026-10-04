module governance {
  // Public LegionEngine operation model, replayed one action per public call by
  // scripts/replay-governance-itf.mjs in an adopted (adapter-default) three-task project.
  // Setup adopts assurance with approvePlan, so traces start at approval epoch 1 (0 means none and
  // is never reached by a replayed trace). approvePlan alternates the epoch between 1 and 2.
  //
  // Engine-derived rules (packages/core/src/engine.ts and docs/design/workflow-focus.md):
  // - Workflow integration runs the approval's workflow-level verification commands, not task
  //   commands. The replay approves one fixed command that checks every task output; done tasks
  //   always wrote the approved output, so integration passes and never blocks a task. A task's
  //   outcome (its contract verification command) acts only when that task runs.
  // - amendTask promotes every todo task to ready (promoteReadyTasks), not only the amended one,
  //   and changes the plan fingerprint, so the approval and all evidence become stale.
  // - A failed review leaves the workflow blocked at review; only `execute --retry` reruns it.
  // - interruptTask: SIGKILL while the provider holds task 0's request leaves its HTTP checkpoint
  //   dispatching; crash recovery classifies that as manual and blocks the task.
  // - Ship evidence: confirming a preview whose staged product changed is refused and the extra
  //   product file invalidates execution and acceptance evidence; a failed PR rolls the shipment back.
  // - Calibration: in an adopted project every governed mutation (amend, unblock, undo, abandon,
  //   acceptance, execute, ship) opens a governance boundary bound to the current approval epoch,
  //   so a stale approval refuses them until reapproval (docs/design/assurance-integration.md:
  //   "A missing or mismatched sidecar blocks until reapproval"). Only control-mode changes,
  //   status reads and approvePlan itself remain available while the approval is stale.
  var phase: str
  var advisory: bool
  var approvalId: int
  var approvalFresh: bool
  var taskStatus: int -> str
  var taskOutcome: int -> str
  var amendmentCount: int
  var executionFresh: bool
  var reviewVerdict: str
  var blockedAtReview: bool
  var acceptance: str
  var acceptanceFresh: bool
  var productEdits: int
  var shipped: bool
  var shippedApprovalId: int

  pure val Tasks = Set(0, 1, 2)
  pure val TaskOrder = List(0, 1, 2)
  pure val Phases = Set("plan_ready", "executing", "shipped", "abandoned")
  pure val TaskStatuses = Set("todo", "ready", "in_progress", "done", "blocked")
  pure val Outcomes = Set("pass", "fail")
  pure val Verdicts = Set("pass", "fail")
  pure val AcceptanceValues = Set("none", "passed", "failed")
  pure val MaxAmendments = 6
  pure val MaxProductEdits = 2

  pure def runnable(status: str): bool = status == "ready" or status == "todo"
  pure def nextApproval(id: int): int = if (id == 1) 2 else 1

  // H1 task processing: runnable tasks in id order, `jobs` per batch. A failing task blocks and
  // the run stops after the batch that contained a failure.
  pure def runTasks(status: int -> str, outcome: int -> str, jobs: int): { status: int -> str, failed: bool, stopped: bool, ran: int } =
    TaskOrder.foldl({ status: status, failed: false, stopped: false, ran: 0 }, (acc, t) =>
      if (acc.stopped or not(runnable(acc.status.get(t)))) acc
      else {
        status: acc.status.set(t, if (outcome.get(t) == "pass") "done" else "blocked"),
        failed: acc.failed or outcome.get(t) == "fail",
        stopped: (acc.failed or outcome.get(t) == "fail") and ((acc.ran + 1) % jobs == 0),
        ran: acc.ran + 1,
      })

  def anyTask(status: str): bool = Tasks.exists(t => taskStatus.get(t) == status)
  def executeGuard: bool = and {
    phase == "plan_ready" or phase == "executing",
    not(advisory), approvalFresh,
    not(anyTask("blocked")), not(anyTask("in_progress")),
    not(executionFresh), not(blockedAtReview),
  }
  def shipReady: bool = and {
    phase == "executing", not(advisory), approvalFresh, executionFresh, acceptance == "passed", acceptanceFresh,
  }

  action keepEvidence: bool = all {
    executionFresh' = executionFresh, blockedAtReview' = blockedAtReview,
    acceptance' = acceptance, acceptanceFresh' = acceptanceFresh,
  }
  action keepShip: bool = all {
    productEdits' = productEdits, shipped' = shipped, shippedApprovalId' = shippedApprovalId,
  }
  action keepPlan: bool = all {
    taskOutcome' = taskOutcome, amendmentCount' = amendmentCount, reviewVerdict' = reviewVerdict,
  }
  action unchanged: bool = all {
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, keepPlan, keepEvidence, keepShip,
  }

  action init: bool = all {
    phase' = "plan_ready",
    advisory' = false,
    approvalId' = 1,
    approvalFresh' = true,
    taskStatus' = Tasks.mapBy(_ => "ready"),
    taskOutcome' = Tasks.mapBy(_ => "pass"),
    amendmentCount' = 0,
    executionFresh' = false,
    reviewVerdict' = "pass",
    blockedAtReview' = false,
    acceptance' = "none",
    acceptanceFresh' = false,
    productEdits' = 0,
    shipped' = false,
    shippedApprovalId' = 0,
  }

  action approvePlan: bool = all {
    phase == "plan_ready" or phase == "executing",
    not(advisory), not(approvalFresh),
    approvalId' = nextApproval(approvalId), approvalFresh' = true,
    executionFresh' = false, blockedAtReview' = false,
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = phase, advisory' = advisory, taskStatus' = taskStatus,
    keepPlan, keepShip,
  }

  action setAdvisory: bool = all {
    phase == "plan_ready", not(advisory), approvalFresh,
    advisory' = true, approvalFresh' = false,
    taskStatus' = Tasks.mapBy(_ => "todo"),
    phase' = phase, approvalId' = approvalId,
    keepPlan, keepEvidence, keepShip,
  }

  action setGuarded: bool = all {
    phase == "plan_ready", advisory,
    advisory' = false, approvalFresh' = true,
    taskStatus' = Tasks.mapBy(_ => "ready"),
    phase' = phase, approvalId' = approvalId,
    keepPlan, keepEvidence, keepShip,
  }

  action amendTask(t: int, outcome: str): bool = all {
    phase == "plan_ready" or phase == "executing",
    not(advisory), approvalFresh, taskStatus.get(t) != "in_progress", amendmentCount < MaxAmendments,
    taskOutcome' = taskOutcome.set(t, outcome),
    amendmentCount' = amendmentCount + 1,
    taskStatus' = Tasks.mapBy(u => if (taskStatus.get(u) == "todo") "ready" else taskStatus.get(u)),
    approvalFresh' = false, executionFresh' = false, blockedAtReview' = false,
    acceptance' = acceptance, acceptanceFresh' = false,
    reviewVerdict' = reviewVerdict,
    phase' = phase, advisory' = advisory, approvalId' = approvalId,
    keepShip,
  }

  // Refusal: task 2 claiming task 0's still-open path overlaps it.
  action amendTaskOverlapDenied: bool = all {
    phase == "plan_ready" or phase == "executing",
    not(advisory), approvalFresh, taskStatus.get(0) != "done", taskStatus.get(2) != "in_progress",
    unchanged,
  }

  action executeWorkflow(jobs: int): bool = {
    val processed = runTasks(taskStatus, taskOutcome, jobs)
    val allDone = Tasks.forall(t => processed.status.get(t) == "done")
    all {
      executeGuard,
      taskStatus' = processed.status,
      phase' = "executing",
      executionFresh' = (allDone and reviewVerdict == "pass"),
      blockedAtReview' = (allDone and reviewVerdict == "fail"),
      acceptance' = acceptance, acceptanceFresh' = false,
      advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
      keepPlan, keepShip,
    }
  }

  action executeRetry: bool = all {
    phase == "executing", blockedAtReview, approvalFresh, not(advisory),
    executionFresh' = (reviewVerdict == "pass"),
    blockedAtReview' = (reviewVerdict == "fail"),
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, keepPlan, keepShip,
  }

  // A failed stage stays blocked: execute without --retry starts no task or review request.
  action executeFailureUnchanged: bool = all {
    phase == "executing", not(advisory), approvalFresh, not(executionFresh),
    blockedAtReview or anyTask("blocked"),
    unchanged,
  }

  // Loopback provider stimulus for the next review; no engine call.
  action setReviewVerdict(verdict: str): bool = all {
    verdict != reviewVerdict,
    reviewVerdict' = verdict,
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, taskOutcome' = taskOutcome, amendmentCount' = amendmentCount,
    keepEvidence, keepShip,
  }

  action unblockTask(t: int): bool = all {
    phase == "executing", approvalFresh, taskStatus.get(t) == "blocked",
    taskStatus' = taskStatus.set(t, "ready"),
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    keepPlan, keepEvidence, keepShip,
  }

  action undoTask(t: int): bool = all {
    phase == "executing", approvalFresh, taskStatus.get(t) == "done", not(anyTask("in_progress")),
    taskStatus' = taskStatus.set(t, "todo"),
    approvalFresh' = false, executionFresh' = false, blockedAtReview' = false,
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = phase, advisory' = advisory, approvalId' = approvalId,
    keepPlan, keepShip,
  }

  action executeWithoutApproval: bool = all {
    phase == "plan_ready" or phase == "executing", not(advisory), not(approvalFresh),
    unchanged,
  }

  action executeAdvisoryDenied: bool = all {
    phase == "plan_ready", advisory,
    unchanged,
  }

  action recordAcceptance(status: str): bool = all {
    phase == "executing", not(advisory), executionFresh, approvalFresh,
    acceptance' = status, acceptanceFresh' = true,
    executionFresh' = executionFresh, blockedAtReview' = blockedAtReview,
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, keepPlan, keepShip,
  }

  action acceptanceDenied: bool = all {
    phase == "plan_ready" or phase == "executing", not(advisory), approvalFresh, not(executionFresh),
    unchanged,
  }

  action shipStaleApprovalDenied: bool = all {
    phase == "executing", not(advisory), not(approvalFresh),
    unchanged,
  }

  action shipDeniedNotReady: bool = all {
    phase == "plan_ready" or phase == "executing", not(advisory), approvalFresh, not(shipReady),
    unchanged,
  }

  action shipPreviewChangedDenied: bool = all {
    shipReady, productEdits < MaxProductEdits,
    productEdits' = productEdits + 1,
    executionFresh' = false, acceptanceFresh' = false,
    blockedAtReview' = blockedAtReview, acceptance' = acceptance,
    shipped' = shipped, shippedApprovalId' = shippedApprovalId,
    phase' = phase, advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, keepPlan,
  }

  // A failed pull request rolls the shipment back; product and evidence are unchanged.
  action shipPrFailureRollback: bool = all {
    shipReady,
    unchanged,
  }

  action shipConfirmed: bool = all {
    shipReady,
    phase' = "shipped", shipped' = true, shippedApprovalId' = approvalId,
    productEdits' = productEdits,
    advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    taskStatus' = taskStatus, keepPlan, keepEvidence,
  }

  action interruptTask: bool = all {
    executeGuard, runnable(taskStatus.get(0)),
    taskStatus' = taskStatus.set(0, "blocked"),
    phase' = "executing",
    advisory' = advisory, approvalId' = approvalId, approvalFresh' = approvalFresh,
    keepPlan, keepEvidence, keepShip,
  }

  // abandon: modelled for a stuck executing plan (a blocked task) under the current approval.
  action abandon: bool = all {
    phase == "executing", not(advisory), approvalFresh, anyTask("blocked"),
    phase' = "abandoned",
    approvalFresh' = false, executionFresh' = false, blockedAtReview' = false,
    acceptance' = acceptance, acceptanceFresh' = false,
    advisory' = advisory, approvalId' = approvalId, taskStatus' = taskStatus,
    keepPlan, keepShip,
  }

  action readStatus: bool = unchanged

  action step: bool = {
    nondet t = oneOf(Tasks)
    nondet outcome = oneOf(Outcomes)
    nondet jobs = oneOf(Set(1, 2))
    nondet verdict = oneOf(Verdicts)
    nondet acceptanceStatus = oneOf(Set("passed", "failed"))
    any {
      approvePlan,
      setAdvisory,
      setGuarded,
      amendTask(t, outcome),
      amendTaskOverlapDenied,
      executeWorkflow(jobs),
      executeRetry,
      executeFailureUnchanged,
      setReviewVerdict(verdict),
      unblockTask(t),
      undoTask(t),
      executeWithoutApproval,
      executeAdvisoryDenied,
      recordAcceptance(acceptanceStatus),
      acceptanceDenied,
      shipStaleApprovalDenied,
      shipDeniedNotReady,
      shipPreviewChangedDenied,
      shipPrFailureRollback,
      shipConfirmed,
      interruptTask,
      abandon,
      readStatus,
    }
  }

  val Safety = and {
    Phases.contains(phase),
    Set(0, 1, 2).contains(approvalId),
    Tasks.forall(t => TaskStatuses.contains(taskStatus.get(t))),
    Tasks.forall(t => Outcomes.contains(taskOutcome.get(t))),
    0 <= amendmentCount and amendmentCount <= MaxAmendments,
    Verdicts.contains(reviewVerdict),
    AcceptanceValues.contains(acceptance),
    0 <= productEdits and productEdits <= MaxProductEdits,
    Set(0, 1, 2).contains(shippedApprovalId),
    advisory implies phase != "executing",
    executionFresh implies (approvalFresh and not(advisory) and (phase == "executing" or phase == "shipped")),
    acceptanceFresh implies (executionFresh or shipped),
    shipped iff phase == "shipped",
    shipped implies (shippedApprovalId == approvalId and acceptance == "passed"),
    not(blockedAtReview and executionFresh),
  }
}
