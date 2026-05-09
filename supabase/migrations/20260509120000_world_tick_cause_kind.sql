-- v0.2 world engine — make `world_tick` a first-class cause kind.
-- world ticks fire research → judge → maybe deliver. they are scheduled in
-- donnaschedule and drained by the proactive worker the same way scan_gmail
-- and watch_fired are. dispatching by cause_kind keeps the worker switch flat.

alter table donnaschedule
  drop constraint donnaschedule_cause_kind_check;

alter table donnaschedule
  add constraint donnaschedule_cause_kind_check
    check (cause_kind in ('scheduled', 'scan_gmail', 'watch_fired', 'world_tick'));
