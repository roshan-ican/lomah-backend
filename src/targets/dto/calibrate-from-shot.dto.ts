import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

/**
 * "This already-fired shot actually landed HERE" — the reference the target's
 * mounting offset is derived from.
 *
 * The shot can be addressed two ways, and BOTH are needed:
 *
 *  - `shotId` — the Shot row's uuid. What a server-side caller or a test has.
 *  - `stageId` + `shotNumber` — what the admin board actually holds. Shots are
 *    rendered from the session snapshot and keyed by their 1-based
 *    `shotNumber`; the row uuid is never carried into the UI's shot model. This
 *    DTO used to require `shotId` as a `@IsUUID()`, so the console's
 *    `shotId: "3"` was rejected by the global ValidationPipe with a 400 before
 *    the service ever ran — which is why no calibration from the board, bulk or
 *    single-pick, ever applied.
 */
export class CalibrateFromShotDto {
  @IsOptional()
  @IsUUID()
  shotId?: string;

  @IsOptional()
  @IsUUID()
  stageId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  shotNumber?: number;

  @IsInt()
  trueX!: number;

  @IsInt()
  trueY!: number;
}
