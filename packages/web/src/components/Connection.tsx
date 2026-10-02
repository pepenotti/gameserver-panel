// How players join a server (SRV-08): what they type from this PC, the home
// network and the internet, in its game's own format, each line with a copy
// button; a Share button (the phone's share sheet, or a copy of the whole
// message); the password for those who may manage the server, when they ask;
// the steps, the router forwards, and what isn't verified yet. The game's
// words come from its adapter (GET /api/servers/:sid/connection).
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, List, Loader, Modal, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck, IconCopy, IconDeviceDesktop, IconHome, IconShare, IconWorld, type Icon } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ConnectionInfo, JoinPlace } from '@gsp/shared';
import { serverApi } from '../api/http';
import { localize } from '../api/meta';
import { useServerId } from '../api/server';
import { clientLine, copyText, shareMessage, shareText, type Translate } from '../lib/connection';
import { useErrorText } from '../lib/format';

const PLACE_ICONS: Record<JoinPlace, Icon> = { pc: IconDeviceDesktop, home: IconHome, internet: IconWorld };
/** The places as the card lists them: this PC first (the owner checks it there), friends last. */
const CARD_ORDER: readonly JoinPlace[] = ['pc', 'home', 'internet'];

/** Copies with the Clipboard API or the fallback, and says how it went. */
function useCopy(): (text: string, done?: string) => Promise<void> {
  const { t } = useTranslation();
  return async (text, done) => {
    const ok = await copyText(text);
    notifications.show(ok ? { color: 'green', message: done ?? t('connection.copied') } : { color: 'red', message: t('connection.copyFailed'), autoClose: 8000 });
  };
}

