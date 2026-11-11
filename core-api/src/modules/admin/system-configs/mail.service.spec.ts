import { BadRequestException, Logger } from '@nestjs/common';
import type { Auth } from 'better-auth';
import { encrypt } from '@/common/utils/encryption.util';
import { createTransport } from 'nodemailer';
import { MailProvider } from './dto/system-configs.dto';
import { MailService } from './mail.service';
import type {
  MailServerConfig,
  SystemConfigsService,
} from './system-configs.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

type VerificationSender = (
  data: { user: { id: string; name: string; email: string }; url: string },
  request?: Request,
) => Promise<void>;

const server = (
  overrides: Partial<MailServerConfig> = {},
): MailServerConfig => ({
  enabled: true,
  provider: MailProvider.SMTP,
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'argus',
  password: encrypt('smtp-secret'),
  fromEmail: 'argus@example.com',
  fromName: '',
  ...overrides,
});
const message = {
  to: 'recipient@example.com',
  subject: 'Argus test',
  text: 'Hello',
};

describe('MailService', () => {
  let service: MailService;
  let getMailServer: jest.Mock;
  let getConfig: jest.Mock;
  let sendMail: jest.Mock;
  let close: jest.Mock;
  let emailVerification: { sendVerificationEmail?: VerificationSender };

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    close = jest.fn();
    (createTransport as jest.Mock)
      .mockReset()
      .mockReturnValue({ sendMail, close });
    getMailServer = jest.fn().mockResolvedValue(server());
    getConfig = jest.fn().mockResolvedValue({ name: 'Argus' });
    emailVerification = {};
    service = new MailService(
      {
        getMailServer,
        getConfig,
      } as unknown as SystemConfigsService,
      { options: { emailVerification } } as unknown as Auth,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('verification email', () => {
    const user = {
      id: 'user-1',
      name: 'Ada <b> & "team"',
      email: 'ada@example.com',
    };
    const url =
      'https://argus.example.test/api/auth/verify-email?token=private&callbackURL=%2Flogin';
    const send = () => {
      service.onModuleInit();
      return emailVerification.sendVerificationEmail as VerificationSender;
    };

    it.each(['Argus', 'Acme <Security>'])(
      'uses saved %s branding and escapes HTML while retaining the plain link',
      async (name) => {
        getConfig.mockResolvedValue({ name });
        await send()({ user, url }, new Request('https://argus.example.test'));
        expect(sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: user.email,
            subject: 'Verify your email for ' + name,
            text: expect.stringContaining(url),
            html: expect.stringContaining(
              'Ada &lt;b&gt; &amp; &quot;team&quot;',
            ),
          }),
        );
        const sent = sendMail.mock.calls[0][0] as {
          text: string;
          html: string;
        };
        expect(sent.html).toContain('token=private&amp;callbackURL=');
        expect(sent.html).not.toContain('<Security>');
        expect(sent.text).toContain('24 hours');
        expect(sent.text).toContain('administrator approves');
        expect(close).toHaveBeenCalledTimes(1);
      },
    );

    it('never mails server-side first-admin bootstrap', async () => {
      await send()({ user, url });
      expect(getMailServer).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('keeps the account recoverable without logging SMTP credentials or verification tokens', async () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      sendMail.mockRejectedValue(new Error('smtp-secret ' + url));
      await expect(
        send()({ user, url }, new Request('https://argus.example.test')),
      ).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        'Failed to send verification email. Check the mail server settings.',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('smtp-secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain('token=private');
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the saved SMTP fields and decrypts the credential only for transport', async () => {
    const stored = server();
    getMailServer.mockResolvedValue(stored);
    await service.send(message);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'argus', pass: 'smtp-secret' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    expect(sendMail).toHaveBeenCalledWith({
      ...message,
      from: { name: 'Argus', address: 'argus@example.com' },
    });
    expect(stored.password).not.toBe('smtp-secret');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit sender name and passes optional HTML', async () => {
    getMailServer.mockResolvedValue(server({ fromName: 'Security team' }));
    await service.send({ ...message, html: '<p>Hello</p>' });
    expect(sendMail).toHaveBeenCalledWith({
      ...message,
      html: '<p>Hello</p>',
      from: { name: 'Security team', address: 'argus@example.com' },
    });
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('omits authentication when no username is configured', async () => {
    getMailServer.mockResolvedValue(
      server({ username: '', password: 'unreadable' }),
    );
    await service.send(message);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });

  it('allows a username with no saved password', async () => {
    getMailServer.mockResolvedValue(server({ password: undefined }));
    await service.send(message);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'argus', pass: '' } }),
    );
  });

  it('does not connect when delivery is disabled', async () => {
    getMailServer.mockResolvedValue(server({ enabled: false }));
    await expect(service.send(message)).rejects.toThrow(
      'The mail server is turned off',
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('fails before connecting when the saved credential cannot be decrypted', async () => {
    getMailServer.mockResolvedValue(server({ password: 'unreadable' }));
    await expect(service.send(message)).rejects.toThrow('Not an encrypted value');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('rereads settings so changes apply to the next message', async () => {
    getMailServer
      .mockResolvedValueOnce(server())
      .mockResolvedValueOnce(
        server({ host: 'changed.example.com', enabled: false }),
      );
    await service.send(message);
    await expect(service.send(message)).rejects.toThrow(
      'The mail server is turned off',
    );
    expect(getMailServer).toHaveBeenCalledTimes(2);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('closes the transport and propagates a delivery failure', async () => {
    sendMail.mockRejectedValue(new Error('SMTP refused delivery'));
    await expect(service.send(message)).rejects.toThrow(
      'SMTP refused delivery',
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the transport when resolving the system sender fails', async () => {
    getConfig.mockRejectedValue(new Error('Configuration unavailable'));
    await expect(service.send(message)).rejects.toThrow(
      'Configuration unavailable',
    );
    expect(sendMail).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  describe('sendTest', () => {
    it.each(['Argus', 'Acme Security'])(
      'brands the test message with %s',
      async (name) => {
        getConfig.mockResolvedValue({ name });
        await expect(service.sendTest('admin@example.com')).resolves.toEqual({
          message: 'Test email sent',
        });
        expect(sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'admin@example.com',
            subject: 'Test email from ' + name,
            text:
              'Your mail server is set up correctly. ' +
              name +
              ' can send email.',
          }),
        );
      },
    );

    it('returns a safe 400 when the mail server is disabled', async () => {
      getMailServer.mockResolvedValue(server({ enabled: false }));
      await expect(
        service.sendTest('admin@example.com'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it.each([new Error('535 rejected smtp-secret'), 'smtp-secret'])(
      'keeps SMTP failure details private (%p)',
      async (error) => {
        sendMail.mockRejectedValue(error);
        const failure = await service
          .sendTest('admin@example.com')
          .catch((value: unknown) => value);
        expect(failure).toBeInstanceOf(BadRequestException);
        expect((failure as BadRequestException).getStatus()).toBe(400);
        expect((failure as BadRequestException).getResponse()).toMatchObject({
          message: 'Test email failed. Check the mail server settings.',
        });
        expect(
          JSON.stringify((failure as BadRequestException).getResponse()),
        ).not.toContain('smtp-secret');
        expect(close).toHaveBeenCalledTimes(1);
      },
    );
  });
});
