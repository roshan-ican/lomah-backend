import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateShooterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  rank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  badgeNumber?: string;
}
