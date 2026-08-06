import { IsInt } from 'class-validator';

/** New board-mm position for a shot, same coordinate space scoring reads —
 *  centre-relative, signed. Whatever drew the marker on the SVG is
 *  responsible for converting a drag back into this space before sending it. */
export class CalibrateShotDto {
  @IsInt()
  x!: number;

  @IsInt()
  y!: number;
}
