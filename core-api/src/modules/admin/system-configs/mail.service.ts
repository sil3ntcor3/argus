import { decrypt } from '@/common/utils/encryption.util';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { AUTH_INSTANCE_KEY } from '@/common/constants/app.constants';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import type { Auth } from 'better-auth';
import { createTransport } from 'nodemailer';
import { SystemConfigsService } from './system-configs.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );

/** Internal SMTP delivery using the latest administrator-saved settings. */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly systemConfigsService: SystemConfigsService,
    @Inject(AUTH_INSTANCE_KEY) private readonly auth: Auth,
  ) {}

  onModuleInit(): void {
    const { emailVerification } = this.auth.options;
    if (!emailVerification) return;
    emailVerification.sendVerificationEmail = ({ user, url }, request) =>
      request ? this.sendVerificationEmail(user, url) : Promise.resolve();
  }

  /** Account creation survives delivery failure; the user can request a new link. */
  private async sendVerificationEmail(
    user: { name: string; email: string },
    url: string,
  ): Promise<void> {
    try {
      const { name } = await this.systemConfigsService.getConfig();
      const instructions =
        'The link expires in 24 hours. Once you confirm, an administrator approves your account before you can sign in.';
      await this.send({
        to: user.email,
        subject: `Verify your email for ${name}`,
        text: [
          `Hi ${user.name},`,
          '',
          `Confirm your email address to finish signing up for ${name}:`,
          url,
          '',
          instructions,
          '',
          "If you didn't sign up, you can ignore this email.",
        ].join('\n'),
        html: [
          `<p>Hi ${escapeHtml(user.name)},</p>`,
          `<p>Confirm your email address to finish signing up for ${escapeHtml(name)}:</p>`,
          `<p><a href="${escapeHtml(url)}">Verify email</a></p>`,
          `<p>${instructions}</p>`,
          "<p>If you didn't sign up, you can ignore this email.</p>",
        ].join('\n'),
      });
    } catch {
      this.logger.error(
        'Failed to send verification email. Check the mail server settings.',
      );
    }
  }

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
