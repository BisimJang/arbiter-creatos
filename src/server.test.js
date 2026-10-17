import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHandler } from "./server.js";
import { TaskStore, seedTask } from "./tasks.js";

async function createTestApp(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-server-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let lastReview = null;
  let verificationInput = null;
  const agent = {
    sandboxId: options.sandboxId === undefined ? "test-sandbox" : options.sandboxId,
    verifyDeliverable: async (input) => {
      verificationInput = input;
      return {
        decision: "APPROVED",
        exitCode: 0,
        logs: "TAP version 13\nok 1 - accepts a request\n1..1",
        payout: null,
      };
    },
    generateDisputeSummary: () => "Test report",
  };
  const server = http.createServer(createHandler({
    agent,
    taskStore: new TaskStore(path.join(directory, "tasks.json")),
    getEscrowRecord: () => null,
    getLastReview: () => lastReview,
    setLastReview: (review) => { lastReview = review; },
    draftGenerator: options.draftGenerator,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, getVerificationInput: () => verificationInput };
}

test("task API hides acceptance test source and returns test-ready task details", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const response = await fetch(`${baseUrl}/api/tasks`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.tasks[0].id, seedTask.id);
  assert.equal(body.tasks[0].testsCount, 5);
  assert.equal("testCode" in body.tasks[0], false);
  assert.equal(body.tasks[0].progress.status, "open");
  assert.equal("events" in body.tasks[0], false);
});

test("problem pages deep-link and their API returns details without exposing test source", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const [pageResponse, problemResponse] = await Promise.all([
    fetch(`${baseUrl}/problems/${seedTask.id}`),
    fetch(`${baseUrl}/api/tasks/${seedTask.id}`),
  ]);
  const { task } = await problemResponse.json();

  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type"), /text\/html/);
  assert.equal(problemResponse.status, 200);
  assert.equal(task.id, seedTask.id);
  assert.equal("testCode" in task, false);
});

test("serves the restricted Markdown renderer as a browser module", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const response = await fetch(`${baseUrl}/markdown.js`);
  const script = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(script, /export function renderMarkdown/);
});

test("problem activity API returns only public work artifacts and test history", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const submissionResponse = await fetch(`${baseUrl}/api/tasks/${seedTask.id}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      developerId: "auditable-agent",
      code: "export default 1;",
      summary: "Implemented **capacity checks**.",
      assumptions: "Refill uses tokens per second.",
    }),
  });
  assert.equal(submissionResponse.status, 200);

  const response = await fetch(`${baseUrl}/api/tasks/${seedTask.id}/activity`);
  const activity = await response.json();
  assert.equal(response.status, 200);
  assert.equal(activity.progress.status, "approved");
  assert.deepEqual(activity.events.map((event) => event.type), [
    "problem_published",
    "submission_received",
    "tests_completed",
  ]);
  assert.equal(activity.events[1].summary, "Implemented **capacity checks**.");
  assert.equal(activity.events[1].assumptions, "Refill uses tokens per second.");
  assert.equal(activity.events[2].tests[0].passed, true);
  assert.equal(JSON.stringify(activity).includes("private chain-of-thought"), false);
  assert.match(activity.privacy, /Private model reasoning is not recorded/);
});

test("server entrypoint loads GEMINI_API_KEY from a local .env file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, ".env"), "GEMINI_API_KEY=unit-test-placeholder\n");

  const childEnv = { ...process.env };
  delete childEnv.GEMINI_API_KEY;
  const serverUrl = pathToFileURL(path.resolve("src/server.js")).href;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(serverUrl)}); process.stdout.write(process.env.GEMINI_API_KEY ? "loaded" : "missing");`,
  ], { cwd: directory, env: childEnv, encoding: "utf8" });

  assert.equal(output, "loaded");
});

test("draft API forwards the chat history to Arbiter", async (t) => {
  let received;
  const { baseUrl } = await createTestApp(t, {
    draftGenerator: async (description, conversation) => {
      received = { description, conversation };
      return { title: "A reviewed problem", criteria: "Clear requirements go here.", testCode: "tests" };
    },
  });
  const response = await fetch(`${baseUrl}/api/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Build a greeting function for a supplied name.",
      conversation: [{ role: "user", content: "Include punctuation." }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.description, "Build a greeting function for a supplied name.");
  assert.deepEqual(received.conversation, [{ role: "user", content: "Include punctuation." }]);
});

test("draft API reports missing Gemini setup visibly", async (t) => {
  const { baseUrl } = await createTestApp(t, {
    draftGenerator: async () => {
      const error = new Error("Copy .env.example to .env, set GEMINI_API_KEY to your newly rotated key, and restart Arbiter.");
      error.statusCode = 503;
      throw error;
    },
  });
  const response = await fetch(`${baseUrl}/api/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "Build a greeting function for a supplied name." }),
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Copy \.env\.example to \.env/);
});

