-- Keep the existing schedule, endpoint and vault authentication intact.
-- Allow the combined feed's bounded network retries to finish.
do $bond_timeout$
declare
  scheduled_job record;
begin
  select jobid, command into strict scheduled_job
  from cron.job
  where jobname = 'capture-idrxy-snapshot-every-5-minutes';

  if scheduled_job.command ~* 'timeout_milliseconds[[:space:]]*(?::=|=>)[[:space:]]*150000' then
    return;
  end if;
  if scheduled_job.command ilike '%timeout_milliseconds%'
     or not (scheduled_job.command ~* 'net[.]http_post[[:space:]]*[(][[:space:]]*url[[:space:]]*:=') then
    raise exception 'Unexpected cron command; inspect before adjusting its timeout';
  end if;

  perform cron.alter_job(
    scheduled_job.jobid,
    command := regexp_replace(
      scheduled_job.command,
      'net[.]http_post[[:space:]]*[(]',
      'net.http_post(timeout_milliseconds := 150000,',
      'i'
    )
  );
end;
$bond_timeout$;
