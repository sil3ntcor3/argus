import { fireEvent, render, screen } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import { describe, expect, it } from 'vitest';
import { CollapsibleDataTable } from './collapsible-data-table';

const columns: ColumnDef<{ port: number }>[] = [
  { accessorKey: 'port', header: 'Port' },
];

describe('CollapsibleDataTable', () => {
  it('groups trigger and detail rows in valid table bodies', () => {
    const { container } = render(
      <CollapsibleDataTable
        columns={columns}
        data={[{ port: 443 }, { port: 8443 }]}
        page={1}
        pageSize={10}
        collapsibleElement={(row) => <p>Services on port {row.port}</p>}
      />,
    );

    const bodies = Array.from(container.querySelectorAll('table > tbody'));
    expect(bodies).toHaveLength(2);
    expect(
      bodies.every((body) =>
        Array.from(body.children).every((child) => child.tagName === 'TR'),
      ),
    ).toBe(true);

    const first = screen.getByRole('row', { name: '443' });
    const second = screen.getByRole('row', { name: '8443' });
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(bodies[0]).toContainElement(
      screen.getByText('Services on port 443'),
    );
    fireEvent.click(second);
    expect(bodies[1]).toContainElement(
      screen.getByText('Services on port 8443'),
    );
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
  });
});
