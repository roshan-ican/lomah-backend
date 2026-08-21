import {
  BadRequestException,
  Controller,
  Get,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Public } from '@/auth/decorators/public.decorator';
import {
  FaceRecognitionResult,
  FaceRecognitionService,
} from './face-recognition.service';

@Public()
@Controller('face-recognition')
export class FaceRecognitionController {
  constructor(
    private readonly faceRecognition: FaceRecognitionService,
  ) {}

  @Post('check')
  check(): Promise<FaceRecognitionResult> {
    return this.faceRecognition.recognize();
  }

  @Post('check-frame')
  async checkFrame(@Req() request: Request): Promise<FaceRecognitionResult> {
    if (!request.is('image/jpeg')) {
      throw new UnsupportedMediaTypeException('A JPEG camera frame is required');
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > 1_500_000) {
        throw new PayloadTooLargeException('Camera frame is too large');
      }
      chunks.push(buffer);
    }

    if (totalBytes === 0) {
      throw new BadRequestException('Camera frame is empty');
    }

    return this.faceRecognition.recognizeFrame(Buffer.concat(chunks));
  }

  @Get('preview')
  async preview(@Res() response: Response): Promise<void> {
    const jpeg = await this.faceRecognition.preview();
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    if (!jpeg) {
      response.status(204).end();
      return;
    }
    response.type('image/jpeg').send(Buffer.from(jpeg));
  }
}
