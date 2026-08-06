import { IsEnum, IsOptional, IsString } from "class-validator";
import { LaneStatus } from "@prisma/client";

export class CreateLaneDto {
    @IsString()
    name!: string;

    @IsOptional()
    @IsString()
    siteName?: string;

    // LaneStatus comes from the Prisma-generated enum, not a hand-typed
    // string list — the schema is the one source of truth for the values.
    // A typo like 'CLOSED' (the real value is DISABLED) is now a TypeScript
    // compile error here, not just a runtime validation surprise.
    @IsOptional()
    @IsEnum(LaneStatus)
    status?: LaneStatus;
}
