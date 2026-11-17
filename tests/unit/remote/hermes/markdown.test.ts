// @vitest-environment jsdom
import { renderMarkdown } from "@/remote/hermes/markdown";

describe("remote Markdown", () => {
  it("renders headings, emphasis, tables, code and a manually opened HTTPS link", () => {
    const node = document.createElement("div");
    renderMarkdown(node, "# 결과\n\n**강조**와 [문서](https://example.com/docs)\n\n| 열 | 값 |\n|---|---|\n| A | 1 |\n\n```typescript\nconst n = 1;\n```");
    expect(node.querySelector("h1")?.textContent).toBe("결과");
    expect(node.querySelector("strong")?.textContent).toBe("강조");
    expect(node.querySelector("a")?.href).toBe("https://example.com/docs");
    expect(node.querySelector("td")?.textContent).toBe("A");
    expect(node.querySelector("code")?.textContent).toBe("const n = 1;");
  });
  it.each([
    "<img src='https://evil.test/pixel' onerror='window.pwned=1'>",
    "![pixel](https://evil.test/pixel)",
    "[run](javascript:alert%281%29)",
    "[vault](obsidian://open?vault=Zero&file=secret)",
    "<iframe src='https://evil.test'></iframe>",
    "```dataviewjs\nwindow.pwned=1\n```",
    "![[secret-note]]",
  ])("leaves executable and network content inert: %s", (content) => {
    const node = document.createElement("div"); renderMarkdown(node, content);
    expect(node.querySelectorAll("img,iframe,script,object,embed")).toHaveLength(0);
    expect([...node.querySelectorAll("a")].map((link) => link.protocol)).toEqual([]);
    expect(node.textContent?.length).toBeGreaterThan(0);
  });
});
