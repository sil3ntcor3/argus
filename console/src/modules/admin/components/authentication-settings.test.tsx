import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { server } from '@/test/mocks/node';
import {
  getRootControllerGetMetadataQueryKey,
  getSystemConfigsControllerGetSettingsQueryKey,
} from '@/services/apis/gen/queries';
import AuthenticationSettings from './authentication-settings';

const { success, error } = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success, error } }));
let saved = {
  auth: { allowSignUp: false },
  mailServer: { enabled: false, host: 'mailpit' },
};
let updates: unknown[];
const path = '/api/admin/system-configs/settings';

beforeEach(() => {
  saved = {
    auth: { allowSignUp: false },
    mailServer: { enabled: false, host: 'mailpit' },
  };
  updates = [];
  success.mockReset();
  error.mockReset();
  server.use(
    http.get(path, () => HttpResponse.json(saved)),
    http.patch(path, async ({ request }) => {
      const body = (await request.json()) as { auth: { allowSignUp: boolean } };
      updates.push(body);
      saved = { ...saved, auth: body.auth };
      return HttpResponse.json(saved);
    }),
  );
});

/** Exercise the generated HTTP hooks and the controlled saved-setting state. */
describe('AuthenticationSettings', () => {
  it.each([false, true])(
    'shows saved allowSignUp=%s and saves only its opposite',
    async (initial) => {
      saved.auth.allowSignUp = initial;
      const { user, queryClient } = renderWithProviders(
        <AuthenticationSettings />,
      );
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const control = await screen.findByRole('switch', {
        name: 'Allow public sign-up',
      });
      expect(control).toHaveAttribute('aria-checked', String(initial));
      await user.click(control);
      await waitFor(() =>
        expect(control).toHaveAttribute('aria-checked', String(!initial)),
      );
      expect(updates).toEqual([{ auth: { allowSignUp: !initial } }]);
      expect(saved.mailServer).toEqual({ enabled: false, host: 'mailpit' });
      expect(success).toHaveBeenCalledWith('Sign-up preference saved.');
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getSystemConfigsControllerGetSettingsQueryKey(),
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getRootControllerGetMetadataQueryKey(),
      });
    },
  );

  it('links to mail settings while verification mail is disabled', async () => {
    renderWithProviders(<AuthenticationSettings />);
    expect(
      await screen.findByRole('link', { name: 'mail server' }),
    ).toHaveAttribute('href', '/admin/mail-server');
  });

  it('omits the mail warning once the server is enabled', async () => {
    saved.mailServer.enabled = true;
    renderWithProviders(<AuthenticationSettings />);
    await screen.findByRole('switch');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a loading state before exposing the saved preference', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(path, async () => {
        await gate;
        return HttpResponse.json(saved);
      }),
    );
    renderWithProviders(<AuthenticationSettings />);
    try {
      expect(
        await screen.findByRole('status', {
          name: 'Loading authentication settings',
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    } finally {
      release();
    }
    await screen.findByRole('switch');
  });

  it('offers retry after a load failure without editing default settings', async () => {
    let calls = 0;
    server.use(
      http.get(path, () =>
        ++calls === 1
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json(saved),
      ),
    );
    const { user } = renderWithProviders(<AuthenticationSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load authentication settings',
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch')).not.toBeChecked();
    expect(updates).toEqual([]);
  });

  it('keeps a missing settings response unavailable', async () => {
    server.use(http.get(path, () => HttpResponse.json(null)));
    renderWithProviders(<AuthenticationSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load authentication settings',
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('disables the switch while its save is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.patch(path, async () => {
        await gate;
        saved.auth.allowSignUp = true;
        return HttpResponse.json(saved);
      }),
    );
    const { user } = renderWithProviders(<AuthenticationSettings />);
    const control = await screen.findByRole('switch');
    try {
      await user.click(control);
      await waitFor(() => expect(control).toBeDisabled());
    } finally {
      release();
    }
    await waitFor(() => expect(control).toBeEnabled());
    await waitFor(() => expect(control).toBeChecked());
  });

  it('refreshes saved settings even if the panel unmounts during a save', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.patch(path, async () => {
        await gate;
        return HttpResponse.json(saved);
      }),
    );
    const { user, queryClient, unmount } = renderWithProviders(
      <AuthenticationSettings />,
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const control = await screen.findByRole('switch');
    try {
      await user.click(control);
      await waitFor(() => expect(control).toBeDisabled());
      unmount();
    } finally {
      release();
    }
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getSystemConfigsControllerGetSettingsQueryKey(),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getRootControllerGetMetadataQueryKey(),
    });
  });

  it('retains the saved value and shows safe feedback after a failed save', async () => {
    server.use(
      http.patch(path, () =>
        HttpResponse.json(
          { message: { private: 'internal detail' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = renderWithProviders(<AuthenticationSettings />);
    const control = await screen.findByRole('switch');
    await user.click(control);
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'Failed to save authentication settings.',
      ),
    );
    expect(control).not.toBeChecked();
    expect(control).toBeEnabled();
    expect(success).not.toHaveBeenCalled();
  });
});
