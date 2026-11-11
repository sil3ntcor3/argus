import * as fs from 'fs';
import * as path from 'path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { mergeBetterAuthSpec, normalizeSchemaType } from './mergeBetterAuth';

jest.mock('fs', () => ({ existsSync: jest.fn(), readFileSync: jest.fn() }));

describe('normalizeSchemaType', () => {
  it('converts array-form type ["object","null"] to type + nullable', () => {
    expect(
      normalizeSchemaType({
        type: ['object', 'null'],
        properties: { name: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      nullable: true,
      properties: { name: { type: 'string' } },
    });
  });

  it('converts ["string","null"] to string + nullable', () => {
    expect(normalizeSchemaType({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('leaves a single-string type untouched', () => {
    const schema = { type: 'object', properties: {} };
    expect(normalizeSchemaType(schema)).toEqual(schema);
  });

  it('normalizes nested schemas recursively', () => {
    expect(
      normalizeSchemaType({
        schema: { type: ['object', 'null'] },
        items: { type: ['array', 'null'], items: { type: 'string' } },
      }),
    ).toEqual({
      schema: { type: 'object', nullable: true },
      items: { type: 'array', nullable: true, items: { type: 'string' } },
    });
  });

  it('leaves non-schema values untouched', () => {
    expect(normalizeSchemaType(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeSchemaType('string')).toBe('string');
  });

  it('strips JSON Schema 3.1 keywords that OpenAPI 3.0 rejects (propertyNames)', () => {
    expect(
      normalizeSchemaType({
        type: 'object',
        propertyNames: { type: 'string' },
        properties: {
          data: { type: 'object', propertyNames: { maxLength: 3 } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: { data: { type: 'object' } },
    });
  });
});

describe('mergeBetterAuthSpec resource loading', () => {
  const packaged = path.resolve(
    __dirname,
    '..',
    '..',
    'resources/openapi/better-auth.json',
  );
  const checkout = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '.open-api/better-auth.json',
  );
  const authFragment = {
    tags: [{ name: 'Default' }],
    paths: {
      '/api/auth/sign-in/email': {
        post: {
          tags: ['Default'],
          responses: { '200': { description: 'Signed in' } },
        },
      },
    },
    components: { schemas: { AuthUser: { type: ['object', 'null'] } } },
  };
  const document = (): OpenAPIObject => ({
    openapi: '3.0.0',
    info: { title: 'Argus', version: '1.0' },
    paths: {
      '/api/health': {
        get: { responses: { '200': { description: 'Healthy' } } },
      },
    },
  });

  beforeEach(() => {
    jest.mocked(fs.existsSync).mockReset();
    jest.mocked(fs.readFileSync).mockReset();
    jest.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(authFragment));
  });

  it('loads packaged auth documentation without a checkout and retains existing API paths', () => {
    jest
      .mocked(fs.existsSync)
      .mockImplementation((file) => String(file) === packaged);
    const merged = mergeBetterAuthSpec(document());
    expect(merged.paths['/api/auth/sign-in/email']?.post?.tags).toEqual([
      'Authentication',
    ]);
    expect(merged.paths['/api/health']?.get?.responses['200']).toEqual({
      description: 'Healthy',
    });
    expect(merged.components?.schemas?.AuthUser).toEqual({
      type: 'object',
      nullable: true,
    });
    expect(fs.readFileSync).toHaveBeenCalledWith(packaged, 'utf-8');
  });

  it('prefers the image resource when a checkout fragment is also present', () => {
    jest
      .mocked(fs.existsSync)
      .mockImplementation((file) =>
        [packaged, checkout].includes(String(file)),
      );
    mergeBetterAuthSpec(document());
    expect(fs.readFileSync).toHaveBeenCalledWith(packaged, 'utf-8');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('retains the tracked checkout fragment as the local-development fallback', () => {
    jest
      .mocked(fs.existsSync)
      .mockImplementation((file) => String(file) === checkout);
    expect(
      mergeBetterAuthSpec(document()).paths['/api/auth/sign-in/email'],
    ).toBeDefined();
    expect(fs.readFileSync).toHaveBeenCalledWith(checkout, 'utf-8');
  });

  it('keeps the document unchanged when neither fragment exists', () => {
    jest.mocked(fs.existsSync).mockReturnValue(false);
    const original = document();
    expect(mergeBetterAuthSpec(original)).toBe(original);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('does not hide malformed packaged JSON by falling back to a checkout', () => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest
      .mocked(fs.readFileSync)
      .mockImplementation((file) =>
        String(file) === packaged
          ? '{ malformed'
          : JSON.stringify(authFragment),
      );
    expect(() => mergeBetterAuthSpec(document())).toThrow(SyntaxError);
  });
});
