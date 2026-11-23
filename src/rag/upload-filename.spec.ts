import { decodeUploadFilename } from './upload-filename';

describe('uploaded filenames', () => {
  it.each(['使用说明.pdf', '知识库 📝.txt', 'résumé.pdf'])('recovers UTF-8 multipart bytes for %s', (name) => {
    const parsedName = Buffer.from(name, 'utf8').toString('latin1');
    expect(decodeUploadFilename(parsedName)).toBe(name);
  });

  it.each(['manual.pdf', '使用说明.pdf', '知识库 📝.txt', 'résumé.pdf', ''])('preserves an already correct filename %s', (name) => {
    expect(decodeUploadFilename(name)).toBe(name);
  });
});
