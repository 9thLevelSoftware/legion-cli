module governance_boundaries {
  // Abstract governance-boundary model. Each action except setAdvisory/setGuarded is one engine
  // governance boundary: scripts/check-governance-boundaries.mjs maps the pre-state to the begin
  // frame's `before` projection and the post-state to the end frame's `after` projection, then
  // requires validateGovernanceFrames (packages/schema/src/governance.ts) to accept every trace.
  // Guards encode the validator's rules; Safety conjoins the rules that are state invariants.
  // setAdvisory/setGuarded mirror setControlMode, which the engine performs outside a boundary.
  // `explicitRetry` is the per-step retry marker recorded on both frames of the boundary.
  // The abandoned phase and the compacted task status are included so abandon/compact have
  // a projection-level effect; claim liveness turns dead only through recover.
  var phase: str
  var controlMode: str
  var taskStatus: int -> str
  var taskOwner: int -> str
  var approvalId: int
  var approvalFresh: bool
  var claimOwner: str
  var claimLive: bool
  var integration: str
  var review: str
  var component: str
  var acceptance: str
  var acceptanceFresh: bool
  var shipStatus: str
  var preview: str
  var confirmed: bool
  var preparedPreview: str
  var explicitRetry: bool

  pure val Tasks = Set(0, 1, 2)
  pure val TaskOrder = List(0, 1, 2)
  // Fixed contract writes: T0 `src/model`, T1 `src/other.ts`, T2 `src/model/child.ts`.
  // T0 and T2 overlap because `src/model/child.ts` lies inside the `src/model` directory.
  pure def overlaps(a: int, b: int): bool = (a == 0 and b == 2) or (a == 2 and b == 0)
  pure val Phases = Set("plan_ready", "executing", "ready_to_ship", "shipped", "abandoned")
  pure val ControlModes = Set("guarded", "advisory")
  pure val TaskStatuses = Set("todo", "ready", "in_progress", "verifying", "done", "blocked", "compacted")
  pure val Workers = Set("w1", "w2")
  pure val ClaimOwners = Set("c1", "c2")
  pure val Stages = Set("not-run", "running", "passed", "failed", "stale")
  pure val Results = Set("passed", "failed")
  pure val AcceptanceStatuses = Set("not-recorded", "passed", "failed")
  pure val ShipStatuses = Set("none", "prepared", "complete", "aborted")
  pure val Previews = Set("none", "p1", "p2")

  pure def staleStage(stage: str): str = if (stage == "passed" or stage == "failed") "stale" else stage
  pure def nextPreview(current: str): str = if (current == "p1") "p2" else "p1"
  def isActive(t: int): bool = taskStatus.get(t) == "in_progress" or taskStatus.get(t) == "verifying"
  def noActiveTask: bool = Tasks.forall(t => not(isActive(t)))
  def startable(t: int): bool = taskStatus.get(t) == "ready" and Tasks.forall(u => not(isActive(u) and overlaps(u, t)))
  // Lowest task id satisfying the predicate, or 3 (outside Tasks) when none does.
  def lowestTask(pred: int => bool): int = if (pred(0)) 0 else if (pred(1)) 1 else if (pred(2)) 2 else 3
  def checksPassed: bool = integration == "passed" and component == "passed" and review == "passed"
  def acceptancePassed: bool = acceptance == "passed" and acceptanceFresh
  def stagesIdle: bool = integration != "running" and review != "running" and component != "running"
  def workAvailable: bool = and {
    controlMode == "guarded", approvalFresh, shipStatus != "prepared",
    Set("plan_ready", "executing", "ready_to_ship").contains(phase),
    Tasks.exists(t => startable(t)) or (Tasks.forall(t => taskStatus.get(t) == "done") and not(checksPassed)),
  }
  def shipReady: bool = and {
    phase == "ready_to_ship", controlMode == "guarded", approvalFresh, checksPassed, acceptancePassed, preview != "none"
  }

  action keepTasks: bool = all { taskStatus' = taskStatus, taskOwner' = taskOwner }
  action keepApproval: bool = all { approvalId' = approvalId, approvalFresh' = approvalFresh }
  action keepClaim: bool = all { claimOwner' = claimOwner, claimLive' = claimLive }
  action keepChecks: bool = all { integration' = integration, review' = review, component' = component }
  action keepAcceptance: bool = all { acceptance' = acceptance, acceptanceFresh' = acceptanceFresh }
  action keepShip: bool = all { shipStatus' = shipStatus, confirmed' = confirmed, preparedPreview' = preparedPreview }
  action staleChecks: bool = all {
    integration' = staleStage(integration), review' = staleStage(review), component' = staleStage(component)
  }

  action init: bool = all {
    phase' = "plan_ready",
    controlMode' = "guarded",
    taskStatus' = Tasks.mapBy(_ => "ready"),
    taskOwner' = Tasks.mapBy(_ => "none"),
    approvalId' = 1,
    approvalFresh' = true,
    claimOwner' = "none",
    claimLive' = false,
    integration' = "not-run",
    review' = "not-run",
    component' = "not-run",
    acceptance' = "not-recorded",
    acceptanceFresh' = false,
    shipStatus' = "none",
    preview' = "none",
    confirmed' = false,
    preparedPreview' = "none",
    explicitRetry' = false
  }

  // approval-adopt: a fresh approval epoch alternates 1 <-> 2 and stales prior evidence.
  // Reapproval is modelled only when the current approval is stale (amend/undo/advisory).
  action approvalAdopt: bool = all {
    Set("plan_ready", "executing", "ready_to_ship").contains(phase),
    not(approvalFresh), controlMode == "guarded", noActiveTask, stagesIdle, shipStatus != "prepared",
    approvalId' = 3 - approvalId, approvalFresh' = true,
    staleChecks,
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepClaim, keepShip
  }

  // claim-acquire: the workflow claim is taken only when work is available (or idly after
  // shipping/abandoning); a live claim is never taken over, a dead one may be.
  action claimAcquire(owner: str): bool = all {
    claimOwner == "none" or not(claimLive),
    workAvailable or phase == "shipped" or phase == "abandoned",
    claimOwner' = owner, claimLive' = true,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepChecks, keepAcceptance, keepShip
  }

  // claim-release: the workflow claim is released only once no stage is in flight and no work remains.
  action claimRelease: bool = all {
    claimOwner != "none", noActiveTask, stagesIdle, not(workAvailable),
    claimOwner' = "none", claimLive' = false,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepChecks, keepAcceptance, keepShip
  }

  // recover: the owning process died; active tasks block and the claim becomes dead.
  // Only claim owner c2 is modelled as a crashable process, so c1 runs complete without crashes.
  action recover: bool = all {
    Tasks.exists(t => isActive(t)), claimOwner == "c2", claimLive,
    taskStatus' = Tasks.mapBy(t => if (isActive(t)) "blocked" else taskStatus.get(t)),
    taskOwner' = Tasks.mapBy(_ => "none"),
    claimOwner' = claimOwner, claimLive' = false,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepChecks, keepAcceptance, keepShip
  }

  // task-start: guarded, current approval, ready task, live workflow claim, no overlapping active writes.
  // The claim owner's worker runs the task (c1 -> w1, c2 -> w2).
  action taskStart(t: int): bool = all {
    Set("plan_ready", "executing").contains(phase),
    controlMode == "guarded", approvalFresh, stagesIdle, shipStatus != "prepared",
    claimOwner != "none", claimLive,
    Tasks.contains(t), startable(t),
    taskStatus' = taskStatus.set(t, "in_progress"),
    taskOwner' = taskOwner.set(t, if (claimOwner == "c1") "w1" else "w2"),
    phase' = "executing",
    staleChecks,
    acceptance' = acceptance, acceptanceFresh' = false,
    controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepClaim, keepShip
  }

  action taskVerify(t: int): bool = all {
    Tasks.contains(t), taskStatus.get(t) == "in_progress",
    taskStatus' = taskStatus.set(t, "verifying"), taskOwner' = taskOwner,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // task-complete: only a verifying task becomes done; its output changes the product preview.
  action taskComplete(t: int): bool = all {
    Tasks.contains(t), taskStatus.get(t) == "verifying",
    taskStatus' = taskStatus.set(t, "done"), taskOwner' = taskOwner.set(t, "none"),
    preview' = nextPreview(preview),
    phase' = phase, controlMode' = controlMode, explicitRetry' = false,
    keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // task-block: a failed verification blocks the verifying task.
  action taskBlock(t: int): bool = all {
    Tasks.contains(t), taskStatus.get(t) == "verifying",
    taskStatus' = taskStatus.set(t, "blocked"), taskOwner' = taskOwner.set(t, "none"),
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // integration-start: rerunning failed integration/component evidence requires explicit retry.
  action integrationStart(retry: bool): bool = all {
    Set("executing", "ready_to_ship").contains(phase),
    controlMode == "guarded", approvalFresh, stagesIdle, shipStatus != "prepared",
    claimOwner != "none", claimLive,
    Tasks.forall(t => taskStatus.get(t) == "done"),
    not(integration == "passed" and component == "passed"),
    (integration == "failed" or component == "failed") implies retry,
    integration' = "running", component' = "running", review' = "not-run",
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = retry,
    keepTasks, keepApproval, keepClaim, keepShip
  }

  // integration-complete records integration and the component c0 stage it gates.
  action integrationComplete(result: str, componentResult: str): bool = all {
    integration == "running",
    integration' = result,
    component' = if (result == "passed") componentResult else "not-run",
    review' = review,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepAcceptance, keepShip
  }

  // review-start: rerunning a failed review requires explicit retry.
  action reviewStart(retry: bool): bool = all {
    Set("executing", "ready_to_ship").contains(phase),
    controlMode == "guarded", approvalFresh, shipStatus != "prepared",
    claimOwner != "none", claimLive, integration == "passed", component == "passed",
    review != "running", review != "passed",
    review == "failed" implies retry,
    review' = "running", integration' = integration, component' = component,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = retry,
    keepTasks, keepApproval, keepClaim, keepAcceptance, keepShip
  }

  action reviewComplete(verdict: str): bool = all {
    review == "running",
    review' = verdict, integration' = integration, component' = component,
    phase' = if (verdict == "passed") "ready_to_ship" else "executing",
    controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepAcceptance, keepShip
  }

  // acceptance-record: current approval and passed integration/component/review evidence.
  action acceptanceRecord(status: str): bool = all {
    phase == "ready_to_ship", approvalFresh, checksPassed, shipStatus != "prepared",
    acceptance' = status, acceptanceFresh' = true,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepShip
  }

  action shipPrepare: bool = all {
    shipReady, shipStatus == "none" or shipStatus == "aborted",
    shipStatus' = "prepared", confirmed' = false, preparedPreview' = preview,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance
  }

  // ship-confirm: binds the prepared preview and reaches shipped.
  action shipConfirm: bool = all {
    shipReady, shipStatus == "prepared", not(confirmed), preview == preparedPreview,
    confirmed' = true, shipStatus' = shipStatus, preparedPreview' = preparedPreview,
    phase' = "shipped",
    controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance
  }

  action shipComplete: bool = all {
    phase == "shipped", confirmed, shipStatus == "prepared", approvalFresh,
    shipStatus' = "complete", confirmed' = confirmed, preparedPreview' = preparedPreview,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance
  }

  // ship-rollback: aborts an unconfirmed preparation; it never claims delivery.
  action shipRollback: bool = all {
    shipStatus == "prepared", not(confirmed), phase != "shipped",
    shipStatus' = "aborted", confirmed' = false, preparedPreview' = preparedPreview,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance
  }

  // amend-inputs: amending a blocked or not-yet-runnable task's contract stales approval and evidence.
  action amendInputs(t: int): bool = all {
    Set("plan_ready", "executing", "ready_to_ship").contains(phase),
    stagesIdle, shipStatus != "prepared",
    taskStatus.get(t) == "blocked" or taskStatus.get(t) == "todo",
    taskStatus' = taskStatus.set(t, if (taskStatus.get(t) == "todo") "ready" else taskStatus.get(t)),
    taskOwner' = taskOwner,
    approvalId' = approvalId, approvalFresh' = false,
    staleChecks,
    acceptance' = acceptance, acceptanceFresh' = false,
    phase' = if (phase == "ready_to_ship") "executing" else phase,
    controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepClaim, keepShip
  }

  action unblock(t: int): bool = all {
    Set("plan_ready", "executing").contains(phase),
    taskStatus.get(t) == "blocked",
    taskStatus' = taskStatus.set(t, "ready"), taskOwner' = taskOwner,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // undo: after failed checks, a done task returns to todo and its reverted output changes the product.
  action undo(t: int): bool = all {
    Set("executing", "ready_to_ship").contains(phase),
    integration == "failed" or component == "failed" or review == "failed",
    taskStatus.get(t) == "done", noActiveTask, stagesIdle, shipStatus != "prepared",
    taskStatus' = taskStatus.set(t, "todo"), taskOwner' = taskOwner,
    approvalId' = approvalId, approvalFresh' = false,
    staleChecks,
    acceptance' = acceptance, acceptanceFresh' = false,
    preview' = nextPreview(preview),
    phase' = "executing",
    controlMode' = controlMode, explicitRetry' = false,
    keepClaim, keepShip
  }

  // abandon: a stuck plan (stale approval with a blocked task) may be abandoned.
  action abandon: bool = all {
    Set("plan_ready", "executing").contains(phase), controlMode == "guarded", not(approvalFresh),
    Tasks.exists(t => taskStatus.get(t) == "blocked"),
    noActiveTask, stagesIdle, shipStatus != "prepared",
    phase' = "abandoned",
    approvalId' = approvalId, approvalFresh' = false,
    acceptance' = acceptance, acceptanceFresh' = false,
    controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepClaim, keepChecks, keepShip
  }

  action compact(t: int): bool = all {
    phase == "shipped", shipStatus == "complete", Tasks.contains(t), taskStatus.get(t) == "done",
    taskStatus' = taskStatus.set(t, "compacted"), taskOwner' = taskOwner,
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // Refused boundaries: the engine records outcome `refused` and leaves the projection unchanged.
  action taskStartRefused: bool = all {
    Set("plan_ready", "executing").contains(phase),
    controlMode == "advisory", Tasks.exists(t => taskStatus.get(t) == "ready"),
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  action acceptanceRecordRefused: bool = all {
    Set("executing", "ready_to_ship").contains(phase),
    approvalFresh, review == "failed",
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  action shipPrepareRefused: bool = all {
    phase == "ready_to_ship", approvalFresh, checksPassed, not(acceptancePassed),
    shipStatus != "prepared",
    phase' = phase, controlMode' = controlMode, preview' = preview, explicitRetry' = false,
    keepTasks, keepApproval, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  // Control-mode changes happen outside governance boundaries (no frames).
  action setAdvisory: bool = all {
    phase == "plan_ready", controlMode == "guarded", noActiveTask, claimOwner == "none",
    controlMode' = "advisory", approvalFresh' = false, approvalId' = approvalId,
    phase' = phase, preview' = preview, explicitRetry' = false,
    keepTasks, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  action setGuarded: bool = all {
    phase == "plan_ready", controlMode == "advisory",
    controlMode' = "guarded", approvalFresh' = true, approvalId' = approvalId,
    phase' = phase, preview' = preview, explicitRetry' = false,
    keepTasks, keepClaim, keepChecks, keepAcceptance, keepShip
  }

  action step: bool = {
    nondet t = oneOf(Tasks)
    nondet owner = oneOf(ClaimOwners)
    nondet retry = oneOf(Set(false, true))
    nondet result = oneOf(Results)
    nondet componentResult = oneOf(Results)
    any {
      approvalAdopt,
      claimAcquire(owner),
      claimRelease,
      recover,
      taskStart(lowestTask(startable)),
      taskVerify(lowestTask(u => taskStatus.get(u) == "in_progress")),
      taskComplete(lowestTask(u => taskStatus.get(u) == "verifying")),
      taskBlock(t),
      integrationStart(retry),
      integrationComplete(result, componentResult),
      reviewStart(retry),
      reviewComplete(result),
      acceptanceRecord(result),
      shipPrepare,
      shipConfirm,
      shipComplete,
      shipRollback,
      amendInputs(t),
      unblock(t),
      undo(t),
      abandon,
      compact(lowestTask(u => taskStatus.get(u) == "done")),
      taskStartRefused,
      acceptanceRecordRefused,
      shipPrepareRefused,
      setAdvisory,
      setGuarded,
    }
  }

  val Safety = and {
    Phases.contains(phase),
    ControlModes.contains(controlMode),
    Tasks.forall(t => TaskStatuses.contains(taskStatus.get(t))),
    Tasks.forall(t => taskOwner.get(t) == "none" or Workers.contains(taskOwner.get(t))),
    Tasks.forall(t => isActive(t) iff taskOwner.get(t) != "none"),
    Set(1, 2).contains(approvalId),
    claimOwner == "none" or ClaimOwners.contains(claimOwner),
    claimOwner == "none" implies not(claimLive),
    Stages.contains(integration), Stages.contains(review), Stages.contains(component),
    AcceptanceStatuses.contains(acceptance),
    ShipStatuses.contains(shipStatus), Previews.contains(preview), Previews.contains(preparedPreview),
    // advisory-execution: no active task under advisory control.
    controlMode == "advisory" implies noActiveTask,
    // overlapping-active-writes: overlapping contracts are never active together.
    Tasks.forall(a => Tasks.forall(b => not(overlaps(a, b) and isActive(a) and isActive(b)))),
    // completion-without-checks / stale-authority-use: shipped implies passed checks and current passed acceptance.
    phase == "shipped" implies (checksPassed and acceptancePassed and approvalFresh and confirmed),
    // preview binding: a confirmation always names a prepared preview.
    confirmed implies (preparedPreview != "none" and shipStatus != "none" and shipStatus != "aborted"),
    // rollback-claims-delivery: an aborted shipment is never shipped; completion requires shipping.
    shipStatus == "aborted" implies phase != "shipped",
    shipStatus == "complete" implies (phase == "shipped" and confirmed),
  }
}
