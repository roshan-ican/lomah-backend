import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from "class-validator";

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

    /**
     * Free-text range conditions ("wind 5kt left-to-right", "prone unsupported").
     *
     * The column has existed on Session since the schema was written, but until
     * now nothing wrote it: the admin console kept what the operator typed in
     * local component state only, so the panel reported "Session configured",
     * the notes stayed on screen, and they were gone the moment anyone loaded
     * the console anywhere else. `forbidNonWhitelisted` is on, so a client that
     * DID send them got a 400 rather than a silent drop — which is why this has
     * to be a declared field, not just an extra key in the request body.
     */
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    notes?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => StagePlanDto)
    stages!: StagePlanDto[];

    /**
     * Set by "Edit Config": this plan replaces whatever open session the lane
     * already has. Without it, create() refuses a second open session on an
     * occupied lane (see SessionsService.create) — the two together are what
     * stop an edit from silently forking the lane into two live sessions, only
     * one of which any command can ever address again.
     *
     * Only a session that has not started yet may be replaced this way. A
     * running relay is refused with its status in the message; ending or
     * discarding it is a deliberate act, not something an edit should do
     * behind the operator's back.
     */
    @IsOptional()
    @IsBoolean()
    replaceExisting?: boolean;

}
