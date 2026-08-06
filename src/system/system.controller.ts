import { Controller, Get } from '@nestjs/common';
import { SystemService } from './system.service';
import { Roles } from '@/auth/decorators/roles.decorator';

@Roles('SUPER_ADMIN', 'ADMIN')
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get('info')
  info() {
    return this.systemService.info();
  }

  @Get('lanes/sensors')
  laneSensors() {
    return this.systemService.laneSensors();
  }
}
