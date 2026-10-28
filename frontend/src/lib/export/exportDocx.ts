// DOCX export via the `docx` package (loaded on demand).
import { ExportBlock, ExportDocumentData, ExportInline, plainText } from './blockUtils';

export async function generateDocx(data: ExportDocumentData): Promise<Uint8Array> {
  const docx: any = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, ExternalHyperlink, PageBreak,
  } = docx;

  const runsFrom = (inlines: ExportInline[]): any[] =>
    inlines.map((inline) => {
      if (inline.link) {
        return new ExternalHyperlink({
          children: [new TextRun({ text: inline.text, style: 'Hyperlink' })],
          link: inline.link,
        });
      }
      return new TextRun({
        text: inline.text,
        bold: inline.bold,
        italics: inline.italic,
        underline: inline.underline ? {} : undefined,
        strike: inline.strike,
      });
    });

  const HEADINGS: Record<number, any> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  };

  const body: any[] = [];

  const pushBlocks = (blocks: ExportBlock[], indent: number) => {
    let numberCounter = 0;
    for (const block of blocks) {
      if (block.kind !== 'number') numberCounter = 0;
      switch (block.kind) {
        case 'heading':
          body.push(new Paragraph({
            children: runsFrom(block.inlines),
            heading: HEADINGS[block.level || 1] || HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 80 },
          }));
          break;
        case 'bullet':
          body.push(new Paragraph({
            children: runsFrom(block.inlines),
            bullet: { level: Math.min(indent, 2) },
            spacing: { after: 40 },
          }));
          break;
        case 'number':
          numberCounter += 1;
          body.push(new Paragraph({
            children: [new TextRun({ text: `${numberCounter}. ` }), ...runsFrom(block.inlines)],
            indent: { left: 360 + indent * 360 },
            spacing: { after: 40 },
          }));
          break;
        case 'check':
          body.push(new Paragraph({
            children: [new TextRun({ text: block.checked ? '\u2611 ' : '\u2610 ' }), ...runsFrom(block.inlines)],
            indent: { left: 360 + indent * 360 },
            spacing: { after: 40 },
          }));
          break;
        case 'quote':
          body.push(new Paragraph({
            children: block.inlines.map((inl) => new TextRun({ text: inl.text, italics: true, color: '555555' })),
            indent: { left: 360 },
            spacing: { after: 60 },
          }));
          break;
        case 'code':
          body.push(new Paragraph({
            children: [new TextRun({ text: plainText(block.inlines), font: 'Courier New', size: 18 })],
            indent: { left: 360 },
            spacing: { after: 60 },
          }));
          break;
        case 'table': {
          const rows = block.rows || [];
          if (rows.length > 0) {
            const colCount = Math.max(...rows.map((r) => r.length), 1);
            body.push(new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: rows.map((row, rowIdx) => new TableRow({
                children: Array.from({ length: colCount }, (_, c) => new TableCell({
                  children: [new Paragraph({
                    children: row[c]
                      ? (rowIdx === 0
                        ? row[c].map((inl) => new TextRun({ text: inl.text, bold: true }))
                        : runsFrom(row[c]))
                      : [],
                  })],
                })),
              })),
            }));
            body.push(new Paragraph({ children: [] }));
          }
          break;
        }
        default:
          body.push(new Paragraph({
            children: runsFrom(block.inlines),
            indent: indent > 0 ? { left: indent * 360 } : undefined,
            spacing: { after: 60 },
          }));
      }
      if (block.children && block.children.length > 0) {
        pushBlocks(block.children, indent + 1);
      }
    }
  };

  const header: any[] = [
    new Paragraph({
      children: [new TextRun({ text: data.title, bold: true, size: 44 })],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [new TextRun({ text: data.dateText, color: '64748B', size: 18 })],
      spacing: { after: 240 },
    }),
  ];

  pushBlocks(data.blocks, 0);

  if (data.transcripts && data.transcripts.length > 0) {
    if (data.blocks.length > 0) {
      body.push(new Paragraph({ children: [new PageBreak()] }));
    }
    body.push(new Paragraph({
      children: [new TextRun({ text: data.labels.transcriptHeading, bold: true, size: 30 })],
      spacing: { before: 120, after: 120 },
    }));
    for (const seg of data.transcripts) {
      const runs: any[] = [];
      if (seg.speaker) runs.push(new TextRun({ text: `${seg.speaker}: `, bold: true }));
      runs.push(new TextRun({ text: seg.text }));
      body.push(new Paragraph({ children: runs, spacing: { after: 60 } }));
    }
  }

  const doc = new Document({
    creator: '知会',
    title: data.title,
    sections: [{ children: [...header, ...body] }],
  });

  const blob: Blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
