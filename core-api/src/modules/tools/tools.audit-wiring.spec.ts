import { Reflector } from '@nestjs/core';
import {
  PUBLISH_EVENT_KEY,
  type PublishEventConfig,
} from '../event-bridge/publishing/publish-event.decorator';
import { ToolsController } from './tools.controller';

describe('ToolsController audit wiring', () => {
  const reflector = new Reflector();
  const config = (method: keyof ToolsController) =>
    reflector.get<PublishEventConfig & { event: { name: string } }>(
      PUBLISH_EVENT_KEY,
      ToolsController.prototype[method],
    );

  it.each([
    ['installTool', 'tool.installed'],
    ['uninstallTool', 'tool.uninstalled'],
  ] as const)('%s publishes %s', (method, action) => {
    expect(config(method)?.event.name).toBe(action);
  });

  it('takes installed tool identity from the service result, not the request', () => {
    const audit = config('installTool');
    const result = { tool: { id: 'tool-1', name: 'nuclei' } };
    expect(audit?.resourceId?.(result)).toBe('tool-1');
    expect(audit?.changes?.({ toolName: 'untrusted' }, result)).toEqual({
      tool: { after: 'nuclei' },
    });
    expect(audit?.resourceId?.(undefined)).toBeUndefined();
    expect(audit?.changes?.({}, undefined)).toEqual({ tool: { after: '' } });
  });

  it('keeps removed tool identity available after the association is deleted', () => {
    const audit = config('uninstallTool');
    const result = { toolId: 'tool-1', toolName: 'nuclei' };
    expect(audit?.resourceId?.(result)).toBe('tool-1');
    expect(audit?.changes?.({}, result)).toEqual({
      tool: { before: 'nuclei' },
    });
    expect(audit?.resourceId?.(undefined)).toBeUndefined();
    expect(audit?.changes?.({}, undefined)).toEqual({ tool: { before: '' } });
  });

  it.each(['getManyTools', 'getInstalledTools', 'getToolById'] as const)(
    'does not turn %s reads into audit writes',
    (method) => expect(config(method)).toBeUndefined(),
  );
});
