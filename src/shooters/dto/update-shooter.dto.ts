import { PartialType } from '@nestjs/mapped-types';
import { CreateShooterDto } from './create-shooter.dto';

export class UpdateShooterDto extends PartialType(CreateShooterDto) {}
