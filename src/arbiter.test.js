import test from "node:test";
import assert from "node:assert/strict";
import { generateDraft } from "./arbiter.js";

const validDraft = {
  title: "Add a greeting function",
  description: "Return a personalized greeting for a supplied name.",
  criteria: "Export greet(name) from submission.mjs. Return a greeting that includes the supplied name.",
  testCode: `import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "./submission.mjs";

test("greets a named person", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("handles another name", () => {
  assert.equal(greet("Lin"), "Hello, Lin!");
});`,
};

function mockedFetch(payload, status = 200, onRequest = () => {}) {
  return async (url, options) => {
    onRequest(url, options);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
}

test("drafts a validated problem through the Gemini generateContent API", async () => {
  let requestUrl;
  let requestBody;
  const draft = await generateDraft("Build a greeting function for a person's name.", [], {
    apiKey: "test-api-key",
    fetchImpl: mockedFetch({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validDraft) }] } }],
    }, 200, (url, options) => {
      requestUrl = new URL(url);
      requestBody = JSON.parse(options.body);
    }),
  });

  assert.equal(requestUrl.hostname, "generativelanguage.googleapis.com");
  assert.equal(requestUrl.pathname, "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(requestUrl.searchParams.get("key"), "test-api-key");
  assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  assert.match(requestBody.contents[0].parts[0].text, /Build a greeting function/);
  assert.deepEqual(draft, validDraft);
});

test("includes prior conversation when the author asks for a revision", async () => {
  let prompt;
  await generateDraft("Build a greeting function for a person's name.", [
    { role: "user", content: "Include punctuation." },
    { role: "assistant", content: "I will include a period at the end." },
  ], {
    apiKey: "test-api-key",
    fetchImpl: mockedFetch({
      candidates: [{ content: { parts: [{ text: JSON.stringify(validDraft) }] } }],
    }, 200, (_url, options) => {
      prompt = JSON.parse(options.body).contents[0].parts[0].text;
    }),
  });

  assert.match(prompt, /Author: Include punctuation\./);
  assert.match(prompt, /Arbiter: I will include a period at the end\./);
});

test("does not fabricate a draft when Gemini is not configured", async () => {
  await assert.rejects(
    generateDraft("Build a greeting function for a person's name.", [], { apiKey: "" }),
    (error) => error.statusCode === 503
      && /GEMINI_API_KEY/.test(error.message)
      && /Copy \.env\.example to \.env/.test(error.message),
  );
});

test("rejects placeholder acceptance tests from the model", async () => {
  const placeholder = {
    ...validDraft,
    testCode: `import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "./submission.mjs";
test("placeholder", () => assert.ok(true));
test("second placeholder", () => assert.ok(true));`,
  };

  await assert.rejects(
    generateDraft("Build a greeting function for a person's name.", [], {
      apiKey: "test-api-key",
      fetchImpl: mockedFetch({
        candidates: [{ content: { parts: [{ text: JSON.stringify(placeholder) }] } }],
      }),
    }),
    /substantive node:test acceptance tests/,
  );
});

test("reports Gemini HTTP failures without returning placeholder tests", async () => {
  await assert.rejects(
    generateDraft("Build a greeting function for a person's name.", [], {
      apiKey: "test-api-key",
      fetchImpl: mockedFetch({}, 403),
    }),
    (error) => error.statusCode === 502 && /HTTP 403/.test(error.message),
  );
});
