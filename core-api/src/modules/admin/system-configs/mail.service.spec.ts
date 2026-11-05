import { encrypt } from '@/common/utils/encryption.util';
import { createTransport } from 'nodemailer';
import { MailProvider } from './dto/system-configs.dto';
import { MailService } from './mail.service';
import type {
  MailServerConfig,
  SystemConfigsService,
} from './system-configs.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

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

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({});
    close = jest.fn();
    (createTransport as jest.Mock)
      .mockReset()
      .mockReturnValue({ sendMail, close });
    getMailServer = jest.fn().mockResolvedValue(server());
    getConfig = jest.fn().mockResolvedValue({ name: 'Argus' });
    service = new MailService({
      getMailServer,
      getConfig,
    } as unknown as SystemConfigsService);
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
});
