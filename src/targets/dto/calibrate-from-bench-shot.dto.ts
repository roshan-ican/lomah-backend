import { IsInt, Max, Min } from 'class-validator';

export class CalibrateFromBenchShotDto {
  @IsInt()
  @Min(1)
  @Max(100)
  shot!: number;

  @IsInt()
  trueX!: number;

  @IsInt()
  trueY!: number;
}
