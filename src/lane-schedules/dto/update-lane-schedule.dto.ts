import { PartialType } from '@nestjs/mapped-types';
import { CreateLaneScheduleDto } from './create-lane-schedule.dto';

export class UpdateLaneScheduleDto extends PartialType(CreateLaneScheduleDto) {}
