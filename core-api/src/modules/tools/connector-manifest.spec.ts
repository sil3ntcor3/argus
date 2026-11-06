import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const manifest = {
  generatedAt: '2026-11-05T00:00:00.000Z',
  connectors: [
    {
      slug: 'nuclei',
      image: 'registry.example/argus-nuclei:fixed',
      version: 'fixed',
      capabilities: [
        {
          name: 'vulnerabilities',
          targetTypes: ['domain'],
          inputsSchema: { type: 'object' },
        },
      ],
    },
  ],
};
const defaults: unknown = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../resources/connectors/io-defaults.json'),
    'utf8',
  ),
);

describe('connector manifest generation', () => {
  const directories: string[] = [];

  /** Exercises the real generator offline, with all writes confined to a fixture. */
  const generate = (input: unknown, io: unknown = defaults, prior?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'argus-manifest-io-'));
    directories.push(root);
    mkdirSync(join(root, 'scripts'));
    const resources = join(root, 'core-api/resources/connectors');
    mkdirSync(resources, { recursive: true });
    copyFileSync(
      resolve(__dirname, '../../../../scripts/sync-tool-manifest.mjs'),
      join(root, 'scripts/sync-tool-manifest.mjs'),
    );
    writeFileSync(join(resources, 'io-defaults.json'), JSON.stringify(io));
    const inputFile = join(root, 'input.json');
    writeFileSync(inputFile, JSON.stringify(input));
    const outputFile = join(resources, 'manifest.json');
    if (prior !== undefined) writeFileSync(outputFile, prior);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/sync-tool-manifest.mjs')],
      {
        env: { ...process.env, MANIFEST_PATH: inputFile },
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    const bytes = existsSync(outputFile)
      ? readFileSync(outputFile, 'utf8')
      : undefined;
    return {
      ...result,
      bytes,
      data:
        result.status === 0
          ? (JSON.parse(bytes!) as typeof manifest)
          : undefined,
    };
  };

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('fills missing I/O while preserving canonical images, versions and all other metadata', () => {
    const result = generate(manifest);
    expect(result.status).toBe(0);
    expect(result.data?.connectors[0].capabilities[0]).toMatchObject({
      inputs: ['host', 'web'],
      produces: ['vulnerability'],
    });
    const restored = JSON.parse(result.bytes!) as typeof manifest;
    const capability = restored.connectors[0].capabilities[0] as Record<
      string,
      unknown
    >;
    delete capability.inputs;
    delete capability.produces;
    expect(restored).toEqual(manifest);
  });

  it('keeps canonical declarations, including an explicit empty produced list', () => {
    const input = {
      ...manifest,
      connectors: [
        {
          ...manifest.connectors[0],
          capabilities: [
            {
              ...manifest.connectors[0].capabilities[0],
              inputs: ['url'],
              produces: [],
            },
          ],
        },
      ],
    };
    expect(generate(input).data).toEqual(input);
  });

  it('leaves custom connectors without upstream defaults untouched', () => {
    const input = {
      ...manifest,
      connectors: [{ ...manifest.connectors[0], slug: 'argus-custom' }],
    };
    expect(generate(input).data).toEqual(input);
  });

  it('rejects invalid defaults before replacing an existing generated manifest', () => {
    const prior = '{"prior":true}\n';
    const invalid = {
      connectors: {
        nuclei: { vulnerabilities: { inputs: ['host'], produces: ['target'] } },
      },
    };
    const result = generate(manifest, invalid, prior);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid connector I/O defaults');
    expect(result.bytes).toBe(prior);
  });
});
