import { joinPdfTextItems } from './pdf-text.mjs';

/** Text-only extraction never executes document HTML or follows embedded links. */
export async function extractDocument(file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (file.size > 20 * 1024 * 1024) throw new Error('文字文档不能超过 20 MB');
  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  if (extension === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/workers/pdf.worker.min.mjs';
    const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, useSystemFonts: true }).promise;
    try {
      if (document.numPages > 300) throw new Error('PDF 不能超过 300 页');
      const pages: string[] = [];
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        pages.push(joinPdfTextItems(content.items.filter(item => 'str' in item)));
      }
      const text = pages.join('\n\n');
      if (!text.trim()) throw new Error('该 PDF 未包含可提取文字；请先对扫描件进行 OCR');
      return text;
    } finally { await document.destroy(); }
  }
  if (['txt', 'md', 'srt', 'vtt', 'csv'].includes(extension || '')) return file.text();
  throw new Error('请选择 TXT、Markdown、SRT、VTT、DOCX 或文字型 PDF');
}
