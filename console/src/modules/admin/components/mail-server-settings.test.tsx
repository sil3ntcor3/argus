import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { MailServerSettingsDto } from '@/services/apis/gen/queries';
import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MailServerSettings from './mail-server-settings';

// jsdom has no ResizeObserver, which Radix measures form controls with, nor
// the pointer capture and scrolling Radix Select uses when it opens.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const { updateSettings, sendTestMail, toastError, toastSuccess, refetch } =
  vi.hoisted(() => ({
    updateSettings: vi.fn(),
    sendTestMail: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    refetch: vi.fn(),
  }));

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock('@/utils/authClient', () => ({
  useSession: () => ({ data: { user: { email: 'admin@example.com' } } }),
}));

vi.mock('@/services/apis/gen/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/apis/gen/queries')>()),
  useSystemConfigsControllerGetSettings: vi.fn(),
  useSystemConfigsControllerUpdateSettings: (options?: {
    mutation?: Record<string, unknown>;
  }) => ({
    mutate: (variables: unknown, callbacks?: Record<string, unknown>) =>
      updateSettings(variables, { ...options?.mutation, ...callbacks }),
    isPending: false,
  }),
  useSystemConfigsControllerSendTestMail: (options?: {
    mutation?: Record<string, unknown>;
  }) => ({
    mutate: (variables: unknown, callbacks?: Record<string, unknown>) =>
      sendTestMail(variables, { ...options?.mutation, ...callbacks }),
    isPending: false,
  }),
}));

const savedServer: MailServerSettingsDto = {
  enabled: true,
  provider: 'smtp',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  username: 'mailer',
  hasPassword: true,
  fromEmail: 'no-reply@example.com',
  fromName: '',
};

async function setup(mailServer: MailServerSettingsDto = savedServer) {
  const { useSystemConfigsControllerGetSettings } =
    await import('@/services/apis/gen/queries');
  vi.mocked(useSystemConfigsControllerGetSettings).mockReturnValue({
    data: { mailServer },
    isLoading: false,
  } as unknown as ReturnType<typeof useSystemConfigsControllerGetSettings>);
  return renderWithProviders(<MailServerSettings />);
}

