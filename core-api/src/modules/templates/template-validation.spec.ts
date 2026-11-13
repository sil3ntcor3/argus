import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MAX_TEMPLATE_BYTES, validateTemplate } from './template-validation';

describe('custom template validation', () => {
  it.each(['check.yaml', 'check.yml', 'Check.YAML', 'Unicode-検証.yaml'])(
    'accepts a YAML display name and mapping: %s', name => {
      expect(() => validateTemplate(name, 'id: argus-local-check\ninfo:\n  name: Local check')).not.toThrow();
    },
  );

  it.each(['', 'check.txt', 'check.yaml.exe', 'x'.repeat(196) + '.yaml'])(
    'rejects a missing, non-YAML or oversized display name', name => {
      expect(() => validateTemplate(name, 'id: check')).toThrow(BadRequestException);
    },
  );

  it.each(['', 'null', '42', '- id: check', 'id: 42', 'id: ""', 'id: "  "', 'info: {}'])(
    'requires a mapping with a nonblank string id: %s', content => {
      expect(() => validateTemplate('check.yaml', content)).toThrow(BadRequestException);
    },
  );

  it.each(['id: [', 'id: check\nid: other', 'id: check\n---\nid: other', 'id: !!js/function function() {}'])(
    'rejects malformed, duplicate, multiple-document or executable-tag YAML', content => {
      expect(() => validateTemplate(undefined, content)).toThrow(BadRequestException);
    },
  );

  it('enforces the UTF-8 byte limit before parsing YAML', () => {
    const prefix = 'id: check\n#';
    const boundary = prefix + 'x'.repeat(MAX_TEMPLATE_BYTES - Buffer.byteLength(prefix));
    expect(() => validateTemplate(undefined, boundary)).not.toThrow();
    expect(() => validateTemplate(undefined, boundary + 'x')).toThrow(PayloadTooLargeException);
    expect(() => validateTemplate(undefined, 'id: "' + '界'.repeat(MAX_TEMPLATE_BYTES / 3) + '"'))
      .toThrow(PayloadTooLargeException);
  });

  it('supports name-only and content-only validation without changing content', () => {
    expect(() => validateTemplate('check.yaml')).not.toThrow();
    expect(() => validateTemplate(undefined, 'id: check\r\n')).not.toThrow();
  });
});
