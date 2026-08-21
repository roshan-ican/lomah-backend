import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ScheduleIdentitySource } from '@prisma/client';

export class LaneScheduleAttendeeDto {
  @IsEnum(ScheduleIdentitySource)
  identitySource!: ScheduleIdentitySource;

  @IsOptional()
  @IsString()
  shooterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;
}

export class CreateLaneScheduleDto {
  @IsInt()
  @Min(1)
  laneId!: number;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LaneScheduleAttendeeDto)
  attendees!: LaneScheduleAttendeeDto[];
}