describe('MailServerSettings', () => {
  beforeEach(() => {
    updateSettings.mockReset();
    sendTestMail.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
    refetch.mockReset();
  });

  it('shows the saved settings and keeps the password hidden', async () => {
    await setup();

    expect(await screen.findByLabelText('Host')).toHaveValue(
      'smtp.example.com',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'placeholder',
      'Saved; leave empty to keep it',
    );
  });

  it('fills a provider preset and saves without resending the password', async () => {
    const { user } = await setup();

    await user.click(await screen.findByRole('combobox', { name: 'Provider' }));
    await user.click(await screen.findByRole('option', { name: 'Resend' }));

    expect(screen.getByLabelText('Host')).toHaveValue('smtp.resend.com');
    expect(screen.getByLabelText('Port')).toHaveValue('465');
    expect(screen.getByLabelText('Username')).toHaveValue('resend');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        {
          data: {
            mailServer: expect.objectContaining({
              provider: 'resend',
              host: 'smtp.resend.com',
              port: 465,
              secure: true,
              username: 'resend',
              password: undefined,
            }) as unknown,
          },
        },
        expect.anything(),
      );
    });
  });

  it('will not turn the server on without a host and sender', async () => {
    const { user } = await setup({
      ...savedServer,
      enabled: false,
      host: '',
      fromEmail: '',
    });

    await user.click(
      await screen.findByRole('switch', { name: /Turn on mail server/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findAllByText('Required to turn on the mail server'),
    ).toHaveLength(2);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('sends a test email to the signed-in admin by default', async () => {
    const { user } = await setup();

    await user.click(
      await screen.findByRole('button', { name: /Send test email/ }),
    );

    expect(sendTestMail).toHaveBeenCalledWith(
      { data: { to: 'admin@example.com' } },
      expect.anything(),
    );
  });

  it('holds the test email back while the server is off', async () => {
    await setup({ ...savedServer, enabled: false });

    expect(
      await screen.findByRole('button', { name: /Send test email/ }),
    ).toBeDisabled();
  });
  it('keeps the form unavailable while settings are loading', async () => {
    const api = await import('@/services/apis/gen/queries');
    vi.mocked(api.useSystemConfigsControllerGetSettings).mockReturnValue({
      isLoading: true,
    } as ReturnType<typeof api.useSystemConfigsControllerGetSettings>);
    renderWithProviders(<MailServerSettings />);
    expect(
      await screen.findByRole('status', { name: 'Loading mail settings' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('offers retry instead of an editable default form after a load failure', async () => {
    const api = await import('@/services/apis/gen/queries');
    vi.mocked(api.useSystemConfigsControllerGetSettings).mockReturnValue({
      isLoading: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<
      typeof api.useSystemConfigsControllerGetSettings
    >);
    const { user } = renderWithProviders(<MailServerSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load mail settings',
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('blocks test mail until edits are saved or discarded', async () => {
    const { user } = await setup();
    await user.type(await screen.findByLabelText('Sender name'), 'Changed');
    expect(
      screen.getByRole('button', { name: /Send test email/ }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Sender name')).toHaveValue('');
    expect(
      screen.getByRole('button', { name: /Send test email/ }),
    ).toBeEnabled();
  });

  it('clears a new password after a successful save', async () => {
    updateSettings.mockImplementation((_variables, callbacks) =>
      callbacks.onSuccess(),
    );
    const { user } = await setup();
    await user.type(
      await screen.findByLabelText('Password'),
      'new-local-secret',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveValue(''),
    );
    expect(updateSettings).toHaveBeenCalledWith(
      {
        data: {
          mailServer: expect.objectContaining({ password: 'new-local-secret' }),
        },
      },
      expect.anything(),
    );
    expect(toastSuccess).toHaveBeenCalledWith('Mail server saved.');
  });

  it('retains unsaved values after a failed save', async () => {
    updateSettings.mockImplementation((_variables, callbacks) =>
      callbacks.onError(new Error('offline')),
    );
    const { user } = await setup();
    await user.type(await screen.findByLabelText('Sender name'), 'Unsaved');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Failed to save the mail server.',
      ),
    );
    expect(screen.getByLabelText('Sender name')).toHaveValue('Unsaved');
    expect(
      screen.getByRole('button', { name: /Send test email/ }),
    ).toBeDisabled();
  });

  it('keeps invalid test recipients from reaching the API', async () => {
    const { user } = await setup();
    const to = await screen.findByLabelText('Send to');
    await user.clear(to);
    await user.type(to, 'not-an-email');
    expect(
      screen.getByRole('button', { name: /Send test email/ }),
    ).toBeDisabled();
    expect(sendTestMail).not.toHaveBeenCalled();
  });
  it('preserves dirty fields while a refetch refreshes untouched settings', async () => {
    const api = await import('@/services/apis/gen/queries');
    const query = { data: { mailServer: savedServer }, isLoading: false };
    vi.mocked(api.useSystemConfigsControllerGetSettings).mockReturnValue(
      query as ReturnType<typeof api.useSystemConfigsControllerGetSettings>,
    );
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MailServerSettings />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Sender name'), 'Local edit');
    await user.type(screen.getByLabelText('Password'), 'local-secret');
    vi.mocked(api.useSystemConfigsControllerGetSettings).mockReturnValue({
      ...query,
      data: { mailServer: { ...savedServer, host: 'refreshed.example.com' } },
    } as ReturnType<typeof api.useSystemConfigsControllerGetSettings>);
    view.rerender(
      <QueryClientProvider client={client}>
        <MailServerSettings />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Host')).toHaveValue(
        'refreshed.example.com',
      ),
    );
    expect(screen.getByLabelText('Sender name')).toHaveValue('Local edit');
    expect(screen.getByLabelText('Password')).toHaveValue('local-secret');
    expect(
      screen.getByRole('button', { name: /Send test email/ }),
    ).toBeDisabled();
    client.clear();
  });
});
