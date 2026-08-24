import { Module } from "@nestjs/common";

import { AuthModule } from "@/auth/auth.module";
import { SessionsModule } from "@/sessions/sessions.module";
import { FaceRecognitionController } from "./face-recognition.controller";
import { FaceRecognitionService } from "./face-recognition.service";

@Module({
  imports: [AuthModule, SessionsModule],
  controllers: [FaceRecognitionController],
  providers: [FaceRecognitionService],
})
export class FaceRecognitionModule {}
