import { decrypt } from '@/common/utils/encryption.util';
import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { SystemConfigsService } from './system-configs.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Internal SMTP delivery using the latest administrator-saved settings. */
@Injectable()
export class MailService {
  constructor(private readonly systemConfigsService: SystemConfigsService) {}

  /** Decrypt credentials for one send; disabled settings never open a connection. */
  async send(message: MailMessage): Promise<void> {
    const server = await this.systemConfigsService.getMailServer();
    if (!server.enabled) throw new Error('The mail server is turned off');

    const transport = createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: server.username
        ? {
            user: server.username,
            pass: server.password ? decrypt(server.password) : '',
          }
        : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      const name =
        server.fromName || (await this.systemConfigsService.getConfig()).name;
      await transport.sendMail({
        ...message,
        from: { name, address: server.fromEmail },
      });
    } finally {
      transport.close();
    }
  }
}
