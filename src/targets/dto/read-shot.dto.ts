import { IsInt, Max, Min } from 'class-validator';

/** Which shot to ask the board to send again ('L'). The board keeps the last
 *  ~100 detected shots, numbered 1..100 — see the protocol spec, which uses the
 *  same range for the 'D' developer read. */
export class ReadShotDto {
  @IsInt()
  @Min(1)
  @Max(100)
  shot!: number;
}
