import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenIn,
  OpenInContent,
  OpenInTrigger,
  OpenInChatGPT,
  OpenInClaude,
  OpenInT3,
  OpenInScira,
  OpenInv0,
  OpenInCursor,
} from '@/components/ai-elements/open-in-chat';
import { Source } from '@/components/ai-elements/sources';
import { TechnologyTooltip } from '@/pages/assets/components/technology-tooltip';
import type { TechnologyDetailDTO } from '@/services/apis/gen/queries';
import { GithubBadge } from './github-badge';
import { OpenLinkDialog } from './open-link';

vi.mock('@/services/apis/gen/queries', () => ({
  useRootControllerGetMetadata: () => ({
    data: { gitRepoUrl: 'https://github.com/sil3ntcor3/argus' },
  }),
}));
beforeEach(() => {
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  const cancel = screen.queryByRole('button', { name: 'Cancel' });
  if (cancel) fireEvent.click(cancel);
  cleanup();
  vi.restoreAllMocks();
});
const destination = 'https://example.com/argus/source?ref=review#L2';

describe('remaining external link surfaces', () => {
  it.each([
    [OpenInChatGPT, 'ChatGPT'],
    [OpenInClaude, 'Claude'],
    [OpenInT3, 'T3'],
    [OpenInScira, 'Scira'],
    [OpenInv0, 'v0'],
    [OpenInCursor, 'Cursor'],
  ] as const)(
    'confirms chat provider %# before navigation',
    async (Chat, provider) => {
      const user = userEvent.setup();
      render(
        <>
          <OpenIn query="Argus & review? #é">
            <OpenInTrigger />
            <OpenInContent>
              <Chat />
            </OpenInContent>
          </OpenIn>
          <OpenLinkDialog />
        </>,
      );
      await user.click(screen.getByRole('button', { name: /Open in chat/ }));
      const item = screen.getByRole('menuitem', {
        name: new RegExp('Open in ' + provider),
      });
      const href = item.getAttribute('href')!;
      expect(decodeURIComponent(href.replaceAll('+', ' '))).toContain(
        'Argus & review? #é',
      );
      await user.click(item);
      expect(
        screen.getByRole('dialog', { name: 'Open external link?' }),
      ).toBeVisible();
      expect(screen.getByText(href, { exact: true })).toBeVisible();
      expect(window.open).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /^Open$/ }));
      expect(window.open).toHaveBeenCalledExactlyOnceWith(
        href,
        '_blank',
        'noopener,noreferrer',
      );
    },
  );

  it('restores the menu trigger when its selected link unmounts', async () => {
    const user = userEvent.setup();
    render(
      <>
        <OpenIn query="Argus">
          <OpenInTrigger />
          <OpenInContent>
            <OpenInChatGPT />
          </OpenInContent>
        </OpenIn>
        <OpenLinkDialog />
      </>,
    );
    const trigger = screen.getByRole('button', { name: /Open in chat/ });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: /Open in ChatGPT/ }));
    expect(screen.getByRole('dialog')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('confirms source citations and respects cancel', () => {
    render(
      <>
        <Source href={destination} title="Argus source" />
        <OpenLinkDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Argus source' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText(destination, { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.open).not.toHaveBeenCalled();
  });

  it('confirms technology links without activating their asset row', () => {
    const onRowClick = vi.fn();
    const tech = {
      name: 'Argus technology',
      website: destination,
    } as TechnologyDetailDTO;
    render(
      <>
        <div onClick={onRowClick}>
          <TechnologyTooltip tech={tech} />
        </div>
        <OpenLinkDialog />
      </>,
    );
    fireEvent.click(screen.getByText('Argus technology'));
    expect(window.open).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      destination,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('keeps the Argus repository destination in the GitHub badge', () => {
    render(
      <>
        <GithubBadge />
        <OpenLinkDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'GitHub' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(
      screen.getByText('https://github.com/sil3ntcor3/argus', { exact: true }),
    ).toBeVisible();
  });
});
