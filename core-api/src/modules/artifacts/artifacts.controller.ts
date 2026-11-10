import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArtifactUsageService } from './artifact-usage.service';
import { ArtifactUsageDto } from './dto/artifact-usage.dto';

@ApiTags('Artifacts')
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly usage: ArtifactUsageService) {}

  @Doc({
    summary: 'Get workspace storage usage',
    description: 'Returns quota, used and reserved bytes, and the per-file limit. Requires artifact.read.',
    response: { serialization: ArtifactUsageDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('artifact.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('usage')
  getUsage(@WorkspaceId() workspaceId: string): Promise<ArtifactUsageDto> {
    return this.usage.getUsage(workspaceId);
  }
}
