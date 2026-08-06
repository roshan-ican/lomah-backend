import { IsOptional, IsString } from 'class-validator';

export class ConnectDto {
  @IsOptional()
  @IsString()
  deviceId?: string;
}
