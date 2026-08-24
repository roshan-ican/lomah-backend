import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAdminDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'username may only contain letters, numbers, dot, underscore or hyphen',
  })
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt truncates past 72 bytes.
  password!: string;
}
