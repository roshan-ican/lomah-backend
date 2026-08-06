import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** x/y are raw wire-format sensor values (see frame.codec.ts), the same
 *  shape frontend's clickToSensorCoords already produces. */
export class SimulateShotDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  laneId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  x!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  y!: number;
}
