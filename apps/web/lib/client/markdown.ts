// Markdown → HTML。先把源文里的 HTML 转义掉(复盘正文里有模型润色过的文字,不能让它带进标签),
// 再交给 marked 渲染;链接只放行 http(s)、mailto 和站内路径,表格外面包一层可横向滚动的容器。
import { Marked, type Tokens } from "marked";

function escapeAll(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 只转义 & 和 <:足以让任何标签失效,又不破坏 ">" 引用块语法。 */
function escapeSource(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** 代码里的内容会被 marked 再转义一遍,先还原,避免显示成 &amp;lt;。 */
function unescapeSource(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

const md = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // 预转义之后理论上不会再有 html token;万一有,也按纯文本输出
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeAll(token.text);
    },
    codespan(token: Tokens.Codespan) {
      return `<code>${escapeAll(unescapeSource(token.text))}</code>`;
    },
    code(token: Tokens.Code) {
      return `<pre><code>${escapeAll(unescapeSource(token.text))}</code></pre>\n`;
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = unescapeSource(token.href ?? "");
      if (!SAFE_HREF.test(href)) return text;
      const external = /^https?:\/\//i.test(href);
      return `<a href="${escapeAll(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
    },
    image(token: Tokens.Image) {
      // 复盘与协议里不需要外链图片,只保留替代文字
      return escapeAll(token.text);
    },
    table(token: Tokens.Table) {
      const cell = (c: Tokens.TableCell, tag: "th" | "td") => {
        const align = c.align ? ` style="text-align:${c.align}"` : "";
        return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
      };
      const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
      const body = token.rows.map((row) => `<tr>${row.map((c) => cell(c, "td")).join("")}</tr>`).join("");
      // 四列及以上的表在手机上给个最小宽度,宁可横向滑动也不要把每格挤成一两个字宽
      const wide = token.header.length >= 4 ? ' class="wide"' : "";
      return `<div class="table-wrap"><table${wide}><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
    },
  },
});

export function renderMarkdown(source: string): string {
  return md.parse(escapeSource(source)) as string;
}
