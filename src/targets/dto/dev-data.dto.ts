import { IsInt, Max, Min } from 'class-validator';

/** Which shot's developer diagnostic to request ('D'). The board keeps the
 *  last ~100 detected shots, numbered 1..100 — see the protocol spec. */
export class DevDataDto {
  @IsInt()
  @Min(1)
  @Max(100)
  shot!: number;
}
