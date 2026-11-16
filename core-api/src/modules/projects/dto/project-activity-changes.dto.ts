import { ApiPropertyOptional } from '@nestjs/swagger';

class ProjectTextChangeDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) before?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) after?: string | null;
}
class ProjectBooleanChangeDto {
  @ApiPropertyOptional({ type: Boolean }) before?: boolean;
  @ApiPropertyOptional({ type: Boolean }) after?: boolean;
}
export class ProjectActivityChangesDto {
  @ApiPropertyOptional({ type: ProjectTextChangeDto }) name?: ProjectTextChangeDto;
  @ApiPropertyOptional({ type: ProjectTextChangeDto }) description?: ProjectTextChangeDto;
  @ApiPropertyOptional({ type: ProjectTextChangeDto }) hexColor?: ProjectTextChangeDto;
  @ApiPropertyOptional({ type: ProjectBooleanChangeDto }) autoAddAssets?: ProjectBooleanChangeDto;
}

/** Decode a small public projection; audit records may contain arbitrary historical JSON. */
export function projectActivityChanges(input: unknown): ProjectActivityChangesDto | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const result: Record<string, Record<string, unknown>> = {};
  for (const key of ['name', 'description', 'hexColor', 'autoAddAssets'] as const) {
    const candidate: unknown = (input as Record<string, unknown>)[key];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const change: Record<string, unknown> = {};
    for (const side of ['before', 'after']) {
      const value: unknown = (candidate as Record<string, unknown>)[side];
      const valid = key === 'autoAddAssets' ? typeof value === 'boolean'
        : value === null || (typeof value === 'string' && value.length <= (key === 'name' ? 120 : key === 'hexColor' ? 7 : 2000)
          && (key !== 'hexColor' || /^#[0-9a-fA-F]{6}$/.test(value)));
      if (valid) change[side] = value;
    }
    if (Object.keys(change).length) result[key] = change;
  }
  return Object.keys(result).length ? result : undefined;
}
