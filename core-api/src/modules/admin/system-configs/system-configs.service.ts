import { GITHUB_REPO } from '@/common/constants/app.constants';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { ReleaseVersion } from '@/common/interfaces/app.interface';
import { RedisService } from '@/services/redis/redis.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { encrypt } from '@/common/utils/encryption.util';
import { isIpInRanges, isIpOrCidr } from '@/common/utils/ip-range.util';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository, type FindOneOptions } from 'typeorm';
import { StorageService } from '@/modules/storage/storage.service';
import {
  MailProvider,
  SystemSettingsDto,
  SystemConfigResponseDto,
  UpdateSystemConfigDto,
} from './dto/system-configs.dto';
import {
  SystemConfig,
  type SystemSettings,
} from './entities/system-config.entity';

/** Stored SMTP settings; the password remains encrypted until a send. */
export interface MailServerConfig {
  enabled: boolean;
  provider: MailProvider;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string;
  fromEmail: string;
  fromName: string;
}

/**
 * Service for managing system configuration
 * Implements singleton pattern - only one config record exists
 */
@Injectable()
export class SystemConfigsService implements OnModuleInit {
  private static readonly DEFAULT_SYSTEM_NAME = 'Argus';
  private static readonly DEFAULT_SETTINGS: SystemSettings = {
    adminAccess: { allowedIps: [] },
    auth: { allowSignUp: false },
    mailServer: {
      enabled: false,
      provider: MailProvider.SMTP,
      host: '',
      port: 587,
      secure: false,
      username: '',
      fromEmail: '',
      fromName: '',
    },
  };
  private readonly logger = new Logger(SystemConfigsService.name);

  constructor(
    @InjectRepository(SystemConfig)
    private readonly systemConfigRepository: Repository<SystemConfig>,
    private storageService: StorageService,
    private redisService: RedisService,
  ) {}

  async onModuleInit() {
    await this.checkUpdate();
  }

  /**
   * Get the system configuration
   * Creates default config if none exists
   * @returns System configuration response
   */
  async getConfig(): Promise<SystemConfigResponseDto> {
    const config = await this.findOrCreateConfig();

    if (!config.logoPath) {
      return { name: config.name, logoPath: null };
    }

    const url = await this.storageService.signStoragePath(config.logoPath);
    return { name: config.name, logoPath: url };
  }

  /**
   * Raw stored logo path (`system/<file>`) for internal consumers that need
   * the real bucket/key (e.g. deleting the previous logo object). Never
   * returns the client URL that `getConfig()` emits.
   */
  async getRawLogoPath(): Promise<string | null> {
    const config = await this.findOrCreateConfig();
    return config.logoPath ?? null;
  }

  /**
   * Update the system configuration
   * Creates default config if none exists before updating
   * @param dto Update data
   * @returns Success message
   */
  async updateConfig(
    dto: UpdateSystemConfigDto,
  ): Promise<DefaultMessageResponseDto> {
    const config = await this.findOrCreateConfig();
    config.name = dto.name || SystemConfigsService.DEFAULT_SYSTEM_NAME;

    // Handle logoPath update: allow null to clear the logo, and string values to update it
    if (dto.logoPath !== undefined) {
      config.logoPath = dto.logoPath; // Can be string or null
    }

    await this.systemConfigRepository.save(config);

    return { message: 'System configuration updated successfully' };
  }

  /**
   * Remove the system logo and revert to default avatar
   * Creates default config if none exists before updating
   * @returns Success message
   */
  async removeLogo(): Promise<DefaultMessageResponseDto> {
    const config = await this.findOrCreateConfig();
    if (config.logoPath) {
      const [bucket, fileName] = config.logoPath.split('/');
      await this.storageService.deleteFile(fileName, bucket);
      config.logoPath = null;
      await this.systemConfigRepository.save(config);
      return { message: 'System logo removed successfully' };
    }
    return { message: 'No system logo to remove' };
  }

