import { IsInt } from 'class-validator';

export class SetTargetOffsetDto {
  @IsInt()
  offsetXmm!: number;

  @IsInt()
  offsetYmm!: number;
}
