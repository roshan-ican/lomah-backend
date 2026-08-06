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
