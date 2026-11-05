import { decrypt } from '@/common/utils/encryption.util';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
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
  /** Send a branded test message; transport details stay out of HTTP errors. */
  async sendTest(to: string): Promise<DefaultMessageResponseDto> {
    const { name } = await this.systemConfigsService.getConfig();
    try {
      await this.send({
        to,
        subject: `Test email from ${name}`,
        text: `Your mail server is set up correctly. ${name} can send email.`,
      });
    } catch {
      throw new BadRequestException(
        'Test email failed. Check the mail server settings.',
      );
    }
    return { message: 'Test email sent' };
  }
}
