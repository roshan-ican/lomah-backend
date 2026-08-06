import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { TargetsService } from './targets.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { UpdateTargetDto } from './dto/update-target.dto';
import { SetTargetOffsetDto } from './dto/set-target-offset.dto';
import { CalibrateFromShotDto } from './dto/calibrate-from-shot.dto';
import { ReadWipersDto } from './dto/read-wipers.dto';
import { WriteWiperDto } from './dto/write-wiper.dto';
import { DevDataDto } from './dto/dev-data.dto';
import { Roles } from '@/auth/decorators/roles.decorator';

@Controller('targets')
export class TargetsController {
  constructor(private readonly targetsService: TargetsService) {}

  // Structural changes to hardware — adding a target, moving its IP,
  // recalibrating it — are commissioning actions. SUPER_ADMIN only.
  @Roles('SUPER_ADMIN')
  @Post()
  create(@Body() createTargetDto: CreateTargetDto) {
    return this.targetsService.create(createTargetDto);
  }

  // No @Roles() here — any authenticated user (ADMIN included) can read the
  // target list. Only the JwtAuthGuard applies: logged in, any role, allowed.
  @Get()
  findAll() {
    return this.targetsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.targetsService.findOne(id);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateTargetDto: UpdateTargetDto) {
    return this.targetsService.update(id, updateTargetDto);
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.targetsService.remove(id);
  }

  /**
   * Commissioning check: PLAY, run the device's own self-test ('T'), STOP.
   *
   * POST, not GET — it puts a frame on the wire and briefly arms hardware. That
   * is a side effect, and a GET would be fair game for a retry or a prefetch.
   */
  @Roles('SUPER_ADMIN')
  @Post(':id/self-test')
  selfTest(@Param('id') id: string) {
    return this.targetsService.selfTest(id);
  }

  /** Ping ('H') — send a heartbeat and wait for the echo. */
  @Roles('SUPER_ADMIN')
  @Post(':id/heartbeat')
  heartbeat(@Param('id') id: string) {
    return this.targetsService.heartbeat(id);
  }

  /**
   * 'D' — which of the board's 8 sensors detected a given shot.
   *
   * ADMIN as well as SUPER_ADMIN: this is read-only diagnostics about a shot
   * that already happened and changes nothing on the board, and the range
   * admin working a lane is exactly who needs it when bullets come back as
   * no-detection.
   */
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Post(':id/dev-data')
  devData(@Param('id') id: string, @Body() dto: DevDataDto) {
    return this.targetsService.devData(id, dto.shot);
  }

  /**
   * Arm the target directly (PLAY) and leave it armed. POST, not GET — same
   * reasoning as self-test: this puts a frame on the wire and has a side
   * effect on live hardware.
   */
  @Roles('SUPER_ADMIN')
  @Post(':id/play')
  play(@Param('id') id: string) {
    return this.targetsService.play(id);
  }

  /** Disarm the target directly (STOP). */
  @Roles('SUPER_ADMIN')
  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.targetsService.stop(id);
  }

  /**
   * Read one page's five sensitivity trimmers. GET, unlike self-test: this
   * does not arm the board and changes nothing, so it is safe for a retry or
   * a prefetch to repeat.
   */
  @Roles('SUPER_ADMIN')
  @Get(':id/wipers')
  readWipers(@Param('id') id: string, @Query() dto: ReadWipersDto) {
    return this.targetsService.readWipers(id, dto.page);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id/wipers')
  writeWiper(@Param('id') id: string, @Body() dto: WriteWiperDto) {
    return this.targetsService.writeWiper(id, dto.page, dto.wiper, dto.value);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id/offset')
  setOffset(@Param('id') id: string, @Body() dto: SetTargetOffsetDto) {
    return this.targetsService.setOffset(id, dto.offsetXmm, dto.offsetYmm);
  }

  @Roles('SUPER_ADMIN')
  @Post(':id/calibrate')
  calibrateFromShot(@Param('id') id: string, @Body() dto: CalibrateFromShotDto) {
    return this.targetsService.calibrateFromShot(
      id,
      dto.shotId,
      dto.trueX,
      dto.trueY,
    );
  }
}
