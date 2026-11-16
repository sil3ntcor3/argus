vi.mock('@/pages/agents/components/project-scope-select', () => ({ ProjectScopeSelect: () => null }));
vi.mock('@/pages/agents/components/worker-select', () => ({ WorkerSelect: () => null }));
import { act, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatConversation } from './chat-conversation';

vi.mock('@/components/agent-prompt-input', () => ({ default: () => null }));
vi.mock('./chat-message', () => ({
  ChatMessage: ({ message }: { message: UIMessage }) => <div>{message.id}</div>,
}));
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: { children: ReactNode }) => (
    <div role="log">
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  ),
  ConversationContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="content">{children}</div>
  ),
  ConversationScrollButton: () => null,
  ConversationEmptyState: () => null,
}));

const message = (id: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: id }],
});

describe('ChatConversation history scroll position', () => {
  let height: number;
  let notify: IntersectionObserverCallback;
  let root: IntersectionObserverInit['root'];

  beforeEach(() => {
    height = 1000;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === 'scroller' ? height : 0;
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(
          callback: IntersectionObserverCallback,
          options: IntersectionObserverInit,
        ) {
          notify = callback;
          root = options.root;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('anchors a prepend on the actual inline-style scroller using its latest height', () => {
    const load = vi.fn();
    const ui = (messages: UIMessage[]) => (
      <ChatConversation
        messages={messages}
        onSendMessage={vi.fn()}
        onLoadMore={load}
        hasMoreMessages
      />
    );
    const { rerender } = render(ui([message('newer')]));
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 200;
    height = 1300; // The existing messages reflowed after their initial render.
    act(() =>
      notify(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(load).toHaveBeenCalledOnce();
    height = 1800;
    rerender(ui([message('older'), message('newer')]));
    expect(scroller.scrollTop).toBe(700);
    expect(root).toBe(scroller);
  });

  it('keeps a reader in place when a new message is appended', () => {
    const ui = (messages: UIMessage[]) => (
      <ChatConversation messages={messages} onSendMessage={vi.fn()} />
    );
    const { rerender } = render(ui([message('first')]));
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 200;
    height = 1500;
    rerender(ui([message('first'), message('last')]));
    expect(scroller.scrollTop).toBe(200);
  });
});
