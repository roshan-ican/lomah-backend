import { IsInt, IsString, ValidateIf } from 'class-validator';

export class AssignConnectedDeviceDto {
  @IsString()
  deviceKey!: string;

  /**
   * The lane to put this device on, or `null` to release it.
   *
   * `@ValidateIf` rather than `@IsOptional`: releasing a device is an explicit
   * null, and @IsOptional would skip validation for that AND for a missing key,
   * quietly accepting `{}` as "release". A bare `@IsInt()` rejected null
   * outright, which is why releasing a device used to 400.
   */
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  laneId!: number | null;
}
