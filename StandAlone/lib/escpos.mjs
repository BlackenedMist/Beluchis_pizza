export const ALIGN = { LEFT: 0, CENTER: 1, RIGHT: 2 };

function alignByte(align) {
  if (align === 'center') return ALIGN.CENTER;
  if (align === 'right') return ALIGN.RIGHT;
  return ALIGN.LEFT;
}

export function buildEscpos(segments) {
  const parts = [Buffer.from('\x1b\x40')];
  for (const seg of segments) {
    const line = [];
    line.push('\x1b\x61');
    line.push(String.fromCharCode(alignByte(seg.align)));
    line.push('\x1b\x45');
    line.push(seg.bold ? '\x01' : '\x00');
    const size = seg.size === 2 ? '\x11' : '\x00';
    line.push('\x1d\x21');
    line.push(size);
    line.push(seg.text || '');
    line.push('\n');
    parts.push(Buffer.from(line.join(''), 'utf8'));
  }
  parts.push(Buffer.from('\x1b\x64\x05'));
  parts.push(Buffer.from('\x1d\x56\x42\x00'));
  return Buffer.concat(parts);
}

export function testPage() {
  return buildEscpos([
    { text: 'BELUCHIS KITCHEN', align: 'center', bold: true, size: 2 },
    { text: 'Printer test OK', align: 'center' },
    { text: String(new Date().toLocaleString()), align: 'center' },
    { text: 'If you can read this line,', align: 'center' },
    { text: 'everything is working.', align: 'center' }
  ]);
}