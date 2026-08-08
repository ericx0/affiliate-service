import QRCode from "qrcode";

/**
 * Render a URL as a PNG buffer (512px, 2-module quiet zone) for
 * the KOL referral-code QR download endpoint. Kept as a 1-line
 * wrapper so the option contract is testable in isolation and the
 * controller stays free of dependency imports.
 */
export function generateQrPngBuffer(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", width: 512, margin: 2 });
}