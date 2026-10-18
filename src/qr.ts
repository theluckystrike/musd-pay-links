import qrcode from "qrcode-generator";

/** Render a payment link as a standalone SVG QR code. Error correction M, as most wallet scanners expect. */
export function qrSvg(text: string, cellSize = 6): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 4, scalable: true });
}
