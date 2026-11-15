import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Severity } from '@/common/enums/enum';
import { ForbiddenException } from '@nestjs/common';
import type { User } from '../auth/entities/user.entity';
import type { SearchAssetsTargetsDto } from './dto/search.dto';
import { FindingSearchService } from './finding-search.service';
import type { Repository } from 'typeorm';
import { AssetsService } from '../assets/assets.service';
import { StatisticService } from '../statistic/statistic.service';
import { TargetsService } from '../targets/targets.service';
import { SearchHistory } from './entities/search-history.entity';
import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  let mockSearchHistoryRepository: Partial<Repository<SearchHistory>>;
  let mockAssetService: Partial<AssetsService>;
  let mockTargetService: Partial<TargetsService>;
  let mockStatisticService: Partial<StatisticService>;
  let findings: { search: jest.Mock };

  beforeEach(async () => {
    mockSearchHistoryRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getOneOrFail: jest.fn(),
      getMany: jest.fn(),
      getManyAndCount: jest.fn(),
      getRawMany: jest.fn(),
      getRawOne: jest.fn(),
    } as any;

    mockAssetService = {
      getManyAsssetServices: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0 }),
    };

    mockTargetService = {
      getTargetsInWorkspace: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0 }),
    };

    mockStatisticService = {
      getTotalAssets: jest.fn().mockResolvedValue(0),
      getTotalTargets: jest.fn().mockResolvedValue(0),
    };

    findings = { search: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: FindingSearchService, useValue: findings },
        {
          provide: getRepositoryToken(SearchHistory),
          useValue: mockSearchHistoryRepository,
        },
        {
          provide: AssetsService,
          useValue: mockAssetService,
        },
        {
          provide: TargetsService,
          useValue: mockTargetService,
        },
        {
          provide: StatisticService,
          useValue: mockStatisticService,
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  const user = { id: randomUUID() } as User;
  const workspace = randomUUID();
  const input = (values: Partial<SearchAssetsTargetsDto> = {}) =>
    ({
      value: 'Argus',
      page: 1,
      limit: 10,
      ...values,
    }) as SearchAssetsTargetsDto;

  it('keeps target/asset pagination independent of authorized finding previews', async () => {
    (mockStatisticService.getTotalAssets as jest.Mock).mockResolvedValue(12);
    (mockStatisticService.getTotalTargets as jest.Mock).mockResolvedValue(8);
    (mockAssetService.getManyAsssetServices as jest.Mock).mockResolvedValue({
      data: [{ id: 'asset' }],
      total: 12,
    });
    (mockTargetService.getTargetsInWorkspace as jest.Mock).mockResolvedValue({
      data: [{ id: 'target' }],
      total: 8,
    });
    findings.search.mockResolvedValue([{ id: 'finding' }]);
    const response = await service.searchAssetsTargets(
      user,
      input(),
      workspace,
      true,
    );
    expect(response).toMatchObject({
      total: 20,
      pageCount: 2,
      page: 1,
      limit: 10,
      hasNextPage: true,
      data: {
        assets: [{ id: 'asset' }],
        targets: [{ id: 'target' }],
        vulnerabilities: [{ id: 'finding' }],
      },
    });
    expect(mockAssetService.getManyAsssetServices).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 }),
      workspace,
    );
    expect(mockTargetService.getTargetsInWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
      workspace,
    );
  });

  it('does not read findings without explicit effective access and denies finding filters before storage', async () => {
    const response = await service.searchAssetsTargets(
      user,
      input(),
      workspace,
    );
    expect(response.data.vulnerabilities).toEqual([]);
    expect(findings.search).not.toHaveBeenCalled();
    jest.clearAllMocks();
    await expect(
      service.searchAssetsTargets(
        user,
        input({ severity: [Severity.CRITICAL] }),
        workspace,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockStatisticService.getTotalAssets).not.toHaveBeenCalled();
    expect(mockSearchHistoryRepository.findOne).not.toHaveBeenCalled();
  });

  it('skips empty severity-only history but retains text history for the authenticated user', async () => {
    await service.searchAssetsTargets(
      user,
      input({ value: ' ', severity: [Severity.CRITICAL], isSaveHistory: true }),
      workspace,
      true,
    );
    expect(mockSearchHistoryRepository.findOne).not.toHaveBeenCalled();
    mockSearchHistoryRepository.create = jest
      .fn()
      .mockImplementation((value: Partial<SearchHistory>) => value as SearchHistory);
    await service.searchAssetsTargets(
      user,
      input({ isSaveHistory: true }),
      workspace,
      true,
    );
    expect(mockSearchHistoryRepository.findOne).toHaveBeenCalledWith({
      where: { query: 'Argus', userId: user.id },
    });
    expect(mockSearchHistoryRepository.save).toHaveBeenCalledWith({
      query: 'Argus',
      userId: user.id,
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
