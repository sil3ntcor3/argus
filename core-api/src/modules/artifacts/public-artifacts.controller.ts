import { Public } from '@/common/decorators/app.decorator';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import { Controller, Get, Header, Param, Redirect } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArtifactReadService } from './artifact-read.service';

@ApiTags('Artifacts')
@Controller('public/artifacts')
export class PublicArtifactsController {
  constructor(private readonly files: ArtifactReadService) {}

  @ApiOperation({
    summary: 'Download a public workspace file',
    description: 'Redirects anonymously to a five-minute attachment URL for a ready public file. New redirects stop when the file becomes private or shared.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a signed attachment URL.',
    headers: { Location: { description: 'Five-minute attachment URL.', schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'Invalid file ID.' })
  @ApiNotFoundResponse({ description: 'Ready public file not found.' })
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Redirect()
  @Get(':id')
  async download(@Param() { id }: IdQueryParamDto): Promise<{ url: string }> {
    const { url } = await this.files.getPublicDownloadUrl(id);
    return { url };
  }
}
