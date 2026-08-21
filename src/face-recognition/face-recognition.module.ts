import { Module } from '@nestjs/common';

import { FaceRecognitionController } from './face-recognition.controller';
import { FaceRecognitionService } from './face-recognition.service';

@Module({
  controllers: [FaceRecognitionController],
  providers: [FaceRecognitionService],
})
export class FaceRecognitionModule {}
