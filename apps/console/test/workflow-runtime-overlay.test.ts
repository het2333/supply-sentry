import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkflowRuntimeOverlay } from "../features/editor/workflow-runtime-overlay.js";

test("workflow runtime overlay chooses the latest durable attempt and preserves waiting/current state", () => {
  const overlay = buildWorkflowRuntimeOverlay({
    id: "run:1",
    workflowId: "workflow:po",
    status: "waiting_approval",
    temporalState: { currentNodeId: "approve", visitedNodeIds: ["start", "agent"], message: "等待采购经理" },
    nodeRuns: [
      { id: "nr:1", nodeId: "start", status: "completed", attempt: 1, sideEffectStatus: "none", startedAt: "2026-08-30T00:00:00.000Z", finishedAt: "2026-08-30T00:00:01.000Z" },
      { id: "nr:2", nodeId: "agent", status: "completed", attempt: 1, sideEffectStatus: "none", startedAt: "2026-08-30T00:00:01.000Z", finishedAt: "2026-08-30T00:00:02.000Z" },
      { id: "nr:3", nodeId: "agent", status: "failed", attempt: 2, sideEffectStatus: "none", error: "模型超时", startedAt: "2026-08-30T00:00:03.000Z", finishedAt: "2026-08-30T00:00:04.000Z" },
    ],
  });
  assert.ok(overlay);
  assert.equal(overlay.runId, "run:1");
  assert.equal(overlay.nodes.agent?.status, "failed");
  assert.equal(overlay.nodes.agent?.attempt, 2);
  assert.equal(overlay.nodes.agent?.message, "模型超时");
  assert.deepEqual(new Set(overlay.visitedNodeIds), new Set(["start", "agent", "approve"]));
  assert.deepEqual(overlay.nodes.approve, { status: "waiting", message: "等待采购经理" });
});

test("workflow runtime overlay derives the current running node when Worker has not written its NodeRun yet", () => {
  const overlay = buildWorkflowRuntimeOverlay({
    id: "run:2",
    workflowId: "workflow:rfq",
    status: "running",
    temporalState: { currentNodeId: "parse-quote", visitedNodeIds: [], message: "Worker 正在领取节点" },
    nodeRuns: [],
  });
  assert.equal(overlay?.nodes["parse-quote"]?.status, "running");
  assert.equal(overlay?.nodes["parse-quote"]?.message, "Worker 正在领取节点");
  assert.equal(buildWorkflowRuntimeOverlay(null), null);
});
