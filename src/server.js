import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MilestoneEscrowAgent } from "./escrow-agent.js";
import { generateDraft } from "./arbiter.js";
import {
  countTestResults,
  rateLimiterSolution,
  rateLimiterStarter,
  rateLimiterTests,
  seedTask,
  TaskStore,
} from "./tasks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-03-26";

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

function publicTask(task) {
  if (!task) return null;
  const { testCode, ...result } = task;
  return result;
}

const mcpTools = [
  {
    name: "list_problems",
    description: "List published Arbiter problems and their submission contracts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_problem",
    description: "Read a published problem's requirements and submission format.",
    inputSchema: {
      type: "object",
      properties: { problemId: { type: "string", description: "The problem ID." } },
      required: ["problemId"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_solution",
    description: "Submit a complete JavaScript ES module and run the problem's acceptance tests.",
    inputSchema: {
      type: "object",
      properties: {
        problemId: { type: "string", description: "The problem ID." },
        code: { type: "string", description: "Complete submission.mjs source." },
        developerId: { type: "string", description: "Optional submitting agent name." },
        summary: { type: "string", description: "Optional concise, user-visible work summary; not private reasoning." },
        assumptions: { type: "string", description: "Optional implementation assumptions." },
      },
      required: ["problemId", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "get_problem_activity",
    description: "Retrieve the visible progress timeline, implementation summaries, assumptions, and test results for a problem. Does not include private model reasoning.",
    inputSchema: {
      type: "object",
      properties: { problemId: { type: "string", description: "The problem ID." } },
      required: ["problemId"],
      additionalProperties: false,
    },
  },
];

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function publicResult(review, durationMs, testResults) {
  return {
    ...review,
    durationMs,
    tests: testResults.tests,
    passed: testResults.passed,
    failed: testResults.failed,
  };
}

export function createHandler({
  agent,
  taskStore,
  getEscrowRecord,
  getLastReview,
  setLastReview,
  draftGenerator = generateDraft,
}) {
  async function runSubmission(task, code, developerId, details = {}) {
    if (!task) return { status: 404, error: "Problem not found." };
    if (typeof code !== "string" || code.trim().length === 0) {
      return { status: 400, error: "Provide the complete JavaScript module in the code field." };
    }
    if (Buffer.byteLength(code) > 256 * 1024) {
      return { status: 413, error: "Submission code must be 256 KB or smaller." };
    }
    const summary = typeof details.summary === "string" && details.summary.trim()
      ? details.summary.trim().slice(0, 2000)
      : "Submitted a solution for acceptance testing.";
    const assumptions = typeof details.assumptions === "string"
      ? details.assumptions.trim().slice(0, 2000)
      : "";
    taskStore.recordActivity(task.id, "submission_received", {
      developerId: developerId.slice(0, 100),
      summary,
      assumptions,
    });
    if (!agent.sandboxId) {
      taskStore.recordActivity(task.id, "execution_failed", {
        developerId: developerId.slice(0, 100),
        summary: "The solution could not be tested because the sandbox is unavailable.",
        feedback: "Check the sandbox connection and server configuration.",
      });
      return { status: 503, error: "The test sandbox is not ready. Check the server's CreateOS configuration." };
    }

    const start = Date.now();
    let review;
    try {
      review = await agent.verifyDeliverable({
        milestone: {
          ...task,
          milestoneId: task.id,
          developerAccount: developerId,
        },
        deliverableCode: code,
        testHarnessCode: task.testCode,
        codeFilename: task.submissionFilename,
        testFilename: task.testFilename,
        releasePayout: false,
      });
    } catch (error) {
      taskStore.recordActivity(task.id, "execution_failed", {
        developerId: developerId.slice(0, 100),
        summary: "Sandbox execution could not complete.",
        feedback: "Check the sandbox connection and server logs for details.",
      });
      throw error;
    }
    const testResults = countTestResults(review.logs || "");
    let finalReview = review;
    if (review.decision === "APPROVED" && (
      testResults.tests.length === 0 || testResults.failed > 0
    )) {
      finalReview = {
        ...review,
        decision: "REJECTED",
        exitCode: 1,
        payout: null,
        feedback: testResults.tests.length === 0
          ? "The test runner exited without reporting any named tests. Add valid node:test cases and resubmit."
          : "The test runner reported one or more failing tests. Review each failure and resubmit.",
      };
    }
    taskStore.recordActivity(task.id, "tests_completed", {
      developerId: developerId.slice(0, 100),
      summary: finalReview.decision === "APPROVED"
        ? "Acceptance tests passed; the submission was approved."
        : "Acceptance tests did not pass; revisions are needed.",
      decision: finalReview.decision,
      passed: testResults.passed,
      failed: testResults.failed,
      tests: testResults.tests,
      feedback: typeof finalReview.feedback === "string" ? finalReview.feedback.slice(0, 2000) : "",
      durationMs: Date.now() - start,
    });
    setLastReview({ task, code, review: finalReview });
    return { result: publicResult(finalReview, Date.now() - start, testResults) };
  }

  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(path.join(__dirname, "../public/index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (req.method === "GET" && url.pathname === "/illustration.png") {
        const image = fs.readFileSync(path.join(__dirname, "../public/illustration.png"));
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(image);
      }

      if (req.method === "GET" && url.pathname === "/markdown.js") {
        const script = fs.readFileSync(path.join(__dirname, "../public/markdown.js"));
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        return res.end(script);
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const { testCode, ...publicMilestone } = seedTask;
        return json(res, 200, {
          sandboxId: agent.sandboxId,
          escrow: getEscrowRecord(),
          milestone: publicMilestone,
          geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
          mcpEndpoint: "/mcp",
          storage: "local JSON file",
        });
      }

      if (req.method === "GET" && url.pathname === "/api/tasks") {
        return json(res, 200, { tasks: taskStore.list() });
      }

      const problemMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
      if (req.method === "GET" && problemMatch) {
        const task = taskStore.get(problemMatch[1]);
        return task
          ? json(res, 200, { task: { ...publicTask(task), progress: taskStore.progress(task.id) } })
          : json(res, 404, { error: "Problem not found." });
      }

      const activityMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/activity$/);
      if (req.method === "GET" && activityMatch) {
        const task = taskStore.get(activityMatch[1]);
        if (!task) return json(res, 404, { error: "Problem not found." });
        return json(res, 200, {
          progress: taskStore.progress(task.id),
          events: taskStore.getActivity(task.id),
          privacy: "Visible work summaries, assumptions, and test results only. Private model reasoning is not recorded.",
        });
      }

      if (req.method === "GET" && url.pathname === "/api/templates/rate-limiter") {
        return json(res, 200, {
          starter: rateLimiterStarter,
        });
      }

      // Draft endpoint: accept a freeform description and return a drafted task + tests for author review
      if (req.method === "POST" && url.pathname === "/api/draft") {
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.description !== "string") {
          return json(res, 400, { error: "Provide a short problem description in the 'description' field." });
        }
        try {
          const draft = await draftGenerator(body.description.trim(), body.conversation || []);
          return json(res, 200, { draft });
        } catch (error) {
          if (error.statusCode !== 400 && error.statusCode !== 503) {
            console.error("Draft generation failed:", error.message);
          }
          return json(res, error.statusCode || 502, { error: error.message });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJson(req);
        if (body?.approved !== true) {
          return json(res, 400, { error: "Review the requirements and tests, then explicitly approve before publishing." });
        }
        const { approved, ...taskInput } = body;
        const task = taskStore.create(taskInput);
        const { testCode, ...publicTask } = task;
        return json(res, 201, { task: publicTask });
      }

      const submissionMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/submissions$/);
      const isDemoSubmission = req.method === "POST" && url.pathname === "/api/evaluate";
      if (req.method === "POST" && (submissionMatch || isDemoSubmission)) {
        let task;
        let code;
        let developerId;
        let submissionDetails = {};

        if (isDemoSubmission) {
          const type = url.searchParams.get("type");
          task = taskStore.get(seedTask.id);
          code = type === "fixed" ? rateLimiterSolution : rateLimiterStarter;
          developerId = "demo-agent";
        } else {
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json(res, 400, { error: "Submission must be a JSON object." });
          }
          task = taskStore.get(submissionMatch[1]);
          code = body.code;
          developerId = typeof body.developerId === "string" ? body.developerId.slice(0, 100) : "agent";
          submissionDetails = { summary: body.summary, assumptions: body.assumptions };
        }

        const submission = await runSubmission(task, code, developerId, submissionDetails);
        if (submission.error) return json(res, submission.status, { error: submission.error });
        return json(res, 200, submission.result);
      }

      if (url.pathname === "/mcp" && req.method === "POST") {
        const request = await readJson(req);
        if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
          return json(res, 400, {
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32600, message: "Invalid JSON-RPC request." },
          });
        }
        if (request.method === "notifications/initialized") {
          res.writeHead(202);
          return res.end();
        }

        const rpcError = (code, message) => json(res, 200, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code, message },
        });
        if (!Object.hasOwn(request, "id")) {
          res.writeHead(202);
          return res.end();
        }

        let result;
        if (request.method === "initialize") {
          result = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "arbiter", version: "1.0.0" },
          };
        } else if (request.method === "ping") {
          result = {};
        } else if (request.method === "tools/list") {
          result = { tools: mcpTools };
        } else if (request.method === "tools/call") {
          const { name, arguments: args = {} } = request.params || {};
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            return rpcError(-32602, "Tool arguments must be an object.");
          }

          let toolData;
          if (name === "list_problems") {
            toolData = taskStore.list();
          } else if (name === "get_problem") {
            const task = taskStore.get(args.problemId);
            if (!task) {
              result = { isError: true, content: [{ type: "text", text: "Problem not found." }] };
            } else {
              toolData = { ...publicTask(task), progress: taskStore.progress(task.id) };
            }
          } else if (name === "get_problem_activity") {
            const task = taskStore.get(args.problemId);
            if (!task) {
              result = { isError: true, content: [{ type: "text", text: "Problem not found." }] };
            } else {
              toolData = {
                progress: taskStore.progress(task.id),
                events: taskStore.getActivity(task.id),
                privacy: "Visible work summaries, assumptions, and test results only. Private model reasoning is not recorded.",
              };
            }
          } else if (name === "submit_solution") {
            const task = taskStore.get(args.problemId);
            const developerId = typeof args.developerId === "string"
              ? args.developerId.slice(0, 100)
              : "mcp-agent";
            try {
              const submission = await runSubmission(task, args.code, developerId, {
                summary: args.summary,
                assumptions: args.assumptions,
              });
              if (submission.error) {
                result = { isError: true, content: [{ type: "text", text: submission.error }] };
              } else {
                toolData = submission.result;
              }
            } catch (error) {
              console.error("MCP submission failed:", error.message);
              result = {
                isError: true,
                content: [{ type: "text", text: "Sandbox execution failed. Check the server configuration and logs." }],
              };
            }
          } else {
            return rpcError(-32602, `Unknown tool: ${name || "(missing name)"}.`);
          }

          if (toolData !== undefined) {
            const text = JSON.stringify(toolData);
            result = { content: [{ type: "text", text }] };
          }
        } else {
          return rpcError(-32601, `Method not found: ${request.method}.`);
        }

        return json(res, 200, { jsonrpc: "2.0", id: request.id, result });
      }

      if (url.pathname === "/mcp") {
        res.writeHead(405, { Allow: "POST" });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/api/dispute") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        const last = getLastReview();
        if (!last) return res.end("Run a submission first to create a brief from its test results.");
        return res.end(agent.generateDisputeSummary(last.task, last.code, last.review.logs || "No test output."));
      }

      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const html = fs.readFileSync(path.join(__dirname, "../public/index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      return json(res, 404, { error: "Not found." });
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      const status = error.statusCode || 500;
      if (status >= 500) console.error("Request failed:", error);
      return json(res, status, { error: status >= 500 ? "The request failed. Check the server logs." : error.message });
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const agent = new MilestoneEscrowAgent();
  const taskStore = new TaskStore();
  let lastReview = null;
  let startupError = null;

  async function bootstrap() {
    try {
      await agent.setupSandbox();
    } catch (error) {
      startupError = error;
      console.error("CreateOS setup failed. Task pages are available, but submissions need a working sandbox:", error);
    }
  }

  const handler = createHandler({
    agent,
    taskStore,
    getEscrowRecord: () => null,
    getLastReview: () => lastReview,
    setLastReview: (review) => { lastReview = review; },
  });
  const server = http.createServer((req, res) => {
    if (startupError && req.method === "POST" && (req.url.startsWith("/api/evaluate") || req.url.includes("/submissions"))) {
      return json(res, 503, { error: "The test sandbox could not start. Check the server's CreateOS configuration." });
    }
    return handler(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Arbiter dashboard running at http://localhost:${PORT}`);
  });
  bootstrap();
}
