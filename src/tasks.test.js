import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  countTestResults,
  rateLimiterSolution,
  rateLimiterTests,
  seedTask,
  TaskStore,
} from "./tasks.js";

test("seed task includes five real acceptance tests and a submission contract", () => {
  assert.equal(seedTask.testsCount, 5);
  assert.match(seedTask.criteria, /submission\.mjs/);
  assert.match(rateLimiterTests, /test\("refills tokens based on elapsed time"/);
});

test("the five acceptance tests pass for the solution and reject the broken starter", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-acceptance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const submissionPath = path.join(directory, "submission.mjs");
  const testPath = path.join(directory, "acceptance.test.mjs");
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  fs.writeFileSync(testPath, rateLimiterTests);

  fs.writeFileSync(submissionPath, rateLimiterSolution);
  const passingOutput = execFileSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    testPath,
  ], { cwd: directory, encoding: "utf8", env: childEnv });
  assert.match(passingOutput, /# pass 5/);
  assert.match(passingOutput, /# fail 0/);

  fs.writeFileSync(submissionPath, `export class TokenBucketRateLimiter {
  constructor(capacity, refillRate) { this.capacity = capacity; this.refillRate = refillRate; }
  tryAcquire() { return true; }
}`);
  assert.throws(() => execFileSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    testPath,
  ], { cwd: directory, encoding: "utf8", env: childEnv }), (error) => {
    assert.match(error.stdout, /# fail [1-9]/);
    return true;
  });
});

test("created tasks are validated and persist across store instances", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-tasks-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "tasks.json");
  const store = new TaskStore(filePath);
  const task = store.create({
    title: "Add a greeting function",
    description: "Write a small function that returns a greeting.",
    criteria: 'Export greet(name) from submission.mjs and return "Hello, <name>!".',
    amount: "15",
    testCode: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./submission.mjs";\ntest("greets by name", () => assert.equal(greet("Ada"), "Hello, Ada!"));`,
  });

  assert.equal(task.amountCents, 1500);
  assert.equal(task.testsCount, 1);
  assert.equal(new TaskStore(filePath).get(task.id).testCode, task.testCode);
  assert.equal("testCode" in store.list().find((item) => item.id === task.id), false);
});

test("problem activity persists and derives current workflow progress", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-activity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "tasks.json");
  const store = new TaskStore(filePath);
  const task = store.create({
    title: "Add a greeting function",
    description: "Return a friendly greeting for a name.",
    criteria: "Export greet(name) from submission.mjs.",
    amount: 0,
    testCode: `import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "./submission.mjs";
test("greets Ada", () => assert.equal(greet("Ada"), "Hello"));`,
  });

  assert.equal(store.progress(task.id).status, "open");
  store.recordActivity(task.id, "submission_received", {
    developerId: "test-agent",
    summary: "Implemented the greeting behavior.",
    assumptions: "The greeting uses English.",
  });
  assert.equal(store.progress(task.id).status, "in_progress");
  store.recordActivity(task.id, "tests_completed", {
    decision: "REJECTED",
    passed: 1,
    failed: 1,
    tests: [{ name: "greets Ada", passed: true }, { name: "handles empty name", passed: false }],
  });

  const reloaded = new TaskStore(filePath);
  const events = reloaded.getActivity(task.id);
  assert.equal(reloaded.progress(task.id).status, "needs_changes");
  assert.equal(events.length, 3);
  assert.equal(events[1].summary, "Implemented the greeting behavior.");
  assert.equal(events[1].assumptions, "The greeting uses English.");
  assert.equal(events[2].tests[1].passed, false);
  assert.equal(reloaded.list().find((item) => item.id === task.id).progress.status, "needs_changes");
});

test("rejects tasks without executable tests importing the submission", () => {
  const store = new TaskStore(path.join(os.tmpdir(), "arbiter-invalid-tasks.json"));
  assert.throws(() => store.create({
    title: "Missing tests",
    description: "A task without an acceptance suite.",
    criteria: "Export the required behavior from submission.mjs.",
    amount: 0,
    testCode: "No tests here, just words and submission.mjs.",
  }), /Node\.js test/);
});

test("parses named TAP results from the actual test runner", () => {
  const result = countTestResults([
    "TAP version 13",
    "ok 1 - handles a valid request",
    "not ok 2 - rejects an invalid request",
    "  ---",
    "  error: expected false",
    "  ...",
    "1..2",
  ].join("\n"));

  assert.deepEqual(result, {
    tests: [
      { name: "handles a valid request", passed: true },
      { name: "rejects an invalid request", passed: false },
    ],
    passed: 1,
    failed: 1,
  });
});