  /** Internal settings explicitly select private fields and retain future sections. */
  async getSettings(): Promise<SystemSettings> {
    const config = await this.findOrCreateConfig(true);
    const defaults = SystemConfigsService.DEFAULT_SETTINGS;
    const stored = config.settings ?? {};
    return Object.fromEntries(
      [...new Set([...Object.keys(defaults), ...Object.keys(stored)])].map(
        (section) => [section, { ...defaults[section], ...stored[section] }],
      ),
    );
  }

  /** Read the private mail section with defaults, retaining ciphertext. */
  async getMailServer(): Promise<MailServerConfig> {
    const { mailServer } = await this.getSettings();
    return mailServer as unknown as MailServerConfig;
  }

  /** Public signup requires administrator consent and an enabled mail server. */
  async isSignUpAllowed(): Promise<boolean> {
    const { auth, mailServer } = await this.getSettings();
    return auth?.allowSignUp === true && mailServer?.enabled === true;
  }

  /** Read saved policy on every request; explicit malformed policy grants no access. */
  async isAdminIpAllowed(clientIp: string | undefined): Promise<boolean> {
    const config = await this.findOrCreateConfig(true);
    const section: unknown = config.settings?.adminAccess;
    if (section === undefined) return true;
    if (!section || typeof section !== 'object' || Array.isArray(section))
      return false;
    const ips = (section as Record<string, unknown>).allowedIps;
    if (ips === undefined) return true;
    if (
      !Array.isArray(ips) ||
      ips.length > 100 ||
      !ips.every(
        (ip: unknown): ip is string =>
          typeof ip === 'string' && ip.length <= 64 && isIpOrCidr(ip),
      )
    ) return false;
    return ips.length === 0 || isIpInRanges(clientIp, ips);
  }

  /** Only documented sections and fields cross the admin response boundary. */
  async getSettingsView(): Promise<SystemSettingsDto> {
    const settings = await this.getSettings();
    const mailServer = settings.mailServer;
    const visibleMail = Object.fromEntries(
      Object.keys(SystemConfigsService.DEFAULT_SETTINGS.mailServer).map(
        (key) => [key, mailServer[key]],
      ),
    );
    return {
      adminAccess: {
        allowedIps: Array.isArray(settings.adminAccess.allowedIps)
          ? settings.adminAccess.allowedIps.filter(
              (ip: unknown): ip is string =>
                typeof ip === 'string' && isIpOrCidr(ip),
            )
          : [],
      },
      auth: { allowSignUp: settings.auth.allowSignUp === true },
      mailServer: {
        ...visibleMail,
        hasPassword:
          typeof mailServer.password === 'string' &&
          mailServer.password.length > 0,
      },
    };
  }

