export interface LaneScheduleChangedEvent {
  type: 'lane-schedule:changed';
  laneId: number;
  startsAt: Date;
  endsAt: Date;
}