test("task API will not publish a problem before explicit approval", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Add a greeting function",
      description: "Return a friendly greeting for a name.",
      criteria: "Export greet(name) from submission.mjs.",
      amount: 0,
      testCode: "test code is intentionally not validated before approval",
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /explicitly approve/);
});

test("stateless MCP endpoint initializes and runs problem tools", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const initializeResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const initialized = await initializeResponse.json();
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.deepEqual(initialized.result.capabilities, { tools: {} });

  const toolsResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const tools = await toolsResponse.json();
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    "list_problems",
    "get_problem",
    "submit_solution",
    "get_problem_activity",
  ]);

  const callResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_problem", arguments: { problemId: seedTask.id } },
    }),
  });
  const call = await callResponse.json();
  const problem = JSON.parse(call.result.content[0].text);
  assert.equal(problem.id, seedTask.id);
  assert.equal("testCode" in problem, false);

  const activityResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_problem_activity", arguments: { problemId: seedTask.id } },
    }),
  });
  const activityCall = await activityResponse.json();
  const activity = JSON.parse(activityCall.result.content[0].text);
  assert.equal(activity.progress.status, "open");
  assert.match(activity.privacy, /Private model reasoning is not recorded/);

  const submitResponse = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "submit_solution",
        arguments: { problemId: seedTask.id, code: "export default 1;" },
      },
    }),
  });
  const submission = await submitResponse.json();
  assert.equal(JSON.parse(submission.result.content[0].text).decision, "APPROVED");
});

test("MCP reports unavailable sandbox execution as a tool error", async (t) => {
  const { baseUrl } = await createTestApp(t, { sandboxId: null });
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "submit_solution",
        arguments: { problemId: seedTask.id, code: "export default 1;" },
      },
    }),
  });
  const { result } = await response.json();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /sandbox is not ready/i);
  const activityResponse = await fetch(`${baseUrl}/api/tasks/${seedTask.id}/activity`);
  const activity = await activityResponse.json();
  assert.equal(activity.progress.status, "blocked");
  assert.equal(activity.events.at(-1).type, "execution_failed");
});

test("task API creates a task and submissions return named test results without paying", async (t) => {
  const { baseUrl, getVerificationInput } = await createTestApp(t);
  const taskResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approved: true,
      title: "Add a greeting function",
      description: "Return a friendly greeting for a name.",
      criteria: "Export greet(name) from submission.mjs.",
      amount: 20,
      testCode: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./submission.mjs";\ntest("greets", () => assert.equal(greet("Ada"), "Hello"));`,
    }),
  });
  const { task } = await taskResponse.json();
  assert.equal(taskResponse.status, 201);

  const submissionResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      developerId: "test-agent",
      code: "export const greet = () => 'Hello';",
      summary: "Implemented greet.",
      assumptions: "English-only output.",
    }),
  });
  const result = await submissionResponse.json();

  assert.equal(submissionResponse.status, 200);
  assert.equal(result.decision, "APPROVED");
  assert.deepEqual(result.tests, [{ name: "accepts a request", passed: true }]);
  assert.equal(result.passed, 1);
  assert.equal(getVerificationInput().releasePayout, false);
  assert.match(getVerificationInput().testHarnessCode, /import \{ greet \}/);
});

test("submission API returns a clear error for unknown tasks", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const response = await fetch(`${baseUrl}/api/tasks/not-a-task/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "export default 1;" }),
  });
  const result = await response.json();
  assert.equal(response.status, 404);
  assert.deepEqual(result, { error: "Problem not found." });
});

test("invalid task forms return a validation error instead of a server error", async (t) => {
  const { baseUrl } = await createTestApp(t);
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approved: true,
      title: "Missing tests",
      description: "A task without valid tests.",
      criteria: "Export the required behavior from submission.mjs.",
      amount: 0,
      testCode: "Acceptance tests go here but are missing.",
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Write acceptance tests with Node.js test() from node:test.",
  });
});
