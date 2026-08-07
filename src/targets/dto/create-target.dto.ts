import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';


export class CreateTargetDto {

    @IsInt()
    laneId!: number;

    @IsString()
    label!: string;

    @IsInt()
    @Min(0)
    distanceM!: number;

    @IsInt()
    @Min(0)
    positionIndex!: number;

    // No `transport` field — the schema dropped the column when LoRa was
    // removed (see prisma/schema.prisma). Every target is reached by IP now,
    // full stop, so there's nothing left to discriminate on.
    @IsString()
    ipAddress!: string;

    // Command address override. Null is meaningful and must survive validation:
    // it is how the admin panel CLEARS an override and returns the target to
    // being commanded at `ipAddress`. `@IsOptional()` already permits null,
    // where `@IsString()` alone would reject it.
    @IsOptional()
    @IsString()
    commandHost?: string | null;

    @IsOptional()
    @IsInt()
    @Min(1)
    commandPort?: number | null;

    @IsOptional()
    @IsInt()
    offsetXmm?: number;

    @IsOptional()
    @IsInt()
    offsetYmm?: number;

    @IsOptional()
    @IsIn(['FIGURE', 'CIRCULAR'])
    profileType?: 'FIGURE' | 'CIRCULAR';

}
