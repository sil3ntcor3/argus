import { ApiProperty } from '@nestjs/swagger';

export class TargetOverviewDto {
  @ApiProperty({ description: 'Enabled assets on the target' })
  totalAssets: number;

  @ApiProperty({
    description: 'Enabled assets discovered in the last seven days',
  })
  newAssets: number;

  @ApiProperty({ description: 'Discovered services on the target' })
  totalServices: number;

  @ApiProperty({ description: 'Services discovered in the last seven days' })
  newServices: number;

  @ApiProperty({ description: 'Distinct ports among discovered services' })
  openPorts: number;
}
