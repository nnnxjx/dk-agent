import { TextDecoder } from 'node:util';

/** Recover browser UTF-8 filenames decoded as Latin-1 by the multipart parser. */
export function decodeUploadFilename(filename: string): string {
  // Already-decoded Unicode must not be truncated by Buffer's Latin-1 encoder.
  if (/[^\u0000-\u00ff]/u.test(filename)) return filename;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.from(filename, 'latin1'));
  } catch {
    // A genuine Latin-1 filename is not necessarily valid UTF-8.
    return filename;
  }
}
