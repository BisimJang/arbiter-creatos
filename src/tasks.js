import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const taskFile = path.join(__dirname, "../data/tasks.json");
const activityFile = path.join(__dirname, "../data/task-activity.json");
const submissionFilename = "submission.mjs";
const acceptanceFilename = "acceptance.test.mjs";
const activityTypes = new Set([
  "problem_published",
  "submission_received",
  "tests_completed",
  "execution_failed",
]);

export const rateLimiterTests = `
import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucketRateLimiter } from "./submission.mjs";

test("starts with the full burst capacity", () => {
  const limiter = new TokenBucketRateLimiter(5, 10);
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.tryAcquire(), true);
});

test("rejects requests after the bucket is empty", () => {
  const limiter = new TokenBucketRateLimiter(2, 10);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
});

test("rejecting a large request does not consume remaining tokens", () => {
  const limiter = new TokenBucketRateLimiter(5, 10);
  assert.equal(limiter.tryAcquire(4), true);
  assert.equal(limiter.tryAcquire(2), false);
  assert.equal(limiter.tryAcquire(1), true);
});

test("refills tokens based on elapsed time", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const limiter = new TokenBucketRateLimiter(5, 2);
    for (let i = 0; i < 5; i += 1) assert.equal(limiter.tryAcquire(), true);
    assert.equal(limiter.tryAcquire(), false);
    now += 500;
    assert.equal(limiter.tryAcquire(), true);
  } finally {
    Date.now = originalNow;
  }
});

test("never refills beyond the configured capacity", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const limiter = new TokenBucketRateLimiter(2, 10);
    now += 10_000;
    assert.equal(limiter.tryAcquire(2), true);
    assert.equal(limiter.tryAcquire(), false);
  } finally {
    Date.now = originalNow;
  }
});
`;

export const rateLimiterSolution = `export class TokenBucketRateLimiter {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillRate);
    this.lastRefill = now;
  }

  tryAcquire(amount = 1) {
    this.refill();
    if (amount <= 0 || this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}
`;

export const rateLimiterStarter = `export class TokenBucketRateLimiter {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate;
  }

  tryAcquire(amount = 1) {
    // TODO: Track available tokens and refill them over time.
    return true;
  }
}
`;

export const seedTask = {
  id: "m_ratelimiter_v1",
  title: "Build a token bucket rate limiter",
  description: "Write a JavaScript class that limits how often requests can run.",
  criteria: "Export TokenBucketRateLimiter from submission.mjs. The constructor takes (capacity, refillRate), where refillRate is tokens per second. tryAcquire(amount = 1) returns true only when enough tokens are available, starts with a full bucket, refills over time, and never stores more than capacity.",
  amountCents: 25000,
  currency: "USD",
  submissionFilename,
  testFilename: acceptanceFilename,
  testCode: rateLimiterTests,
  testsCount: 5,
  createdAt: new Date().toISOString(),
  seeded: true,
};

