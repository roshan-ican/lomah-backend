import { IsIn } from 'class-validator';

export class MoveLiftDto {
  @IsIn(['UP', 'DOWN'])
  position!: 'UP' | 'DOWN';
}
