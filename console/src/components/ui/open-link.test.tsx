import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '@/components/common/markdown';
import AssetValue from '@/pages/assets/components/asset-value';
import { CodeLocation } from '@/pages/vulnerabilities/components/code-location';
import type {
  HttpResponseDTO,
  Vulnerability,
} from '@/services/apis/gen/queries';
import { OpenLink, OpenLinkDialog } from './open-link';

const destination = 'https://example.com/source?review=argus#L8';
const surfaces = [
  {
    name: 'Markdown',
    link: 'Review source',
    element: <Markdown content={'[Review source](' + destination + ')'} />,
  },
  {
    name: 'asset URLs',
    link: 'example.com',
    element: (
      <AssetValue
        value="example.com"
        httpResponse={{ url: destination } as HttpResponseDTO}
      />
    ),
  },
  {
    name: 'code locations',
    link: 'Open in repository',
    element: (
      <CodeLocation
        labelClassName=""
        vulnerability={
          {
            filePath: 'src/app.ts',
            asset: { metadata: { url: 'https://example.com/repo' } },
          } as unknown as Vulnerability
        }
      />
    ),
  },
];

beforeEach(() => {
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  const cancel = screen.queryByRole('button', { name: 'Cancel' });
  if (cancel) fireEvent.click(cancel);
  cleanup();
  vi.restoreAllMocks();
});

describe('external link entry points', () => {
  it.each(surfaces)('requires confirmation for $name', ({ element, link }) => {
    render(
      <>
        {element}
        <OpenLinkDialog />
      </>,
    );
    const anchor = screen.getByRole('link', { name: link });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(
      screen.getByRole('dialog', { name: 'Open external link?' }),
    ).toBeVisible();
    expect(
      screen.getByText(anchor.getAttribute('href')!, { exact: true }),
    ).toBeVisible();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('keeps asset clicks from triggering their parent row', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <AssetValue
          value="example.com"
          httpResponse={{ url: destination } as HttpResponseDTO}
        />
        <OpenLinkDialog />
      </div>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
  });
});

describe('OpenLink', () => {
  const renderLink = (href = destination) =>
    render(
      <>
        <OpenLink href={href}>Review source</OpenLink>
        <OpenLinkDialog />
      </>,
    );

  it('opens exactly the displayed URL only after confirmation', () => {
    renderLink();
    fireEvent.click(screen.getByRole('link'));
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      destination,
      '_blank',
      'noopener,noreferrer',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancels without opening a new window', () => {
    renderLink();
    fireEvent.click(screen.getByRole('link'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('supports keyboard activation and Escape cancellation', async () => {
    const user = userEvent.setup();
    renderLink();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveFocus();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('survives the link owner unmounting during a click', () => {
    function TemporaryLink() {
      const [visible, setVisible] = useState(true);
      return visible ? (
        <OpenLink href={destination} onClick={() => setVisible(false)}>
          Ephemeral link
        </OpenLink>
      ) : null;
    }
    render(
      <>
        <TemporaryLink />
        <OpenLinkDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      destination,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])('preserves native clicks with %j', (options) => {
    renderLink();
    expect(fireEvent.click(screen.getByRole('link'), options)).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([
    '/workspaces',
    '#details',
    'mailto:review@example.com',
    'tel:+15555550123',
    'cursor://file/source',
    'blob:https://example.com/download',
  ])('preserves the native URL %s', (href) => {
    renderLink(href);
    expect(fireEvent.click(screen.getByRole('link'))).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    'http://example.com/path',
    '//example.com/path',
    'HTTPS://EXAMPLE.COM/path',
  ])('confirms the HTTP URL %s', (href) => {
    renderLink(href);
    fireEvent.click(screen.getByRole('link'));
    expect(screen.getByText(href, { exact: true })).toBeVisible();
  });

  it('respects a consumer that prevents navigation', () => {
    render(
      <>
        <OpenLink
          href={destination}
          onClick={(event) => event.preventDefault()}
        >
          Review source
        </OpenLink>
        <OpenLinkDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

});
