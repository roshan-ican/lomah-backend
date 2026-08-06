import { IsOptional, IsString, MaxLength } from 'class-validator';

export class FeedbackDto {
  @IsString()
  @MaxLength(4000)
  feedback!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