function invalidTask(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateTask(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidTask("Task details must be sent as a JSON object.");
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const criteria = typeof input.criteria === "string" ? input.criteria.trim() : "";
  const testCode = typeof input.testCode === "string" ? input.testCode.trim() : "";
  const amount = Number(input.amount);

  if (title.length < 4 || title.length > 100) throw invalidTask("Title must be 4 to 100 characters.");
  if (description.length < 10 || description.length > 1000) throw invalidTask("Problem description must be 10 to 1,000 characters.");
  if (criteria.length < 10 || criteria.length > 2000) throw invalidTask("Requirements must be 10 to 2,000 characters.");
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw invalidTask("Reward must be between $0 and $100,000.");
  if (testCode.length < 20 || testCode.length > 64000) throw invalidTask("Acceptance tests must be 20 to 64,000 characters.");
  if (!/\btest\s*\(/.test(testCode)) throw invalidTask("Write acceptance tests with Node.js test() from node:test.");
  if (!testCode.includes(`./${submissionFilename}`)) throw invalidTask(`Acceptance tests must import the submission from ./${submissionFilename}.`);

  return {
    id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    description,
    criteria,
    amountCents: Math.round(amount * 100),
    currency: "USD",
    submissionFilename,
    testFilename: acceptanceFilename,
    testCode,
    testsCount: (testCode.match(/\btest\s*\(/g) || []).length,
    createdAt: new Date().toISOString(),
    seeded: false,
  };
}

function readStoredTasks(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not load saved tasks: ${error.message}`);
  }
}

function writeJsonAtomically(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temporaryFile, filePath);
}

export class TaskStore {
  constructor(filePath = taskFile, options = {}) {
    this.filePath = filePath;
    this.activityFilePath = options.activityFilePath
      || path.join(path.dirname(filePath), path.basename(filePath).replace(/tasks\.json$/, "task-activity.json"));
    this.tasks = new Map([[seedTask.id, { ...seedTask }]]);
    for (const task of readStoredTasks(filePath)) this.tasks.set(task.id, task);
    this.activity = new Map();
    for (const event of readStoredTasks(this.activityFilePath)) {
      if (!event || typeof event.taskId !== "string" || !activityTypes.has(event.type)) continue;
      const events = this.activity.get(event.taskId) || [];
      events.push(event);
      this.activity.set(event.taskId, events);
    }
  }

  list() {
    return [...this.tasks.values()].map((task) => {
      const { testCode, ...publicTask } = task;
      return { ...publicTask, progress: this.progress(task.id) };
    });
  }

  get(id) {
    return this.tasks.get(id);
  }

  progress(id) {
    const events = this.getActivity(id);
    const latest = events.at(-1);
    let status = "open";
    if (latest?.type === "submission_received") status = "in_progress";
    if (latest?.type === "tests_completed") {
      status = latest.decision === "APPROVED" ? "approved" : "needs_changes";
    }
    if (latest?.type === "execution_failed") status = "blocked";
    return {
      status,
      eventCount: events.length,
      latestEvent: latest
        ? {
          type: latest.type,
          timestamp: latest.timestamp,
          summary: latest.summary || null,
          decision: latest.decision || null,
        }
        : null,
    };
  }

  getActivity(id) {
    const events = this.activity.get(id) || [];
    if (events.length === 0 && this.tasks.get(id)?.seeded) {
      return [{
        id: `event_${id}_published`,
        taskId: id,
        type: "problem_published",
        timestamp: this.tasks.get(id).createdAt,
        summary: "Seed challenge published.",
      }];
    }
    return events.map((event) => ({ ...event }));
  }

  recordActivity(id, type, details = {}) {
    if (!this.tasks.has(id)) throw new Error("Cannot record activity for an unknown problem.");
    if (!activityTypes.has(type)) throw new Error(`Unsupported activity event type: ${type}`);
    const events = this.activity.get(id) || [];
    if (events.length === 0 && this.tasks.get(id).seeded) {
      events.push({
        id: `event_${id}_published`,
        taskId: id,
        type: "problem_published",
        timestamp: this.tasks.get(id).createdAt,
        summary: "Seed challenge published.",
      });
    }
    const event = {
      id: `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      taskId: id,
      type,
      timestamp: new Date().toISOString(),
      ...details,
    };
    events.push(event);
    this.activity.set(id, events);
    writeJsonAtomically(
      this.activityFilePath,
      [...this.activity.values()].flat(),
    );
    return { ...event };
  }

  create(input) {
    const task = validateTask(input);
    this.tasks.set(task.id, task);
    writeJsonAtomically(this.filePath, [...this.tasks.values()].filter((item) => !item.seeded));
    this.recordActivity(task.id, "problem_published", {
      summary: "The author approved and published this problem.",
    });
    return task;
  }
}

export function countTestResults(output) {
  const tests = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+.*)?$/);
    if (match) tests.push({ name: match[2], passed: match[1] === "ok" });
  }
  return {
    tests,
    passed: tests.filter((item) => item.passed).length,
    failed: tests.filter((item) => !item.passed).length,
  };
}
