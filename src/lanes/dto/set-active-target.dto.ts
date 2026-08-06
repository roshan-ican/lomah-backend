import { IsString } from "class-validator"

export class SetActiveTargetDto {
    @IsString()
    targetId!: string
}