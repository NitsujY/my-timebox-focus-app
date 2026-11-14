import type { ReactNode } from "react";

/**
 * Clean, lightweight Markdown renderer for OpenCode assistant responses.
 * Follows taste-skill typography & nesting rules:
 * - No nested boxes inside cards (only hairlines & subtle inline code tint)
 * - High-contrast readable prose (`text-zinc-200`, `leading-relaxed`)
 * - Proper fenced code blocks, inline code, bullet/numbered lists, bold, links, and headings
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

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+\.\s+(.*)$/);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]);
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
      continue;
    }

    elements.push(
      <p key={k++} className="text-zinc-300">
        {renderInline(line)}
      </p>,
    );
  }

  flushList();
  return <>{elements}</>;
}

function renderInline(text: string): ReactNode[] {
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
          key={idx++}
          className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[12px] text-zinc-200"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={idx++} className="font-semibold text-zinc-100">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        out.push(
          <a
            key={idx++}
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
