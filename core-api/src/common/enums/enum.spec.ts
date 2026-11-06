import { DataKind, ToolCategory } from './enum';

describe('ToolCategory — url_discovery contract', () => {
  it('exposes URL_DISCOVERY === "url_discovery"', () => {
    expect(ToolCategory.URL_DISCOVERY).toBe('url_discovery');
  });
});

describe('workflow data kinds', () => {
  it('defines the ordered input/output vocabulary independently of tool categories', () => {
    expect(DataKind).toEqual({
      TARGET: 'target',
      HOST: 'host',
      SERVICE: 'service',
      WEB: 'web',
      URL: 'url',
      REPOSITORY: 'repository',
      VULNERABILITY: 'vulnerability',
    });
  });
});
