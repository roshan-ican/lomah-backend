import { Body, Controller, Get, Post } from '@nestjs/common';
import { SensorGateService } from './sensor-gate.service';
import { SetSensorGateDto } from './dto/set-sensor-gate.dto';
import { Roles } from '@/auth/decorators/roles.decorator';

@Roles('SUPER_ADMIN', 'ADMIN')
@Controller('sensor-gate')
export class SensorGateController {
  constructor(private readonly gate: SensorGateService) {}

  @Get()
  status() {
    return this.gate.status();
  }

  @Post()
  setHeld(@Body() dto: SetSensorGateDto) {
    return this.gate.setHeld(dto.held);
  }
}
