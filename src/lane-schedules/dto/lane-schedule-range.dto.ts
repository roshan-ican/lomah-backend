import { IsDateString } from 'class-validator';

export class LaneScheduleRangeDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
