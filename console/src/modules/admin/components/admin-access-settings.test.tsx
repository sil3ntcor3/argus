import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { server } from '@/test/mocks/node';
import AdminAccessSettings from './admin-access-settings';
import { onlineManager } from '@tanstack/react-query';
import { act } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
const path = '/api/admin/system-configs/settings';
let ips: string[], updates: unknown[];
beforeEach(() => {
  ips = ['203.0.113.7'];
  updates = [];
  server.use(
    http.get(path, () =>
      HttpResponse.json({ adminAccess: { allowedIps: ips } }),
    ),
    http.patch(path, async ({ request }) => {
      const body = (await request.json()) as {
        adminAccess: { allowedIps: string[] };
      };
      updates.push(body);
      ips = body.adminAccess.allowedIps;
      return HttpResponse.json({ message: 'Saved' });
    }),
  );
});

describe('AdminAccessSettings', () => {
  it('rejects offline saves without replaying them after reconnect', async () => {
    let attempts = 0;
    server.use(
      http.patch(path, () => {
        attempts++;
        return HttpResponse.error();
      }),
    );
    const { user, unmount, queryClient } = renderWithProviders(
      <AdminAccessSettings />,
    );
    const input = await screen.findByLabelText('Allowed IP addresses');
    try {
      onlineManager.setOnline(false);
      await user.clear(input);
      await user.click(
        screen.getByRole('button', { name: 'Save admin access' }),
      );
      await waitFor(() => expect(attempts).toBe(1));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Failed to save admin access.',
      );
      await act(async () => {
        onlineManager.setOnline(true);
      });
      expect(attempts).toBe(1);
    } finally {
      unmount();
      queryClient.clear();
      onlineManager.setOnline(true);
    }
  });

  it('shows saved rules and requires an edit before saving', async () => {
    renderWithProviders(<AdminAccessSettings />);
    expect(await screen.findByLabelText('Allowed IP addresses')).toHaveValue(
      '203.0.113.7',
    );
    expect(
      screen.getByRole('button', { name: 'Save admin access' }),
    ).toBeDisabled();
  });

  it('saves only normalized address settings and refreshes the saved list', async () => {
    const { user } = renderWithProviders(<AdminAccessSettings />);
    const input = await screen.findByLabelText('Allowed IP addresses');
    await user.clear(input);
    await user.type(input, ' 203.0.113.7, 10.0.0.0/8{enter}{enter}203.0.113.7');
    await user.click(screen.getByRole('button', { name: 'Save admin access' }));
    await waitFor(() => expect(input).toHaveValue('203.0.113.7\n10.0.0.0/8'));
    expect(updates).toEqual([
      { adminAccess: { allowedIps: ['203.0.113.7', '10.0.0.0/8'] } },
    ]);
    expect(
      screen.getByRole('button', { name: 'Save admin access' }),
    ).toBeDisabled();
  });

  it('saves an explicit empty list when clearing restrictions', async () => {
    const { user } = renderWithProviders(<AdminAccessSettings />);
    await user.clear(await screen.findByLabelText('Allowed IP addresses'));
    await user.click(screen.getByRole('button', { name: 'Save admin access' }));
    await waitFor(() =>
      expect(updates).toEqual([{ adminAccess: { allowedIps: [] } }]),
    );
  });

  it('retains the draft and displays a self-lockout rejection', async () => {
    server.use(
      http.patch(path, () =>
        HttpResponse.json(
          {
            message: 'The allowed IP list must include your current IP address',
          },
          { status: 400 },
        ),
      ),
    );
    const { user } = renderWithProviders(<AdminAccessSettings />);
    const input = await screen.findByLabelText('Allowed IP addresses');
    await user.clear(input);
    await user.type(input, '198.51.100.7');
    await user.click(screen.getByRole('button', { name: 'Save admin access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'must include your current IP',
    );
    expect(input).toHaveValue('198.51.100.7');
  });

  it('offers retry instead of editing an empty default after a load failure', async () => {
    server.use(http.get(path, () => HttpResponse.json({}, { status: 403 })));
    const { user } = renderWithProviders(<AdminAccessSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load admin access',
    );
    expect(
      screen.queryByLabelText('Allowed IP addresses'),
    ).not.toBeInTheDocument();
    server.use(
      http.get(path, () =>
        HttpResponse.json({ adminAccess: { allowedIps: ips } }),
      ),
    );
    await user.click(
      screen.getByRole('button', { name: 'Retry admin access' }),
    );
    expect(await screen.findByLabelText('Allowed IP addresses')).toHaveValue(
      '203.0.113.7',
    );
  });

  it('disables editing throughout a save and refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.patch(path, async () => {
        await gate;
        ips = [];
        return HttpResponse.json({});
      }),
    );
    const { user } = renderWithProviders(<AdminAccessSettings />);
    const input = await screen.findByLabelText('Allowed IP addresses');
    try {
      await user.clear(input);
      await user.click(
        screen.getByRole('button', { name: 'Save admin access' }),
      );
      await waitFor(() => expect(input).toBeDisabled());
      expect(
        screen.getByRole('button', { name: 'Save admin access' }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await waitFor(() => expect(input).toBeEnabled());
  });

  it.each([
    [['Invalid IP address'], 'Invalid IP address'],
    [{ internal: 'hidden' }, 'Failed to save admin access.'],
  ])('shows only recognized server errors %j', async (message, expected) => {
    server.use(
      http.patch(path, () => HttpResponse.json({ message }, { status: 400 })),
    );
    const { user } = renderWithProviders(<AdminAccessSettings />);
    await user.clear(await screen.findByLabelText('Allowed IP addresses'));
    await user.click(screen.getByRole('button', { name: 'Save admin access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      expected as string,
    );
  });

  it('does not expose an editable empty policy while initially loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(path, async () => {
        await gate;
        return HttpResponse.json({ adminAccess: { allowedIps: ips } });
      }),
    );
    renderWithProviders(<AdminAccessSettings />);
    try {
      expect(
        await screen.findByRole('status', { name: 'Loading admin access' }),
      ).toBeVisible();
      expect(
        screen.queryByLabelText('Allowed IP addresses'),
      ).not.toBeInTheDocument();
    } finally {
      release();
    }
    await screen.findByLabelText('Allowed IP addresses');
  });
});
