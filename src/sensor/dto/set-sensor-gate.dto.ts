import { IsBoolean } from 'class-validator';

export class SetSensorGateDto {
  @IsBoolean()
  held!: boolean;
}
