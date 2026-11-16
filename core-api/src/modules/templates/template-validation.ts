import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { load } from 'js-yaml';

export const MAX_TEMPLATE_BYTES = 256 * 1024;
export const TEMPLATE_NAME_ERROR = 'Template name must be 1-200 characters and end in .yaml or .yml';
// The existing parser is untyped; parsed documents remain untrusted at this boundary.
const loadYaml = load as (source: string) => unknown;

/** Shared boundary for content writes, legacy imports and dispatch reads. */
export function validateTemplate(name?: string, content?: string): void {
  if (name !== undefined && (!name || name.length > 200 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !/\.ya?ml$/i.test(name))) {
    throw new BadRequestException(TEMPLATE_NAME_ERROR);
  }
  if (content === undefined) return;
  if (Buffer.byteLength(content, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw new PayloadTooLargeException('Template exceeds 256 KB');
  }
  let document: unknown;
  try {
    document = loadYaml(content);
  } catch (error: unknown) {
    const detail = error as { mark?: { line?: number }; reason?: string };
    const line = detail.mark?.line;
    throw new BadRequestException(
      `Invalid YAML${line === undefined ? '' : ` at line ${line + 1}`}: ${detail.reason ?? 'parse error'}`,
    );
  }
  const id = (document as { id?: unknown } | null)?.id;
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      typeof id !== 'string' || !id.trim()) {
    throw new BadRequestException('Template must be a YAML mapping with a nonblank string "id"');
  }
}
