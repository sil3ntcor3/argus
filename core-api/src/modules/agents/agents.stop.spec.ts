import { Logger, NotFoundException } from '@nestjs/common';
import { AgentsCompletionsService } from './agents.completions';
import { AgentsController } from './agents.controller';

jest.mock('better-auth/node', () => ({ fromNodeHeaders: jest.fn() }));

describe('conversation stop', () => {
  function build(cancelled = 0) {
    const cancelForConversation = jest.fn().mockResolvedValue(cancelled);
    const resetTodosOnError = jest.fn().mockResolvedValue(undefined);
    const service = Object.assign(
      Object.create(AgentsCompletionsService.prototype) as AgentsCompletionsService,
      { activeRuns: new Map(), subagents: { cancelForConversation }, resetTodosOnError, logger: new Logger('test') },
    );
    return { service, cancelForConversation, resetTodosOnError };
  }

  it('cancels remaining subagents after the main run ended', async () => {
    const { service, cancelForConversation } = build(2);
    expect(await service.stopRun('c1')).toBe(true);
    expect(cancelForConversation).toHaveBeenCalledWith('c1');
  });

  it('aborts the main run before cancelling children and retains its running state until saved', async () => {
    const { service, cancelForConversation, resetTodosOnError } = build();
    const controller = new AbortController();
    service.registerActiveRun('c1', controller);
    cancelForConversation.mockImplementation(() => {
      expect(controller.signal.aborted).toBe(true);
      return Promise.resolve(1);
    });
    expect(await service.stopRun('c1')).toBe(true);
    expect(cancelForConversation).toHaveBeenCalledTimes(1);
    expect(resetTodosOnError).toHaveBeenCalledWith('c1');
    expect(service.isRunActive('c1')).toBe(true);
    service.clearActiveRun('c1', controller);
    expect(service.isRunActive('c1')).toBe(false);
  });

  it('returns no work only after checking children too', async () => {
    const { service, cancelForConversation, resetTodosOnError } = build();
    expect(await service.stopRun('c1')).toBe(false);
    expect(cancelForConversation).toHaveBeenCalledWith('c1');
    expect(resetTodosOnError).not.toHaveBeenCalled();
  });

  it('awaits cancellation before reporting whether a stop happened', async () => {
    const getConversation = jest.fn().mockResolvedValue({ id: 'c1' });
    const stopRun = jest.fn().mockResolvedValue(false);
    const controller = Object.assign(Object.create(AgentsController.prototype) as AgentsController, {
      agentsService: { getConversation }, agentsCompletionsService: { stopRun },
    });
    expect(await controller.stopConversation('c1', 'w1', 'u1')).toEqual({ message: 'No active response' });
    expect(getConversation).toHaveBeenCalledWith('c1', 'w1', 'u1');
    expect(stopRun).toHaveBeenCalledWith('c1');
    getConversation.mockRejectedValueOnce(new NotFoundException());
    await expect(controller.stopConversation('other', 'w1', 'u1')).rejects.toThrow(NotFoundException);
    expect(stopRun).toHaveBeenCalledTimes(1);
  });
});
