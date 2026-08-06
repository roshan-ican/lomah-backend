import { IsIn, IsInt, Max, Min } from 'class-validator';

export class WriteWiperDto {
  @IsIn(['A', 'B'])
  page!: 'A' | 'B';

  /** 1-based, matching the firmware's own indexing (see sensor-values.md,
   *  'W' command: "byte[3] = 1~5 for wiper selection"). */
  @IsInt()
  @Min(1)
  @Max(5)
  wiper!: number;

  @IsInt()
  @Min(0)
  @Max(255)
  value!: number;
}
