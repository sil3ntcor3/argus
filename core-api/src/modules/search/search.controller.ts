import { UserContext, WorkspaceId } from '@/common/decorators/app.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { RequestWithMetadata } from '@/common/interfaces/app.interface';
import { User } from '../auth/entities/user.entity';
import { DeleteResponseDto } from './dto/delete-response.dto';
import {
  GetManySearchHistoryDto,
  GetSearchHistoryResponseDto,
  SearchAssetsTargetsDto,
  SearchResponseDto,
} from './dto/search.dto';
import { SearchService } from './search.service';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Doc({
    summary: 'Search assets, targets and finding previews',
    description:
      'Search assets and targets, with an independently authorized top-five finding preview',
    response: {
      serialization: SearchResponseDto,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('asset.read', 'target.read')
  @Header('Cache-Control', 'private, no-store')
  @Get()
  searchAssetsTargets(
    @UserContext() user: User,
    @Query() query: SearchAssetsTargetsDto,
    @WorkspaceId() workspaceId: string,
    @Req() request: RequestWithMetadata,
  ) {
    const canReadFindings =
      request.permissions?.some(
        (key) =>
          key === '*' ||
          key === 'vulnerability.read' ||
          key === 'vulnerability.write',
      ) ?? false;
    return this.searchService.searchAssetsTargets(
      user,
      query,
      workspaceId,
      canReadFindings,
    );
  }

  @Doc({
    summary: 'Get search history',
    description: 'Get search history',
    response: {
      serialization: GetManyResponseDto(GetSearchHistoryResponseDto),
    },
  })
  @Get('histories')
  getSearchHistory(
    @UserContext() user: User,
    @Query() query: GetManySearchHistoryDto,
  ) {
    return this.searchService.getSearchHistory(user, query);
  }

  @Doc({
    summary: 'Delete search history by ID',
    description: 'Delete a specific search history entry by its ID',
    response: {
      serialization: DeleteResponseDto,
    },
  })
  @Delete('histories/:id')
  deleteSearchHistory(@UserContext() user: User, @Param('id') id: string) {
    return this.searchService.deleteSearchHistory(user, id);
  }

  @Doc({
    summary: 'Delete all search history',
    description: 'Delete all search history entries for the user',
    response: {
      serialization: DeleteResponseDto,
    },
  })
  @Delete('histories')
  deleteAllSearchHistories(@UserContext() user: User) {
    return this.searchService.deleteAllSearchHistories(user);
  }
}
