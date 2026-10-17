const inlinePattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\((?:[^()]|\([^()]*\))+\))/g;

function safeHref(value) {
  const href = value.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^(\/(?!\/)|\.{1,2}\/|#)/.test(href)) return href;
  return null;
}

function inlineTokens(text) {
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index;
    if (index > cursor) tokens.push({ type: "text", text: text.slice(cursor, index) });
    const raw = match[0];
    if (raw.startsWith("**")) {
      tokens.push({ type: "strong", text: raw.slice(2, -2) });
    } else if (raw.startsWith("*")) {
      tokens.push({ type: "emphasis", text: raw.slice(1, -1) });
    } else if (raw.startsWith("`")) {
      tokens.push({ type: "inlineCode", text: raw.slice(1, -1) });
    } else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link && safeHref(link[2]);
      if (link && href) {
        tokens.push({ type: "link", text: link[1], href });
      } else {
        tokens.push({ type: "text", text: raw });
      }
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens;
}

export function parseMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", content: inlineTokens(paragraph.join("\n")) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push({ type: "code", language: code.language, text: code.lines.join("\n") });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      code = { language: fence[1], lines: [] };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        content: inlineTokens(heading[2]),
      });
      continue;
    }

    const item = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (item) {
      flushParagraph();
      const ordered = Boolean(item[2]);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { type: "list", ordered, items: [] };
      list.items.push(inlineTokens(item[3]));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (code) blocks.push({ type: "code", language: code.language, text: code.lines.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

function appendInlineMarkdown(parent, tokens) {
  for (const token of tokens) {
    if (token.type === "text") {
      const lines = token.text.split("\n");
      lines.forEach((line, index) => {
        if (index) parent.append(document.createElement("br"));
        parent.append(document.createTextNode(line));
      });
      continue;
    }
    const tag = {
      strong: "strong",
      emphasis: "em",
      inlineCode: "code",
      link: "a",
    }[token.type];
    const child = document.createElement(tag || "span");
    child.textContent = token.text;
    if (token.type === "link") {
      child.href = token.href;
      if (/^https?:/i.test(token.href)) {
        child.target = "_blank";
        child.rel = "noopener noreferrer";
      }
    }
    parent.append(child);
  }
}

export function renderMarkdown(container, markdown) {
  container.replaceChildren();
  for (const block of parseMarkdown(markdown)) {
    if (block.type === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      container.append(pre);
      continue;
    }
    if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const itemTokens of block.items) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemTokens);
        list.append(item);
      }
      container.append(list);
      continue;
    }
    const node = block.type === "heading"
      ? document.createElement(`h${block.level}`)
      : document.createElement("p");
    appendInlineMarkdown(node, block.content);
    container.append(node);
  }
}
