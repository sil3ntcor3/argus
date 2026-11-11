import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileIcon } from './file-icon';

describe('FileIcon', () => {
  it.each([
    ['Summary.PDF', 'text/plain', 'file-text', 'text-red-600'],
    ['findings.CSV', 'text/plain', 'file-spreadsheet', 'text-emerald-600'],
    ['inventory.JSON', 'text/plain', 'file-braces', 'text-sky-600'],
    ['source.ts', 'text/plain', 'file-code', 'text-indigo-500'],
    [
      'bundle.tgz',
      'application/octet-stream',
      'file-archive',
      'text-amber-600',
    ],
    ['capture', 'image/png', 'file-image', 'text-rose-500'],
    ['recording', 'video/webm', 'file-video-camera', 'text-violet-500'],
    ['audio', 'audio/ogg', 'file-music', 'text-pink-500'],
    ['README', 'text/plain', 'file-text', 'text-blue-500'],
    [
      'unknown.constructor',
      'application/octet-stream',
      'file',
      'text-muted-foreground',
    ],
  ])('renders a decorative icon for %s', (name, mimeType, shape, color) => {
    const { container } = render(<FileIcon name={name} mimeType={mimeType} />);
    const icon = container.querySelector(`svg.lucide-${shape}`);
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveClass(color);
  });
});
