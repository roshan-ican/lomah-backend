import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  PayloadTooLargeException,
  Param,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ConnectedShootersService } from "@/auth/connected-shooters.service";
import { Public } from "@/auth/decorators/public.decorator";
import { SessionsService } from "@/sessions/sessions.service";
import {
  FaceRegistrationResult,
  FaceRegistrationStatus,
  FaceRegistrationView,
  FaceRecognitionResult,
  FaceRecognitionService,
} from "./face-recognition.service";

@Public()
@Controller("face-recognition")
export class FaceRecognitionController {
  constructor(
    private readonly faceRecognition: FaceRecognitionService,
    private readonly connectedShooters: ConnectedShootersService,
    private readonly sessions: SessionsService,
  ) {}

  @Post("check")
  check(): Promise<FaceRecognitionResult> {
    return this.faceRecognition.recognize();
  }

  @Post("check-frame")
  async checkFrame(@Req() request: Request): Promise<FaceRecognitionResult> {
    const jpeg = await this.readJpeg(request, "Camera frame");
    return this.faceRecognition.recognizeFrame(jpeg);
  }

  @Post("check-frame/:laneId")
  async checkSessionFrame(
    @Req() request: Request,
    @Param("laneId") laneIdText: string,
    @Headers("x-device-id") deviceId?: string,
  ): Promise<FaceRecognitionResult> {
    const shooterName = await this.sessionShooter(laneIdText, deviceId);
    const jpeg = await this.readJpeg(request, "Camera frame");
    return this.faceRecognition.recognizeFrame(jpeg, shooterName);
  }

  @Get("registration/:laneId")
  async registration(
    @Param("laneId") laneIdText: string,
    @Headers("x-device-id") deviceId?: string,
  ): Promise<FaceRegistrationStatus> {
    const shooterName = await this.sessionShooter(laneIdText, deviceId);
    return this.faceRecognition.registrationStatus(shooterName);
  }

  @Post("register/:laneId/:view")
  async register(
    @Req() request: Request,
    @Param("laneId") laneIdText: string,
    @Param("view") view: string,
    @Headers("x-device-id") deviceId?: string,
  ): Promise<FaceRegistrationResult> {
    if (view !== "front" && view !== "side") {
      throw new BadRequestException("Face view must be front or side");
    }
    const shooterName = await this.sessionShooter(laneIdText, deviceId);
    const jpeg = await this.readJpeg(request, "Reference photo");
    return this.faceRecognition.registerFace(
      shooterName,
      view as FaceRegistrationView,
      jpeg,
    );
  }

  private async sessionShooter(
    laneIdText: string,
    deviceId?: string,
  ): Promise<string> {
    const laneId = Number(laneIdText);
    if (!Number.isInteger(laneId) || laneId <= 0) {
      throw new BadRequestException("Lane id must be a positive integer");
    }
    const assignedDevice = this.connectedShooters
      .list()
      .find((device) => device.deviceId === deviceId);
    if (!deviceId || assignedDevice?.laneId !== laneId) {
      throw new ForbiddenException(
        "This shooter device is not assigned to the requested lane",
      );
    }

    const session = await this.sessions.findActiveByLane(laneId);
    const shooterName = session?.shooterName?.trim();
    if (!shooterName) {
      throw new BadRequestException(
        "The current lane session has no assigned shooter name",
      );
    }
    return shooterName;
  }

  private async readJpeg(request: Request, label: string): Promise<Buffer> {
    if (!request.is("image/jpeg")) {
      throw new UnsupportedMediaTypeException(
        `A JPEG ${label.toLowerCase()} is required`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > 1_500_000) {
        throw new PayloadTooLargeException(`${label} is too large`);
      }
      chunks.push(buffer);
    }

    if (totalBytes === 0) {
      throw new BadRequestException(`${label} is empty`);
    }

    return Buffer.concat(chunks);
  }

  @Get("preview")
  async preview(@Res() response: Response): Promise<void> {
    const jpeg = await this.faceRecognition.preview();
    response.setHeader("Cache-Control", "no-store, max-age=0");
    if (!jpeg) {
      response.status(204).end();
      return;
    }
    response.type("image/jpeg").send(Buffer.from(jpeg));
  }
}
