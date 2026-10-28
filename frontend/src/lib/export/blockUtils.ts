// Shared helpers for exporting meeting summaries and transcripts (PDF / DOCX).

export interface ExportInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  link?: string;
}

export interface ExportBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'number' | 'check' | 'quote' | 'code' | 'table';
  level?: number;
  checked?: boolean;
  inlines: ExportInline[];
  rows?: ExportInline[][][]; // table: rows -> cells -> inlines
  children?: ExportBlock[];
}

export interface ExportTranscriptSegment {
  speaker?: string;
  text: string;
}

export interface ExportDocumentData {
  title: string;
  dateText: string;
  blocks: ExportBlock[];
  transcripts?: ExportTranscriptSegment[] | null;
  labels: {
    transcriptHeading: string;
  };
}

function styledInline(item: any): ExportInline | null {
  if (!item) return null;
  if (item.type === 'link') {
    const inner = Array.isArray(item.content) ? item.content : [];
    const text = inner.map((c: any) => c?.text ?? '').join('');
    if (!text) return null;
    return { text, link: item.href, underline: true };
  }
  const text = typeof item === 'string' ? item : item.text;
  if (typeof text !== 'string' || text.length === 0) return null;
  const styles = item.styles || {};
  return {
    text,
    bold: !!styles.bold,
    italic: !!styles.italic,
    underline: !!styles.underline,
    strike: !!styles.strike,
  };
}

function inlinesFrom(content: any): ExportInline[] {
  if (!Array.isArray(content)) return [];
  return content.map(styledInline).filter((i): i is ExportInline => i !== null);
}

function cellInlines(cell: any): ExportInline[] {
  // BlockNote table cells are either plain inline arrays or { type: 'tableCell', content: [...] }
  if (Array.isArray(cell)) return inlinesFrom(cell);
  if (cell && Array.isArray(cell.content)) return inlinesFrom(cell.content);
  return [];
}

/** Normalize BlockNote blocks into a renderer-agnostic intermediate structure. */
export function normalizeBlocks(blocks: any[]): ExportBlock[] {
  const result: ExportBlock[] = [];
  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    const children = Array.isArray(block.children) && block.children.length > 0
      ? normalizeBlocks(block.children)
      : undefined;
    switch (block.type) {
      case 'heading':
        result.push({ kind: 'heading', level: Number(block.props?.level) || 1, inlines: inlinesFrom(block.content), children });
        break;
      case 'bulletListItem':
        result.push({ kind: 'bullet', inlines: inlinesFrom(block.content), children });
        break;
      case 'numberedListItem':
        result.push({ kind: 'number', inlines: inlinesFrom(block.content), children });
        break;
      case 'checkListItem':
        result.push({ kind: 'check', checked: !!block.props?.checked, inlines: inlinesFrom(block.content), children });
        break;
      case 'codeBlock':
        result.push({ kind: 'code', inlines: inlinesFrom(block.content), children });
        break;
      case 'quote':
        result.push({ kind: 'quote', inlines: inlinesFrom(block.content), children });
        break;
      case 'table': {
        const rows = (block.content?.rows || []).map((row: any) => (row?.cells || []).map(cellInlines));
        result.push({ kind: 'table', inlines: [], rows });
        break;
      }
      default: {
        const inlines = inlinesFrom(block.content);
        if (inlines.length > 0 || children) {
          result.push({ kind: 'paragraph', inlines, children });
        }
        break;
      }
    }
  }
  return result;
}

/** Convert legacy summary JSON ({ key: { title, blocks: [{ content }] } }) to export blocks. */
export function legacySummaryToBlocks(summary: any): ExportBlock[] {
  const result: ExportBlock[] = [];
  if (!summary || typeof summary !== 'object') return result;
  for (const key of Object.keys(summary)) {
    const section = summary[key];
    if (!section || typeof section !== 'object' || !section.title || !Array.isArray(section.blocks)) continue;
    result.push({ kind: 'heading', level: 2, inlines: [{ text: String(section.title) }] });
    for (const b of section.blocks) {
      const text = typeof b?.content === 'string' ? b.content.trim() : '';
      if (text) result.push({ kind: 'bullet', inlines: [{ text }] });
    }
  }
  return result;
}

export function plainText(inlines: ExportInline[]): string {
  return inlines.map((i) => i.text).join('');
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'meeting';
}

export function formatMeetingDate(createdAt: string): string {
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return createdAt;
  return d.toLocaleString();
}
