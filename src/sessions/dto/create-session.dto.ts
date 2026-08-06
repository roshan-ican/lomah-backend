import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";

class StagePlanDto {

    @IsString()
    targetId!: string;

    /** Omit for unlimited. The stage then ends on its clock, or when the range
     *  officer advances it. */
    @IsOptional()
    @IsInt()
    @Min(1)
    bulletLimit?: number;

    /**
     * 0 means "no clock" — the stage runs until it is advanced by hand or its
     * bullet limit is reached. `@Min(0)`, not `@Min(1)`: an open-ended stage is
     * the normal case for a relay run at the range officer's pace, and it has
     * to be expressible.
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    durationSeconds?: number;

}


export class CreateSessionDto {
    @IsInt()
    laneId!: number;

    @IsOptional()
    @IsString()
    shooterId?: string;

    @IsOptional()
    @IsString()
    shooterName?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => StagePlanDto)
    stages!: StagePlanDto[];

}
