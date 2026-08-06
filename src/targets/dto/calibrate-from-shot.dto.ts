import { IsInt, IsUUID } from 'class-validator';

export class CalibrateFromShotDto {
  @IsUUID()
  shotId!: string;

  @IsInt()
  trueX!: number;

  @IsInt()
  trueY!: number;
}
