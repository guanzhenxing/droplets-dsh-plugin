import test from 'node:test';
import assert from 'node:assert/strict';
import { openPdf } from '../src/client/pdf-view.js';

/**
 * pdf-view contracts the InboxView PdfPane relies on (fix F/B):
 * pageWidth() gives the scale-1 viewport width for fit-to-width math, and
 * renderPage() forwards the caller's scale into the canvas geometry.
 * jsdom/Node has no real 2d context, so the draw stage itself is expected
 * to throw; the geometry is assigned before it — that ordering is the contract.
 */

/** 最小合法 PDF（单页，MediaBox 200×100），xref 偏移按字节精确计算（全 ASCII）。 */
function buildMinimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

test('openPdf exposes the scale-1 page width for fit-to-width', async () => {
  const pdf = await openPdf(Buffer.from(buildMinimalPdf()).toString('base64'));
  try {
    assert.equal(pdf.numPages, 1, 'minimal pdf has one page');
    assert.equal(await pdf.pageWidth(1), 200, 'pageWidth = MediaBox width at scale 1');
  } finally {
    await pdf.destroy?.();
  }
});

test('renderPage applies the caller scale to the canvas geometry', async () => {
  const pdf = await openPdf(Buffer.from(buildMinimalPdf()).toString('base64'));
  try {
    const canvas = { width: 0, height: 0, getContext: () => null };
    try {
      await pdf.renderPage(1, canvas, 2);
    } catch { /* 无 2d context：draw 阶段抛错是预期；几何尺寸先于绘制设置 */ }
    assert.equal(canvas.width, 400, 'canvas width = 200pt × scale 2');
    assert.equal(canvas.height, 200, 'canvas height = 100pt × scale 2');
  } finally {
    await pdf.destroy?.();
  }
});
