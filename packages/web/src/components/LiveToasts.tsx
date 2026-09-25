import { notifications } from '@mantine/notifications';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveServers } from '../api/live';
import { useServers, useServerScope } from '../api/server';

const ALERT_COLOR: Record<string, string> = {
  crash: 'orange',
  'crash-loop': 'red',
  unresponsive: 'yellow',
  'blocking-prompt': 'red',
  fatal: 'red',
  'start-timeout': 'red',
  'start-failed': 'red',
};

/**
 * Pops a toast for each new agent alert or panel notice that arrives while
 * the page is open, from every server the user sees: one about another
 * server than the page's names it.
 */
export function LiveToasts() {
  const { t } = useTranslation();
  const live = useLiveServers();
  const servers = useServers();
  const page = useServerScope()?.sid ?? null;
  // Per server: the last alert and notice shown. What is already there when this mounts (alerts replayed on
  // connect, notices kept while moving between pages) is history, not news.
  const seenAlert = useRef<Record<string, number>>({});
  const seenNotice = useRef<Record<string, string>>({});
  const seenHost = useRef<string | null>(null);
  const named = (sid: string, text: string) => {
    if (sid === page) return text;
    const name = servers.data?.find((s) => s.id === sid)?.name ?? sid;
    return `${name}: ${text}`;
  };

  useEffect(() => {
    for (const [sid, s] of Object.entries(live.servers)) {
      if (seenAlert.current[sid] === undefined) {
        seenAlert.current[sid] = s.alerts.at(-1)?.seq ?? 0;
        seenNotice.current[sid] = s.notices.at(-1)?.at ?? '';
        continue;
      }
      for (const a of s.alerts) {
        if (a.seq <= (seenAlert.current[sid] ?? 0)) continue;
        seenAlert.current[sid] = a.seq;
        notifications.show({ color: ALERT_COLOR[a.kind] ?? 'gray', title: named(sid, t(`alerts.${a.kind}`, { defaultValue: a.kind })), message: a.message, autoClose: 10_000 });
      }
      for (const n of s.notices) {
        if (n.at <= (seenNotice.current[sid] ?? '')) continue;
        seenNotice.current[sid] = n.at;
        notifications.show({ color: 'blue', message: named(sid, n.message), autoClose: 8_000 });
      }
    }
    // `named` reads the page and the list as they are when something arrives.
  }, [live.servers, t]);

  useEffect(() => {
    if (seenHost.current === null) {
      seenHost.current = live.hostNotices.at(-1)?.at ?? '';
      return;
    }
    for (const n of live.hostNotices) {
      if (n.at <= seenHost.current) continue;
      seenHost.current = n.at;
      notifications.show({ color: 'blue', message: n.message, autoClose: 8_000 });
    }
  }, [live.hostNotices]);

  return null;
}
