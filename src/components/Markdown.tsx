import React, { useState } from 'react';
import { ios } from './ui/ios';

/**
 * The AI's answers, formatted: headings, paragraphs, numbered steps, bullet lists (one level of
 * nesting), code blocks with a Copy button, tables, quotes, **bold**, *italic*, `code` and links.
 * The first paragraph can be shown a little larger, since the assistant starts with the answer.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![A-Za-z0-9_])_[^_\s][^_\n]*_(?![A-Za-z0-9_])|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

export function inline(s: string, key: string | number = 0): React.ReactNode[] {
  return s.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (!part) return null;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={k} className="font-mono text-[13px] px-[5px] py-px rounded-[5px] break-words" style={{ background: 'rgba(255,255,255,0.09)', color: '#E5E5EA' }}>
          {part.slice(1, -1)}
        </code>
      );
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__')))
      return (
        <strong key={k} className="font-semibold text-white">
          {inline(part.slice(2, -2), k)}
        </strong>
      );
    if (/^\[[^\]]+\]\(https?:/.test(part)) {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
      if (m)
        return (
          <a key={k} href={m[2]} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2" style={{ color: ios.link }}>
            {m[1]}
          </a>
        );
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) return <em key={k}>{part.slice(1, -1)}</em>;
    return <React.Fragment key={k}>{part}</React.Fragment>;
  });
}

const CodeBlock: React.FC<{ code: string; lang?: string }> = ({ code, lang }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-[10px] overflow-hidden" style={{ background: 'rgba(0,0,0,0.38)', boxShadow: '0 0 0 0.5px rgba(255,255,255,0.08)' }}>
      <div className="flex items-center justify-between px-3 h-[28px] text-[12px]" style={{ color: ios.secondary, borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
        <span className="uppercase tracking-wide font-medium">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="font-medium hover:opacity-80"
          style={{ color: copied ? ios.green : ios.blue }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="px-3 py-2.5 font-mono text-[13px] leading-[19px] overflow-x-auto whitespace-pre" style={{ color: 'rgba(235,235,245,0.85)' }}>
        {code}
      </pre>
    </div>
  );
};

interface ListItem {
  text: string;
  children: string[];
  num?: number;
}

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang?: string; code: string }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

const LIST = /^(\s*)([-*•+]|\d+[.)])\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or the end, if the answer was cut short)
      blocks.push({ t: 'code', lang: fence[1] || undefined, code: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', lines: q });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const baseIndent = li[1].length;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          items.push({ text: m[3], children: [], num: ordered ? parseInt(m[2], 10) : undefined });
          i++;
        } else if (m && m[1].length > baseIndent + 1 && items.length) {
          items[items.length - 1].children.push(m[3]);
          i++;
        } else if (!m && lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // A wrapped line belonging to the item above
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.exec(lines[i]) && !/^\s*(```|#{1,6}\s|>)/.test(lines[i])) para.push(lines[i++].trim());
    if (para.length) blocks.push({ t: 'p', lines: para });
    else i++;
  }
  return blocks;
}

export const Markdown: React.FC<{ text: string; lead?: boolean; className?: string }> = ({ text, lead, className = '' }) => {
  const blocks = parseMarkdown(text);
  let firstPara = true;
  return (
    <div className={`space-y-3 text-[15px] leading-[23px] ${className}`}>
      {blocks.map((b, i) => {
        if (b.t === 'p') {
          const isLead = lead && firstPara && i === 0;
          firstPara = false;
          return (
            <p key={i} className={isLead ? 'text-[16px] leading-[24px] text-white' : undefined}>
              {b.lines.map((l, k) => (
                <React.Fragment key={k}>
                  {k > 0 && <br />}
                  {inline(l, `${i}-${k}`)}
                </React.Fragment>
              ))}
            </p>
          );
        }
        if (b.t === 'h')
          return (
            <p key={i} className={`font-semibold text-white ${b.level <= 2 ? 'text-[17px] leading-[24px] pt-1' : 'text-[16px]'}`}>
              {inline(b.text, i)}
            </p>
          );
        if (b.t === 'code') return <CodeBlock key={i} code={b.code} lang={b.lang} />;
        if (b.t === 'hr') return <div key={i} className="h-px" style={{ background: ios.separator }} />;
        if (b.t === 'quote')
          return (
            <div key={i} className="pl-3 py-0.5" style={{ borderLeft: '3px solid rgba(191,90,242,0.55)', color: ios.secondary }}>
              {b.lines.map((l, k) => (
                <p key={k}>{inline(l, `${i}-${k}`)}</p>
              ))}
            </div>
          );
        if (b.t === 'table')
          return (
            <div key={i} className="overflow-x-auto rounded-[10px]" style={{ boxShadow: '0 0 0 0.5px rgba(255,255,255,0.1)' }}>
              <table className="w-full text-[13px] leading-[19px]">
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.06)' }}>
                    {b.head.map((c, k) => (
                      <th key={k} className="text-left font-semibold text-white px-3 py-2">
                        {inline(c, k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, k) => (
                    <tr key={k} style={{ borderTop: `0.5px solid ${ios.separator}` }}>
                      {r.map((c, j) => (
                        <td key={j} className="px-3 py-1.5 align-top">
                          {inline(c, `${k}-${j}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        // Lists: numbered steps get a numbered circle, bullets a dot
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i} className="space-y-2">
            {b.items.map((it, k) => (
              <li key={k} className="flex gap-2.5">
                {b.ordered ? (
                  <span className="mt-[2px] w-[20px] h-[20px] rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0 tabular-nums" style={{ background: 'rgba(10,132,255,0.2)', color: ios.link }}>
                    {it.num ?? k + 1}
                  </span>
                ) : (
                  <span className="mt-[9px] w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: ios.secondary }} />
                )}
                <div className="min-w-0 flex-1">
                  <div>{inline(it.text, `${i}-${k}`)}</div>
                  {it.children.length > 0 && (
                    <ul className="mt-1 space-y-1">
                      {it.children.map((c, j) => (
                        <li key={j} className="flex gap-2 text-[15px]" style={{ color: ios.secondary }}>
                          <span className="mt-[8px] w-[4px] h-[4px] rounded-full flex-shrink-0" style={{ background: ios.tertiary }} />
                          <span className="min-w-0">{inline(c, `${i}-${k}-${j}`)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
};
