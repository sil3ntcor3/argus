import type { StorageService } from '@/modules/storage/storage.service';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MAX_TEMPLATE_BYTES, validateTemplate } from './template-validation';

export async function readTemplateContent(storage: StorageService, bucket: string, key: string): Promise<string> {
  if ((await storage.headObject(bucket, key)).contentLength > MAX_TEMPLATE_BYTES) throw new PayloadTooLargeException('Template exceeds 256 KB');
  const { file } = await storage.getFile(key, bucket);
  const stream = file.getStream();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > MAX_TEMPLATE_BYTES) throw new PayloadTooLargeException('Template exceeds 256 KB');
      chunks.push(buffer);
    }
  } finally { stream.destroy(); }
  let content: string;
  // Preserve a valid UTF-8 BOM: legacy imports promise byte-for-byte copies.
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { throw new BadRequestException('Template content is not valid UTF-8'); }
  validateTemplate(undefined, content);
  return content;
}
