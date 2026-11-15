import type { ReactNode } from "react";

/**
 * Clean, lightweight Markdown renderer for OpenCode assistant responses.
 * Follows taste-skill typography & nesting rules:
 * - No nested boxes inside cards (only hairlines & subtle inline code tint)
 * - High-contrast readable prose (`text-zinc-200`, `leading-relaxed`)
 * - Proper fenced code blocks, GFM tables, `<br>` line breaks, inline code,
 *   bullet/numbered lists, bold, italic, links, blockquotes, and headings
 */
export function SimpleMarkdown({ text }: { text: string }) {
  if (!text.trim()) return null;

  const blocks = splitCodeBlocks(text.trim());

  return (
    <div className="space-y-2.5 text-[14px] leading-relaxed text-zinc-200">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <pre
            key={i}
            className="overflow-x-auto rounded border border-zinc-800/80 bg-zinc-950 px-3 py-2 font-mono text-[12px] leading-snug text-zinc-300"
          >
            <code>{b.content}</code>
          </pre>
        ) : (
          <ProseBlock key={i} text={b.content} />
        ),
      )}
    </div>
  );
}

function splitCodeBlocks(raw: string): Array<{ type: "prose" | "code"; content: string }> {
  const parts: Array<{ type: "prose" | "code"; content: string }> = [];
  const re = /```[\w-]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      parts.push({ type: "prose", content: raw.slice(last, m.index) });
    }
    parts.push({ type: "code", content: m[1].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    parts.push({ type: "prose", content: raw.slice(last) });
  }
  return parts;
}

type TableAlign = "left" | "center" | "right";

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = parseTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

function parseTableAlignments(line: string): TableAlign[] {
  return parseTableCells(line.trim()).map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    return "left";
  });
}

function parseTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // Split on unescaped pipes
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function ProseBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: ReactNode[] = [];
  let listItems: string[] = [];
  let k = 0;

  const flushList = () => {
    if (!listItems.length) return;
    elements.push(
      <ul key={k++} className="list-disc space-y-1 pl-4 text-zinc-300 marker:text-zinc-600">
        {listItems.map((item, idx) => (
          <li key={idx}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      flushList();
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushList();
      elements.push(<hr key={k++} className="border-zinc-800/80" />);
      i++;
      continue;
    }

    // GFM Table detection: current line has `|` and next line is a separator row (`|---|---|`)
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
    if (line.includes("|") && isTableSeparatorLine(nextLine)) {
      flushList();
      const headers = parseTableCells(line);
      const alignments = parseTableAlignments(nextLine);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes("|")) break;
        if (isTableSeparatorLine(rowLine)) {
          i++;
          continue;
        }
        rows.push(parseTableCells(rowLine));
        i++;
      }

      const alignCls = (colIdx: number) => {
        const a = alignments[colIdx] ?? "left";
        return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
      };

      elements.push(
        <div key={k++} className="overflow-x-auto rounded border border-zinc-800/80">
          <table className="w-full border-collapse text-[13px] leading-snug">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/70 text-zinc-200">
                {headers.map((h, colIdx) => (
                  <th
                    key={colIdx}
                    className={`px-2.5 py-1.5 font-medium ${alignCls(colIdx)} ${
                      colIdx > 0 ? "border-l border-zinc-800/60" : ""
                    }`}
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {rows.map((r, rIdx) => (
                <tr key={rIdx} className="hover:bg-zinc-900/30">
                  {headers.map((_, colIdx) => (
                    <td
                      key={colIdx}
                      className={`px-2.5 py-1.5 align-top text-zinc-300 ${alignCls(colIdx)} ${
                        colIdx > 0 ? "border-l border-zinc-800/40" : ""
                      }`}
                    >
                      {renderInline(r[colIdx] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+\.\s+(.*)$/);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]);
      i++;
      continue;
    }

    flushList();

    const headingMatch = line.match(/^#{1,4}\s+(.*)$/);
    if (headingMatch) {
      elements.push(
        <p key={k++} className="font-medium text-zinc-100">
          {renderInline(headingMatch[1])}
        </p>,
      );
      i++;
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      elements.push(
        <blockquote
          key={k++}
          className="border-l-2 border-zinc-700 pl-3 text-[13px] text-zinc-400"
        >
          {renderInline(quoteMatch[1])}
        </blockquote>,
      );
      i++;
      continue;
    }

    elements.push(
      <p key={k++} className="text-zinc-300">
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  flushList();
  return <>{elements}</>;
}

function renderInline(text: string): ReactNode[] {
  // First split on <br>, <br/>, <br /> (case-insensitive) so HTML line breaks become real <br />
  const brParts = text.split(/<br\s*\/?>/gi);
  if (brParts.length > 1) {
    const combined: ReactNode[] = [];
    brParts.forEach((part, idx) => {
      if (idx > 0) combined.push(<br key={`br-${idx}`} />);
      combined.push(...renderInlineTokens(part, `p${idx}-`));
    });
    return combined;
  }
  return renderInlineTokens(text, "");
}

function renderInlineTokens(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Match `code` or **bold** or [label](url)
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code
          key={`${keyPrefix}${idx++}`}
          className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={`${keyPrefix}${idx++}`} className="font-semibold text-zinc-100">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        out.push(
          <a
            key={`${keyPrefix}${idx++}`}
            href={lm[2]}
            target="_blank"
            rel="noreferrer"
            className="text-orange-400 underline underline-offset-2 hover:text-orange-300"
          >
            {lm[1]}
          </a>,
        );
      } else {
        out.push(tok);
      }
    }
    last = m.index + tok.length;
  }

  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}