  /** Lock the row so validation and concurrent section merges use the same state. */
  async updateSettings(
    dto: SystemSettingsDto,
    requesterIp?: string,
  ): Promise<DefaultMessageResponseDto> {
    const sections: SystemSettings = Object.fromEntries(
      Object.entries(dto)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [
          key,
          Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([, field]) => field !== undefined && field !== null,
            ),
          ),
        ]),
    );
    if (Object.keys(sections).length) {
      const config = await this.findOrCreateConfig();
      await this.systemConfigRepository.manager.transaction(async (manager) => {
        const repo = manager.getRepository(SystemConfig);
        const current = await repo.findOneOrFail({
          where: { id: config.id },
          select: { id: true, settings: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (sections.adminAccess?.allowedIps !== undefined) {
          const ips = sections.adminAccess.allowedIps;
          if (
            !Array.isArray(ips) ||
            ips.length > 100 ||
            !ips.every(
              (ip: unknown): ip is string =>
                typeof ip === 'string' &&
                ip.length <= 64 &&
                isIpOrCidr(ip.trim()),
            )
          ) {
            throw new BadRequestException(
              'Provide up to 100 valid IP addresses or CIDR ranges',
            );
          }
          const allowedIps = [...new Set(ips.map((ip) => ip.trim()))];
          if (allowedIps.length && !isIpInRanges(requesterIp, allowedIps)) {
            throw new BadRequestException(
              'The allowed IP list must include your current IP address',
            );
          }
          sections.adminAccess.allowedIps = allowedIps;
        }
        if (sections.mailServer) {
          sections.mailServer = this.prepareMailServerPatch(
            sections.mailServer,
            current.settings?.mailServer,
          );
        }
        await repo
          .createQueryBuilder()
          .update()
          .set({
            settings: () =>
              `settings || (SELECT jsonb_object_agg(s.key, COALESCE(settings -> s.key, '{}'::jsonb) || s.value) FROM jsonb_each(CAST(:sections AS jsonb)) s)`,
          })
          .setParameter('sections', JSON.stringify(sections))
          .where('id = :id', { id: config.id })
          .execute();
      });
    }
    return { message: 'System settings updated successfully' };
  }

  private prepareMailServerPatch(
    dto: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch = Object.fromEntries(
      Object.entries(dto).filter(
        ([key]) => key !== 'password' && key !== 'hasPassword',
      ),
    );
    if (typeof dto.password === 'string' && dto.password)
      patch.password = encrypt(dto.password);
    const merged = {
      ...SystemConfigsService.DEFAULT_SETTINGS.mailServer,
      ...stored,
      ...patch,
    };
    if (
      merged.enabled &&
      (!(typeof merged.host === 'string' && merged.host.trim()) ||
        !merged.fromEmail)
    ) {
      throw new BadRequestException(
        'Set a host and a sender email before turning on the mail server',
      );
    }
    return patch;
  }

  /**
   * Find existing config or create default if not exists
   * @returns System config entity
   */
  private async findOrCreateConfig(
    includeSettings = false,
  ): Promise<SystemConfig> {
    const options: FindOneOptions<SystemConfig> = {
      where: {},
      // Concurrent first reads can leave duplicate rows; all consumers must agree.
      order: { createdAt: 'ASC', id: 'ASC' },
      ...(includeSettings ? { select: { id: true, settings: true } } : {}),
    };
    const config = await this.systemConfigRepository.findOne(options);
    if (config) return config;

    // Serialize only initialization, before settings locks or any external I/O.
    return this.systemConfigRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'argus:system-config-init',
      ]);
      const repo = manager.getRepository(SystemConfig);
      const existing = await repo.findOne(options);
      if (existing) return existing;
      const created = repo.create({
        name: SystemConfigsService.DEFAULT_SYSTEM_NAME,
        logoPath: undefined,
      });
      await repo.save(created);
      return created;
    });
  }

  /**
   * Check for version updates from GitHub
   * Runs daily at 3 AM via cron job
   * Only fetches from GitHub if:
   * - No cached version exists in Redis
   * - Last check was more than 12 hours ago
   */
  @Cron('0 3 * * *')
  private async checkUpdate(): Promise<void> {
    const now = new Date();
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    try {
      // Get last_check and cached version from Redis
      const lastCheckStr = await this.redisService.get('version:last_check');
      const cachedVersion = await this.redisService.get('version:latest');

      let shouldFetch = false;

      if (!lastCheckStr || !cachedVersion) {
        // No previous check or cache is null -> fetch
        shouldFetch = true;
      } else {
        const lastCheck = new Date(lastCheckStr);
        if (lastCheck < twelveHoursAgo) {
          // More than 12 hours since last check -> fetch
          shouldFetch = true;
        }
      }

      if (shouldFetch) {
        const latestVersion = await this.getLatestVersion();

        if (latestVersion) {
          // Set last_check = now
          await this.redisService.set('version:last_check', now.toISOString());
          // Set version with no expiry (TTL = 0 means never expire)
          await this.redisService.set(
            'version:latest',
            JSON.stringify(latestVersion),
          );

          this.logger.log(
            `Version checked and updated: ${latestVersion.tag_name}`,
          );
        }
      } else {
        this.logger.log('Version check skipped (within 12 hours)');
      }
    } catch (error) {
      this.logger.error('Error during version check:', error);
    }
  }

  private async getLatestVersion(): Promise<ReleaseVersion | null> {
    const apiUrlGithubReleaseLatestVersion = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    try {
      const response = await axios.get(apiUrlGithubReleaseLatestVersion);
      return response.data as ReleaseVersion;
    } catch (error) {
      this.logger.error('Error fetching latest version:', error);
      return null;
    }
  }
}
