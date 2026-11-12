import {
  PresignUploadRequestDto,
  PresignUploadResponseDto,
} from '@/modules/storage/dto/presign-storage.dto';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  ValidateBy,
} from 'class-validator';
import { isIpOrCidr } from '@/common/utils/ip-range.util';

/** Source addresses allowed to use platform administration routes. */
export class AdminAccessSettingsDto {
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: 100,
    description:
      'IPs or CIDR ranges. Empty permits every IP; a nonempty list must include the requester.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ValidateBy(
    {
      name: 'isIpOrCidr',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isIpOrCidr(value.trim()),
        defaultMessage: () =>
          'allowedIps must contain only IP addresses or CIDR ranges',
      },
    },
    { each: true },
  )
  allowedIps?: string[] | null;
}

/**
 * Response DTO for system configuration
 */
export class SystemConfigResponseDto {
  @ApiProperty({ description: 'System name' })
  name: string;

  @ApiProperty({ description: 'Path to system logo', nullable: true })
  logoPath?: string | null;
}

/**
 * DTO for updating system configuration
 */
export class UpdateSystemConfigDto {
  @ApiPropertyOptional({ description: 'System name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Path to system logo' })
  @IsOptional()
  @IsString()
  logoPath?: string | null;
}

/** Account settings (`settings.auth`) */
export class AuthSettingsDto {
  @ApiPropertyOptional({
    nullable: true,
    type: Boolean,
    description:
      'Stored sign-up preference. Public registration remains closed until verification and approval are available.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowSignUp?: boolean | null;
}

/**
 * Mail service presets. Every one is sent over SMTP; the provider only tells
 * the console which host, port and username to fill in.
 */
export enum MailProvider {
  SMTP = 'smtp',
  RESEND = 'resend',
  SENDGRID = 'sendgrid',
  POSTMARK = 'postmark',
  MAILGUN = 'mailgun',
  SES = 'ses',
  BREVO = 'brevo',
  GMAIL = 'gmail',
}

/** Outgoing mail server (`settings.mailServer`), used for verification emails */
export class MailServerSettingsDto {
  @ApiPropertyOptional({ nullable: true, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'string',
    enum: MailProvider,
    enumName: 'MailProvider',
    default: MailProvider.SMTP,
  })
  @IsOptional()
  @IsEnum(MailProvider)
  provider?: MailProvider | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'smtp.example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    example: 587,
    default: 587,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Boolean,
    description: 'Implicit TLS, usually port 465; off means STARTTLS',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  secure?: boolean | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    writeOnly: true,
    description:
      'Write-only password or API key, stored encrypted. Leave out or empty to keep the saved one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string | null;

  @ApiPropertyOptional({
    description: 'Read-only: whether a password is saved',
    readOnly: true,
  })
  hasPassword?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'no-reply@example.com',
  })
  @ValidateIf(
    (_dto: MailServerSettingsDto, value: unknown) =>
      value !== undefined && value !== null && value !== '',
  )
  @IsEmail()
  fromEmail?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Defaults to the system name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  fromName?: string | null;
}

/**
 * Feature settings, one optional nested DTO per section. Adding a section
 * needs validation here, defaults and the response allowlist in
 * SystemConfigsService; no migration is needed.
 */
export class SystemSettingsDto {
  @ApiPropertyOptional({ nullable: true, type: () => AdminAccessSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminAccessSettingsDto)
  adminAccess?: AdminAccessSettingsDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => AuthSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AuthSettingsDto)
  auth?: AuthSettingsDto | null;

  @ApiPropertyOptional({ nullable: true, type: () => MailServerSettingsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MailServerSettingsDto)
  mailServer?: MailServerSettingsDto | null;
}

/** Recipient of a test message using the saved mail configuration. */
export class SendTestMailDto {
  @ApiProperty({ example: 'admin@example.com', format: 'email' })
  @IsEmail()
  to: string;
}

export class LogoPresignRequestDto extends OmitType(PresignUploadRequestDto, [
  'bucket',
] as const) {}

export class LogoPresignResponseDto extends OmitType(PresignUploadResponseDto, [
  'contentType',
] as const) {}

export class ConfirmLogoRequestDto {
  @ApiProperty({
    example: 'logo-1a2b3c.png',
    description: 'Object key returned by the logo presign endpoint',
  })
  @IsString()
  @IsNotEmpty()
  key: string;
}
