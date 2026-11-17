import { Lexer, type MarkedToken, type Token } from "marked";

function tokens(parent: HTMLElement, items: readonly Token[] | undefined): void {
  for (const item of items ?? []) {
    const token = item as MarkedToken;
    switch (token.type) {
      case "space": break;
      case "heading": {
        const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
        const heading = parent.createEl(levels[Math.min(5, Math.max(0, token.depth - 1))] ?? 'h6');
        tokens(heading, token.tokens); parent.append(heading); break;
      }
      case "paragraph": {
        const paragraph = parent.createEl("p");
        tokens(paragraph, token.tokens); parent.append(paragraph); break;
      }
      case "strong": case "em": case "del": {
        const element = parent.createEl(token.type === "strong" ? "strong" : token.type === "em" ? "em" : "del");
        tokens(element, token.tokens); parent.append(element); break;
      }
      case "code": {
        const pre = parent.createEl("pre"); const code = parent.createEl("code");
        code.textContent = token.text; pre.append(code); parent.append(pre); break;
      }
      case "codespan": {
        const code = parent.createEl("code"); code.textContent = token.text; parent.append(code); break;
      }
      case "blockquote": {
        const quote = parent.createEl("blockquote"); tokens(quote, token.tokens); parent.append(quote); break;
      }
      case "list": {
        const list = parent.createEl(token.ordered ? "ol" : "ul");
        for (const item of token.items) { const li = parent.createEl("li"); tokens(li, item.tokens); list.append(li); }
        parent.append(list); break;
      }
      case "table": {
        const wrapper = parent.createDiv(); wrapper.className = "kkn-table";
        const table = parent.createEl("table"); const head = parent.createEl("thead");
        const header = parent.createEl("tr");
        for (const cell of token.header) { const th = parent.createEl("th"); tokens(th, cell.tokens); header.append(th); }
        head.append(header); table.append(head); const body = parent.createEl("tbody");
        for (const row of token.rows) { const tr = parent.createEl("tr");
          for (const cell of row) { const td = parent.createEl("td"); tokens(td, cell.tokens); tr.append(td); }
          body.append(tr);
        }
        table.append(body); wrapper.append(table); parent.append(wrapper); break;
      }
      case "link": {
        let target: URL | null = null;
        try { target = new URL(token.href); } catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (target && ["https:", "http:"].includes(target.protocol) && !target.username && !target.password) {
          const link = parent.createEl("a"); link.href = target.href;
          link.rel = "noopener noreferrer"; link.target = "_blank"; tokens(link, token.tokens); parent.append(link);
        } else parent.append(parent.ownerDocument.createTextNode(token.text));
        break;
      }
      case "br": parent.append(parent.createEl("br")); break;
      case "hr": parent.append(parent.createEl("hr")); break;
      case "image": parent.append(parent.ownerDocument.createTextNode(`[이미지: ${token.text}]`)); break;
      case "html": parent.append(parent.ownerDocument.createTextNode(token.raw)); break;
      case "text": case "escape": parent.append(parent.ownerDocument.createTextNode(token.text)); break;
      default: parent.append(parent.ownerDocument.createTextNode(token.raw)); break;
    }
  }
}

export function renderMarkdown(parent: HTMLElement, content: string): void {
  tokens(parent, Lexer.lex(content, { gfm: true }));
}