/** Text players type, selectable, with its copy button. */
function CopyLine({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation();
  const copy = useCopy();
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Text ff="monospace" size="sm" fw={600} style={{ wordBreak: 'break-all', userSelect: 'all', minWidth: 0 }}>
        {text}
      </Text>
      <Tooltip label={t('connection.copy')}>
        <ActionIcon variant="light" size="md" aria-label={`${t('connection.copy')}: ${label}`} onClick={() => void copy(text)} style={{ flexShrink: 0 }}>
          <IconCopy size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** A labelled part of the card. */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** The connection info of server `sid`, its copy and share buttons included. */
export function ConnectionDetails({ sid }: { sid: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const errorText = useErrorText();
  const copy = useCopy();
  const [withPassword, setWithPassword] = useState(false);
  const sapi = serverApi(sid);
  const q = useQuery({
    queryKey: ['connection', sid, withPassword],
    queryFn: () => sapi<ConnectionInfo>('GET', `/connection?password=${withPassword ? '1' : '0'}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const info = q.data;
  if (!info) return <Loader size="sm" />;

  const tr: Translate = (key, o) => t(key, o);
  const message = () => shareMessage(info, tr, lang, { includePassword: withPassword });
  const share = async () => {
    const r = await shareText({ title: t('connection.share.title', { server: info.server.name, game: localize(info.game, lang) }), text: message() });
    if (r === 'copied') notifications.show({ color: 'green', message: t('connection.copiedAll') });
    if (r === 'failed') notifications.show({ color: 'red', message: t('connection.copyFailed'), autoClose: 8000 });
  };
  const proto = info.port.proto.toUpperCase();

  return (
    <Stack gap="md">
      <Group gap="xs">
        {info.verified ? (
          <Badge color="green" variant="light" tt="none" leftSection={<IconCircleCheck size={14} />}>
            {t('connection.verified')}
          </Badge>
        ) : (
          <Badge color="orange" variant="light" tt="none" leftSection={<IconAlertTriangle size={14} />}>
            {t('connection.unverified')}
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {localize(info.game, lang)}
        </Text>
      </Group>

      {CARD_ORDER.map((place) => {
        const p = info.places.find((x) => x.place === place);
        const PlaceIcon = PLACE_ICONS[place];
        return (
          <Stack key={place} gap={2}>
            <Group gap={6} wrap="nowrap">
              <PlaceIcon size={16} style={{ flexShrink: 0 }} />
              <Text size="sm" fw={600}>
                {t(`connection.places.${place}`)}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {t(`connection.placeHelp.${place}`)}
            </Text>
            {p?.text ? (
              <CopyLine text={p.text} label={t(`connection.places.${place}`)} />
            ) : (
              <Text size="sm" c="dimmed">
                {t('connection.notSet')}{' '}
                {info.publicAddress.canSet ? (
                  <Anchor component={Link} to="/settings" size="sm">
                    {t('connection.setInSettings')}
                  </Anchor>
                ) : (
                  t('connection.ownerSets')
                )}
              </Text>
            )}
          </Stack>
        );
      })}

      {info.format === 'separate' ? (
        <Part label={`${t('connection.port')} (${proto})`}>
          <CopyLine text={String(info.port.number)} label={t('connection.port')} />
          <Text size="xs" c="dimmed">
            {t('connection.portSeparate')}
          </Text>
        </Part>
      ) : (
        info.defaultPort !== null &&
        info.defaultPort === info.port.number && (
          <Text size="xs" c="dimmed">
            {t('connection.defaultPort', { port: info.defaultPort })}
          </Text>
        )
      )}

      <Part label={t('connection.where')}>
        <Text size="sm">{localize(info.where, lang)}</Text>
      </Part>

      <Part label={t('connection.client')}>
        <Text size="sm">{clientLine(info, lang)}</Text>
        {info.client.sameVersion && (
          <Text size="xs" c="dimmed">
            {info.client.version ? t('connection.sameVersion') : t('connection.versionUnknown')}
          </Text>
        )}
      </Part>

      {info.password.game && (
        <Part label={t('connection.password')}>
          <Text size="sm">{info.password.set === true ? t('connection.passwordSet') : info.password.set === false ? t('connection.passwordNone') : t('connection.passwordUnknown')}</Text>
          {info.password.set === true &&
            (info.password.canInclude ? (
              <>
                <Switch
                  mt={4}
                  label={t('connection.includePassword')}
                  description={t('connection.includePasswordHelp')}
                  checked={withPassword}
                  onChange={(e) => setWithPassword(e.currentTarget.checked)}
                />
                {withPassword && info.password.value !== null && <CopyLine text={info.password.value} label={t('connection.password')} />}
              </>
            ) : (
              <Text size="xs" c="dimmed">
                {t('connection.passwordAsk')}
              </Text>
            ))}
        </Part>
      )}

      {info.steps.length > 0 && (
        <Part label={t('connection.steps')}>
          <List size="sm" spacing={4}>
            {info.steps.map((s) => (
              <List.Item key={s.id}>
                {localize(s.text, lang)}{' '}
                {s.applies === 'unknown' && (
                  <Badge size="xs" variant="light" color="gray" tt="none">
                    {t('connection.mayApply')}
                  </Badge>
                )}
              </List.Item>
            ))}
          </List>
        </Part>
      )}

      {!info.verified && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle />} title={t('connection.unverified')}>
          <Text size="sm">{info.note ? localize(info.note, lang) : t('connection.unverifiedHelp')}</Text>
        </Alert>
      )}

      <Part label={t('connection.forwards')}>
        <Text size="xs" c="dimmed">
          {t('connection.forwardsHelp')}
        </Text>
        <Stack gap={2}>
          {info.forwards.map((f) => (
            <Group key={f.id} gap={6} wrap="nowrap" align="flex-start">
              <Text ff="monospace" size="sm" fw={600} style={{ flexShrink: 0 }}>
                {f.port} {f.proto.toUpperCase()}
              </Text>
              <Text size="sm" c="dimmed">
                {localize(f.label, lang)}
                {f.typed ? ` · ${t('connection.typed')}` : ''}
              </Text>
            </Group>
          ))}
        </Stack>
        <Text size="xs" c="dimmed">
          {t('connection.limitationsDoc')}
        </Text>
      </Part>

      <Group gap="xs">
        <Button leftSection={<IconShare size={16} />} onClick={() => void share()}>
          {t('connection.shareButton')}
        </Button>
        <Button variant="default" leftSection={<IconCopy size={16} />} onClick={() => void copy(message(), t('connection.copiedAll'))}>
          {t('connection.copyAll')}
        </Button>
      </Group>
    </Stack>
  );
}

/** The connection info on a server's page. */
export function ConnectionCard() {
  const { t } = useTranslation();
  const sid = useServerId();
  return (
    <Card withBorder>
      <Text fw={600}>{t('connection.title')}</Text>
      <Text size="xs" c="dimmed" mb="sm">
        {t('connection.help')}
      </Text>
      <ConnectionDetails sid={sid} />
    </Card>
  );
}

/** The connection info of a server of the list, in a dialog ("How to join"). */
export function ConnectionModal({ sid, name, opened, onClose }: { sid: string; name: string; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal opened={opened} onClose={onClose} title={`${t('connection.title')}: ${name}`} size="lg">
      {opened && <ConnectionDetails sid={sid} />}
    </Modal>
  );
}
