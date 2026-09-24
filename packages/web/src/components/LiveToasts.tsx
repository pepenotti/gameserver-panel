import { notifications } from '@mantine/notifications';
import { useEffect, useRef } from 'react';
import { useLive } from '../api/live';

const ALERT_COLOR: Record<string, string> = {
  crash: 'orange',
  'crash-loop': 'red',
  unresponsive: 'yellow',
  'admin-prompt': 'red',
  fatal: 'red',
  'start-timeout': 'red',
  'start-failed': 'red',
};

/** Pops a toast for each new agent alert or panel notice that arrives while the page is open. */
export function LiveToasts() {
  const { alerts, notices } = useLive();
  const seenAlert = useRef<number>(Number.MAX_SAFE_INTEGER);
  const seenNotice = useRef<string>('');

  useEffect(() => {
    // Alerts replayed on connect are history, not news.
    if (seenAlert.current === Number.MAX_SAFE_INTEGER) {
      seenAlert.current = alerts.at(-1)?.seq ?? 0;
      return;
    }
    for (const a of alerts) {
      if (a.seq <= seenAlert.current) continue;
      seenAlert.current = a.seq;
      notifications.show({ color: ALERT_COLOR[a.kind] ?? 'gray', title: a.kind, message: a.message, autoClose: 10_000 });
    }
  }, [alerts]);

  useEffect(() => {
    for (const n of notices) {
      if (n.at <= seenNotice.current) continue;
      seenNotice.current = n.at;
      notifications.show({ color: 'blue', message: n.message, autoClose: 8_000 });
    }
  }, [notices]);

  return null;
}
