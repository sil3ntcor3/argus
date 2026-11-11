import { DataKind, TargetType } from '@/common/enums/enum';
import {
  kindsToLoad,
  planStepInputs,
  webUrl,
  type ScopeAsset,
  type ScopeData,
} from './step-inputs';

const apex: ScopeAsset = {
  id: 'a-apex',
  value: 'example.com',
  isPrimary: true,
  targetType: TargetType.DOMAIN,
};
const app: ScopeAsset = {
  id: 'a-app',
  value: 'app.example.com',
  isPrimary: false,
  targetType: TargetType.DOMAIN,
};
const repo: ScopeAsset = {
  id: 'a-repo',
  value: 'github.com/acme/web',
  isPrimary: false,
  targetType: TargetType.GIT_ORG,
};

const services = [22, 8443, 80].map((port) => ({
  id: `s-${port}`,
  assetId: app.id,
  value: `${app.value}:${port}`,
  port,
}));
const foundUrl = (url: string) => ({
  url,
  assetId: app.id,
  serviceId: 's-8443',
});

/** app.example.com: SSH on 22, a web app on 8443 and plain HTTP on 80. */
const scope: ScopeData = {
  assets: [apex, app, repo],
  services: new Map([[app.id, services]]),
  web: new Map([
    [
      'a-app',
      [
        { ...services[1], scheme: 'https' },
        { ...services[2], scheme: 'http' },
      ],
    ],
  ]),
  urls: new Map([['a-app', [foundUrl('https://app.example.com:8443/login')]]]),
};

const targets = (kinds: DataKind[]) =>
  planStepInputs(kinds, scope).map(
    (p) => p.connectorInputs?.target ?? `repo:${p.assetId}`,
  );

describe('planStepInputs', () => {
  it('target: only the asset a target was created with', () => {
    expect(targets([DataKind.TARGET])).toEqual(['example.com']);
  });

  it('host: every host, never a repository', () => {
    expect(targets([DataKind.HOST])).toEqual([
      'example.com',
      'app.example.com',
    ]);
  });

  it('service: every open port, whatever it speaks', () => {
    const planned = planStepInputs([DataKind.SERVICE], scope);
    expect(planned.map((p) => p.serviceId)).toEqual(['s-22', 's-8443', 's-80']);
    expect(planned[0].connectorInputs).toEqual({
      target: 'app.example.com:22',
    });
    expect(planned[0].commandValues).toEqual({
      value: 'app.example.com:22',
      port: '22',
    });
  });

  it('web: one job per web service, its URL in target with the port kept', () => {
    const planned = planStepInputs([DataKind.WEB], scope);
    expect(planned.map((p) => [p.serviceId, p.connectorInputs])).toEqual([
      ['s-8443', { target: 'https://app.example.com:8443' }],
      ['s-80', { target: 'http://app.example.com' }],
    ]);
  });

  it('url: one job per discovered URL, on the service it was found on', () => {
    const planned = planStepInputs([DataKind.URL], scope);
    expect(planned).toEqual([
      expect.objectContaining({
        assetId: 'a-app',
        serviceId: 's-8443',
        connectorInputs: { target: 'https://app.example.com:8443/login' },
      }),
    ]);
  });

  it('keeps only HTTP(S) URLs on the scoped host, falling back when none qualify', () => {
    const urls = [
      'https://cdn.example.net/file',
      'ftp://app.example.com/file',
      'invalid',
    ];
    const isolated = {
      ...scope,
      assets: [app],
      urls: new Map([[app.id, urls.map(foundUrl)]]),
    };
    expect(
      planStepInputs([DataKind.URL, DataKind.HOST], isolated)[0]
        .connectorInputs,
    ).toEqual({ target: app.value });
    isolated.urls
      .get(app.id)!
      .push(foundUrl('https://APP.EXAMPLE.COM:8443/login'));
    expect(
      planStepInputs([DataKind.URL], isolated).map(
        (p) => p.connectorInputs?.target,
      ),
    ).toEqual(['https://APP.EXAMPLE.COM:8443/login']);
  });

  it('matches IPv6 URL hosts to their scoped asset', () => {
    const asset = { ...app, value: '2001:db8::1' };
    const urls = [foundUrl('https://[2001:db8::1]:8443/login')];
    expect(
      planStepInputs([DataKind.URL], {
        assets: [asset],
        urls: new Map([[asset.id, urls]]),
      })[0].connectorInputs,
    ).toEqual({ target: urls[0].url });
  });

  it('repository: the repositories, with inputs left to the claim (credentials)', () => {
    expect(planStepInputs([DataKind.REPOSITORY], scope)).toEqual([
      expect.objectContaining({ assetId: 'a-repo', connectorInputs: null }),
    ]);
  });

  it('takes, per asset, the first kind that has something', () => {
    // app has web services: its URLs. The apex was never probed: the host.
    expect(targets([DataKind.WEB, DataKind.HOST])).toEqual([
      'example.com',
      'https://app.example.com:8443',
      'http://app.example.com',
    ]);
  });

  it('plans nothing when no asset has the kind (the step is skipped)', () => {
    expect(planStepInputs([DataKind.WEB], { assets: [apex] })).toEqual([]);
  });

  it('never takes vulnerabilities as input', () => {
    expect(planStepInputs([DataKind.VULNERABILITY], scope)).toEqual([]);
  });
});

describe('webUrl', () => {
  it('brackets bare IPv6 hosts without duplicating existing brackets', () => {
    expect(webUrl('2001:db8::1', 'https', 8443)).toBe(
      'https://[2001:db8::1]:8443',
    );
    expect(webUrl('[2001:db8::1]', 'https', 443)).toBe('https://[2001:db8::1]');
  });
  it('drops the default port of the scheme', () => {
    expect(webUrl('h', 'https', 443)).toBe('https://h');
    expect(webUrl('h', 'http', 80)).toBe('http://h');
    expect(webUrl('h', 'http', 443)).toBe('http://h:443');
  });
});

describe('kindsToLoad', () => {
  it('loads services, web services and URLs only when asked for', () => {
    expect(kindsToLoad([DataKind.HOST])).toEqual({
      services: false,
      web: false,
      urls: false,
    });
    expect(kindsToLoad([DataKind.WEB, DataKind.URL])).toEqual({
      services: false,
      web: true,
      urls: true,
    });
  });
});
