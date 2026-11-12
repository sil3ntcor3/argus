import { RedisService } from '@/services/redis/redis.service';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { StorageService } from '@/modules/storage/storage.service';
import { SystemConfig } from './entities/system-config.entity';
import { SystemConfigsService } from './system-configs.service';

describe('SystemConfigsService', () => {
  let service: SystemConfigsService;
  let mockSystemConfigRepository: Partial<Repository<SystemConfig>>;
  let mockStorageService: Partial<StorageService>;

  beforeEach(async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: () => mockSystemConfigRepository,
    };
    mockSystemConfigRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      manager: {
        transaction: jest.fn((work: (tx: typeof manager) => Promise<unknown>) => work(manager)),
      } as unknown as Repository<SystemConfig>['manager'],
    };

    mockStorageService = {
      deleteFile: jest.fn(),
      signStoragePath: jest.fn(),
    };

    const mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigsService,
        {
          provide: getRepositoryToken(SystemConfig),
          useValue: mockSystemConfigRepository,
        },
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<SystemConfigsService>(SystemConfigsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConfig', () => {
    it('emits logoPath via signStoragePath when raw path present', async () => {
      const rawPath = 'system/logo-123.png';
      const clientUrl = 'http://localhost:9000/system/logo-123.png';
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 1,
        name: 'Test System',
        logoPath: rawPath,
      });
      (mockStorageService.signStoragePath as jest.Mock).mockResolvedValue(
        clientUrl,
      );

      const result = await service.getConfig();

      expect(
        mockStorageService.signStoragePath as jest.Mock,
      ).toHaveBeenCalledWith(rawPath);
      expect(result).toEqual({ name: 'Test System', logoPath: clientUrl });
    });

    it('creates new configurations with the Argus name', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue(null);
      (mockSystemConfigRepository.create as jest.Mock).mockImplementation(
        (config: Partial<SystemConfig>) => ({ id: 1, ...config }),
      );

      await expect(service.getConfig()).resolves.toEqual({
        name: 'Argus',
        logoPath: null,
      });
      expect(mockSystemConfigRepository.save).toHaveBeenCalledWith({
        id: 1,
        name: 'Argus',
        logoPath: undefined,
      });
    });

    it.each(['Acme Security', 'OASM'])(
      'preserves the saved name %s without rewriting the configuration',
      async (name) => {
        (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
          id: 1,
          name,
          logoPath: null,
        });

        const result = await service.getConfig();

        expect(
          mockStorageService.signStoragePath as jest.Mock,
        ).not.toHaveBeenCalled();
        expect(result).toEqual({ name, logoPath: null });
        expect(mockSystemConfigRepository.create).not.toHaveBeenCalled();
        expect(mockSystemConfigRepository.save).not.toHaveBeenCalled();
      },
    );
  });

  describe('updateConfig', () => {
    it.each([
      { input: '', expected: 'Argus' },
      { input: 'Acme Security', expected: 'Acme Security' },
    ])(
      'saves $expected for the requested name "$input"',
      async ({ input, expected }) => {
        (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
          id: 1,
          name: 'Saved brand',
          logoPath: null,
        });

        await service.updateConfig({ name: input });

        expect(mockSystemConfigRepository.save).toHaveBeenCalledWith({
          id: 1,
          name: expected,
          logoPath: null,
        });
      },
    );
  });

  describe('getRawLogoPath', () => {
    it('returns the raw stored path without calling the client-URL helper', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 1,
        name: 'Test System',
        logoPath: 'system/logo-123.png',
      });

      const result = await service.getRawLogoPath();

      expect(
        mockStorageService.signStoragePath as jest.Mock,
      ).not.toHaveBeenCalled();
      expect(result).toBe('system/logo-123.png');
    });

    it('returns null when no logo is configured', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 1,
        name: 'OASM',
        logoPath: null,
      });

      await expect(service.getRawLogoPath()).resolves.toBeNull();
    });
  });

  describe('removeLogo', () => {
    it('should remove logo and set logoPath to null', async () => {
      const mockConfig = {
        id: 1,
        name: 'Test System',
        logoPath: '/uploads/logo.png',
      };

      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue(
        mockConfig,
      );
      (mockSystemConfigRepository.save as jest.Mock).mockResolvedValue({
        ...mockConfig,
        logoPath: null,
      });

      const result = await service.removeLogo();

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalled();
      expect(mockSystemConfigRepository.save).toHaveBeenCalledWith({
        ...mockConfig,
        logoPath: null,
      });
      expect(result).toEqual({
        message: 'System logo removed successfully',
      });
    });

    it('should create default config if none exists and return no logo message', async () => {
      const mockConfig = {
        id: 1,
        name: 'Argus',
        logoPath: null,
      };

      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue(null);
      (mockSystemConfigRepository.create as jest.Mock).mockReturnValue(
        mockConfig,
      );
      (mockSystemConfigRepository.save as jest.Mock).mockResolvedValue(
        mockConfig,
      );

      const result = await service.removeLogo();

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalled();
      expect(mockSystemConfigRepository.create).toHaveBeenCalledWith({
        name: 'Argus',
        logoPath: undefined,
      });
      expect(result).toEqual({
        message: 'No system logo to remove',
      });
    });
  });

  describe('feature settings reads', () => {
    it('reads internal mail settings with defaults and encrypted credentials', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config',
        settings: { mailServer: { password: 'stored-ciphertext' } },
      });
      await expect(service.getMailServer()).resolves.toMatchObject({
        enabled: false,
        host: '',
        port: 587,
        password: 'stored-ciphertext',
      });
      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'ASC', id: 'ASC' },
        select: { id: true, settings: true },
      });
    });
    it('fills defaults while preserving stored sections internally', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config',
        settings: {
          mailServer: { host: 'smtp.example.com' },
          future: { value: 7 },
        },
      });
      const settings = await service.getSettings();
      expect(settings.auth).toEqual({ allowSignUp: false });
      expect(settings.mailServer).toMatchObject({
        host: 'smtp.example.com',
        port: 587,
        enabled: false,
      });
      expect(settings.future).toEqual({ value: 7 });
    });
    it('redacts credentials and unknown stored fields from the admin view', async () => {
      const settings = {
        adminAccess: { allowedIps: ['203.0.113.7'], internal: 'private' },
        mailServer: { password: 'encrypted-secret', internal: 'private' },
        future: { secret: 'hidden' },
      };
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config',
        settings,
      });
      const view = await service.getSettingsView();
      expect(view.adminAccess).toEqual({ allowedIps: ['203.0.113.7'] });
      expect(view.mailServer).toMatchObject({ hasPassword: true });
      expect(view.mailServer).not.toHaveProperty('password');
      expect(view.mailServer).not.toHaveProperty('internal');
      expect(view).not.toHaveProperty('future');
      expect(settings.mailServer.password).toBe('encrypted-secret');
    });
    it('returns defaults and no password marker for legacy rows', async () => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config',
      });
      await expect(service.getSettingsView()).resolves.toMatchObject({
        auth: { allowSignUp: false },
        adminAccess: { allowedIps: [] },
        mailServer: { hasPassword: false, provider: 'smtp' },
      });
    });
  });

  describe('admin IP policy', () => {
    it.each([null, false, []])('rejects malformed stored section %j', async (adminAccess) => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config', settings: { adminAccess },
      });
      await expect(service.isAdminIpAllowed('127.0.0.1')).resolves.toBe(false);
    });
    it.each([
      [undefined, undefined, true],
      [[], undefined, true],
      [['203.0.113.7'], '::ffff:203.0.113.7', true],
      [['203.0.113.0/24'], '203.0.113.8', true],
      [['2001:db8::/32'], '2001:db8::8', true],
      [['203.0.113.7'], undefined, false],
      [['203.0.113.7'], '198.51.100.8', false],
      [null, '127.0.0.1', false],
      [false, '127.0.0.1', false],
      [[7], '127.0.0.1', false],
      [['0.0.0.0/0/1'], '127.0.0.1', false],
      [Array(101).fill('127.0.0.1'), '127.0.0.1', false],
    ] as const)('checks stored %j against %s as %s', async (allowedIps, ip, expected) => {
      (mockSystemConfigRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'config', settings: { adminAccess: { allowedIps } },
      });
      await expect(service.isAdminIpAllowed(ip)).resolves.toBe(expected);
    });
  });
});

describe('signup settings gate', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])(
    'allowSignUp=%s and mail enabled=%s yields %s',
    async (allowSignUp, enabled, allowed) => {
      const service = Object.create(
        SystemConfigsService.prototype,
      ) as SystemConfigsService;
      jest
        .spyOn(service, 'getSettings')
        .mockResolvedValue({ auth: { allowSignUp }, mailServer: { enabled } });
      await expect(service.isSignUpAllowed()).resolves.toBe(allowed);
    },
  );
});
