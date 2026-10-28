// PDF export via pdfmake with a bundled CJK font (Noto Sans SC).
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { ExportBlock, ExportDocumentData, ExportInline, plainText } from './blockUtils';

let fontsReady = false;

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load font: ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ensureFonts(pdfMake: any): Promise<void> {
  if (fontsReady) return;
  const [regular, bold] = await Promise.all([
    fetchFontBase64('/fonts/NotoSansSC-Regular.ttf'),
    fetchFontBase64('/fonts/NotoSansSC-Bold.ttf'),
  ]);
  pdfMake.addVirtualFileSystem({
    'NotoSansSC-Regular.ttf': regular,
    'NotoSansSC-Bold.ttf': bold,
  });
  pdfMake.setFonts({
    NotoSansSC: {
      normal: 'NotoSansSC-Regular.ttf',
      bold: 'NotoSansSC-Bold.ttf',
      italics: 'NotoSansSC-Regular.ttf',
      bolditalics: 'NotoSansSC-Bold.ttf',
    },
  });
  fontsReady = true;
}

function inlineToPdf(inline: ExportInline): any {
  const node: any = { text: inline.text };
  if (inline.bold) node.bold = true;
  if (inline.italic) node.italics = true;
  if (inline.underline) node.decoration = 'underline';
  else if (inline.strike) node.decoration = 'lineThrough';
  if (inline.link) {
    node.link = inline.link;
    node.color = '#2563eb';
    node.decoration = 'underline';
  }
  return node;
}

function inlinesToPdf(inlines: ExportInline[]): any {
  if (inlines.length === 0) return { text: ' ' };
  return { text: inlines.map(inlineToPdf) };
}

const HEADING_SIZES: Record<number, number> = { 1: 17, 2: 14.5, 3: 12.5 };

function blocksToPdfContent(blocks: ExportBlock[]): any[] {
  const content: any[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];

    // Merge consecutive list items into a single ul/ol node
    if (block.kind === 'bullet' || block.kind === 'number' || block.kind === 'check') {
      const kind = block.kind;
      const items: any[] = [];
      while (i < blocks.length && blocks[i].kind === kind) {
        const item = blocks[i];
        let node: any;
        if (kind === 'check') {
          node = { text: [{ text: item.checked ? '\u2611 ' : '\u2610 ' }, ...item.inlines.map(inlineToPdf)] };
        } else {
          node = inlinesToPdf(item.inlines);
        }
        if (item.children && item.children.length > 0) {
          node = { stack: [node, { margin: [12, 0, 0, 0], stack: blocksToPdfContent(item.children) }] };
        }
        items.push(node);
        i++;
      }
      if (kind === 'number') content.push({ ol: items, margin: [0, 2, 0, 6] });
      else if (kind === 'bullet') content.push({ ul: items, margin: [0, 2, 0, 6] });
      else content.push({ stack: items, margin: [0, 2, 0, 6] });
      continue;
    }

    switch (block.kind) {
      case 'heading': {
        const size = HEADING_SIZES[block.level || 1] || 12;
        content.push({ ...inlinesToPdf(block.inlines), fontSize: size, bold: true, margin: [0, (block.level || 1) === 1 ? 10 : 8, 0, 4] });
        break;
      }
      case 'quote':
        content.push({ ...inlinesToPdf(block.inlines), italics: true, color: '#555555', margin: [10, 2, 0, 6] });
        break;
      case 'code':
        content.push({ text: plainText(block.inlines), color: '#334155', fontSize: 9, margin: [10, 2, 0, 6], preserveLeadingSpaces: true });
        break;
      case 'table': {
        const rows = block.rows || [];
        if (rows.length > 0) {
          const colCount = Math.max(...rows.map((r) => r.length), 1);
          const widths = new Array(colCount).fill('*');
          const body = rows.map((row, rowIndex) =>
            widths.map((_: any, c: number) => {
              const cell = row[c] && row[c].length > 0 ? inlinesToPdf(row[c]) : { text: ' ' };
              return rowIndex === 0 ? { ...cell, bold: true, fillColor: '#f1f5f9' } : cell;
            })
          );
          content.push({ table: { headerRows: 1, widths, body }, layout: 'lightHorizontalLines', margin: [0, 4, 0, 8] });
        }
        break;
      }
      default:
        content.push({ ...inlinesToPdf(block.inlines), margin: [0, 2, 0, 4] });
    }

    if (block.children && block.children.length > 0) {
      content.push({ margin: [12, 0, 0, 0], stack: blocksToPdfContent(block.children) });
    }
    i++;
  }
  return content;
}

export async function generatePdf(data: ExportDocumentData): Promise<Uint8Array> {
  const mod: any = await import('pdfmake/build/pdfmake');
  const pdfMake = mod.default ?? mod;
  await ensureFonts(pdfMake);

  const content: any[] = [
    { text: data.title, fontSize: 20, bold: true, margin: [0, 0, 0, 2] },
    { text: data.dateText, fontSize: 9, color: '#64748b', margin: [0, 0, 0, 12] },
    ...blocksToPdfContent(data.blocks),
  ];

  if (data.transcripts && data.transcripts.length > 0) {
    content.push({
      text: data.labels.transcriptHeading,
      fontSize: 15,
      bold: true,
      margin: [0, 0, 0, 8],
      pageBreak: data.blocks.length > 0 ? 'before' : undefined,
    });
    for (const seg of data.transcripts) {
      const parts: any[] = [];
      if (seg.speaker) parts.push({ text: `${seg.speaker}: `, bold: true, color: '#334155' });
      parts.push({ text: seg.text });
      content.push({ text: parts, margin: [0, 1.5, 0, 1.5] });
    }
  }

  const docDefinition: TDocumentDefinitions = {
    content: content as Content[],
    defaultStyle: { font: 'NotoSansSC', fontSize: 10.5, lineHeight: 1.35 },
    pageMargins: [48, 48, 48, 56],
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#94a3b8',
    }),
    info: { title: data.title },
  };

  const pdf = pdfMake.createPdf(docDefinition);
  const blob: Blob = await pdf.getBlob();
  return new Uint8Array(await blob.arrayBuffer());
}
