import { IsIn } from 'class-validator';

/** Which page of five sensitivity trimmers to read — 'A' or 'B', matching the
 *  firmware's own naming (see sensor-values.md, 'G' command). */
export class ReadWipersDto {
  @IsIn(['A', 'B'])
  page!: 'A' | 'B';
}
