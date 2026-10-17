import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMarkdown, renderMarkdown } from "../public/markdown.js";

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.text = "";
  }

  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
    this.text = "";
  }
}

test("parses headings, emphasis, inline code, links, and lists as typed text nodes", () => {
  const blocks = parseMarkdown(`# Spec

Use **strict** checks and \`greet(name)\`; see [docs](https://example.com).

- First requirement
- *Second* requirement
1. Ordered item`);

  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].content, [
    { type: "text", text: "Use " },
    { type: "strong", text: "strict" },
    { type: "text", text: " checks and " },
    { type: "inlineCode", text: "greet(name)" },
    { type: "text", text: "; see " },
    { type: "link", text: "docs", href: "https://example.com" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(blocks[2], {
    type: "list",
    ordered: false,
    items: [
      [{ type: "text", text: "First requirement" }],
      [{ type: "emphasis", text: "Second" }, { type: "text", text: " requirement" }],
    ],
  });
  assert.equal(blocks[3].ordered, true);
});

test("keeps code fences literal and never interprets raw HTML as markup", () => {
  const blocks = parseMarkdown(`Use <img src=x onerror=alert(1)> literally.

\`\`\`html
<script>alert("no")</script>
\`\`\``);

  assert.deepEqual(blocks[0].content, [
    { type: "text", text: "Use <img src=x onerror=alert(1)> literally." },
  ]);
  assert.equal(blocks[1].type, "code");
  assert.equal(blocks[1].text, '<script>alert("no")</script>');
});

test("does not turn dangerous markdown link schemes into clickable links", () => {
  const [block] = parseMarkdown("[unsafe](javascript:alert(1))");
  assert.deepEqual(block.content, [
    { type: "text", text: "[unsafe](javascript:alert(1))" },
  ]);
});

test("supports unterminated code fences as plain code content", () => {
  const [block] = parseMarkdown("```js\nconst answer = 42;");
  assert.deepEqual(block, { type: "code", language: "js", text: "const answer = 42;" });
});

test("renders untrusted Markdown as constructed elements and text, never raw HTML", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => {
      const node = new FakeNode("#text");
      node.textContent = text;
      return node;
    },
  };
  try {
    const container = new FakeNode("div");
    renderMarkdown(container, `**Safe** <img src=x onerror=alert(1)>

\`\`\`html
<script>alert(1)</script>
\`\`\`

[unsafe](javascript:alert(1))`);
    const tags = [];
    const textValues = [];
    const visit = (node) => {
      tags.push(node.tagName);
      if (node.text) textValues.push(node.text);
      for (const child of node.children) visit(child);
    };
    visit(container);

    assert.ok(tags.includes("strong"));
    assert.ok(tags.includes("pre"));
    assert.ok(tags.includes("code"));
    assert.equal(tags.includes("img"), false);
    assert.equal(tags.includes("script"), false);
    assert.equal(tags.includes("a"), false);
    assert.ok(textValues.some((text) => text.includes("<img src=x onerror=alert(1)>")));
    assert.ok(textValues.includes("<script>alert(1)</script>"));
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("browser UI contains no raw-HTML injection sink", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /import \{ renderMarkdown \} from "\/markdown\.js"/);
  assert.doesNotMatch(html, /\.innerHTML\b|insertAdjacentHTML\s*\(/);
});
