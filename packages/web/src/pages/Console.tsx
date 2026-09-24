import { Alert, Box, Button, Card, Checkbox, Code, Group, Modal, ScrollArea, Stack, Text, TextInput, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { IconHelp } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../api/http';
import { useLive, type LogLine } from '../api/live';
import { CONSOLE_CAPABILITIES, type CommandDoc } from '../api/meta';
import { useSession } from '../api/session';
import { useMeta } from '../api/useMeta';
import { UnsupportedNote } from '../components/Supported';
import { useErrorText } from '../lib/format';

interface Reply {
  id: number;
  command: string;
  output: string;
  error?: boolean;
}

/** Quick buttons: the catalog's commands that take no arguments (they fill the box; Run sends them). */
const MAX_QUICK = 8;

/** Lines that are almost always noise for an admin: warnings and stack-trace frames, in any game's log. */
function isNoise(l: LogLine): boolean {
  return /^\s*\[?WARN(ING)?\b/i.test(l.line) || /^\s+at\s/.test(l.line) || /^\s*Stack trace:/i.test(l.line);
}

function lineColor(l: LogLine): string | undefined {
  if (l.stream === 'agent') return 'var(--mantine-color-blue-4)';
  if (/^\s*\[?(ERROR|SEVERE|FATAL)\b/i.test(l.line) || l.stream === 'err') return 'var(--mantine-color-red-4)';
  if (/^\s*\[?WARN(ING)?\b/i.test(l.line)) return 'var(--mantine-color-yellow-5)';
  return undefined;
}

/** A command's usage without its name's own arguments: `kick "<user>"` → true. */
const takesArguments = (c: CommandDoc) => c.syntax.trim() !== c.name;

export function Console() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const { can } = useSession();
  const { logs, status } = useLive();
  const { meta, has, l, gameName } = useMeta();
  const catalog = (meta?.consoleCatalog ?? []).filter((c) => !c.permission || can(c.permission));
  const quick = catalog.filter((c) => !takesArguments(c)).slice(0, MAX_QUICK);
  const [helpOpen, help] = useDisclosure();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [debounced] = useDebouncedValue(filter.toLowerCase(), 200);
  const [hideNoise, setHideNoise] = useState(true);
  const [follow, setFollow] = useState(true);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const replyId = useRef(0);

  const shown = useMemo(() => logs.filter((l) => (!hideNoise || !isNoise(l)) && (!debounced || l.line.toLowerCase().includes(debounced))), [logs, hideNoise, debounced]);

  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTo({ top: viewport.current.scrollHeight });
  }, [shown, follow]);

  const send = async (cmd: string) => {
    const c = cmd.trim();
    if (!c) return;
    setBusy(true);
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHistPos(-1);
    try {
      const r = await post<{ via: string; output: string | null }>('/api/server/command', { command: c });
      setReplies((rs) => [...rs, { id: ++replyId.current, command: c, output: r.output?.trim() || t('console.noOutput') }].slice(-30));
      setCommand('');
    } catch (e) {
      setReplies((rs) => [...rs, { id: ++replyId.current, command: c, output: errorText(e), error: true }].slice(-30));
    } finally {
      setBusy(false);
    }
  };

  /** Put a catalog command in the box: whole when it takes no arguments, else its name for the person to complete. */
  const pick = (c: CommandDoc) => {
    setCommand(takesArguments(c) ? `${c.name} ` : c.name);
    setHistPos(-1);
    input.current?.focus();
  };
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const hint = first ? catalog.find((c) => c.name.toLowerCase() === first) : undefined;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      const next = Math.min(histPos + 1, history.length - 1);
      setHistPos(next);
      setCommand(history[next]!);
    } else if (e.key === 'ArrowDown' && histPos >= 0) {
      e.preventDefault();
      const next = histPos - 1;
      setHistPos(next);
      setCommand(next >= 0 ? history[next]! : '');
    }
  };

  return (
    <Stack h="calc(100dvh - 56px - 2 * var(--mantine-spacing-md))" gap="sm">
      <Group justify="space-between">
        <Title order={2}>{t('console.title')}</Title>
        <Group gap="md">
          <TextInput size="xs" placeholder={t('console.filter')} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} w={180} />
          <Checkbox size="xs" label={t('console.hideNoise')} checked={hideNoise} onChange={(e) => setHideNoise(e.currentTarget.checked)} />
          <Checkbox size="xs" label={t('console.autoscroll')} checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
        </Group>
      </Group>

      <Card withBorder p={0} style={{ flex: 1, minHeight: 200 }}>
        <ScrollArea h="100%" viewportRef={viewport} type="auto" onScrollPositionChange={({ y }) => {
          const el = viewport.current;
          if (el) setFollow(el.scrollHeight - el.clientHeight - y < 40);
        }}>
          <Box p="xs" ff="monospace" fz={12} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.45 }}>
            {shown.length === 0 ? (
              <Text c="dimmed" size="sm">
                {t('console.empty')}
              </Text>
            ) : (
              shown.map((l) => (
                <div key={l.seq} style={{ color: lineColor(l) }}>
                  {l.line}
                </div>
              ))
            )}
          </Box>
        </ScrollArea>
      </Card>

      {can('console.raw') && !has(CONSOLE_CAPABILITIES) ? (
        <UnsupportedNote needs={[{ capability: CONSOLE_CAPABILITIES }]} />
      ) : can('console.raw') ? (
        <Stack gap={6}>
          {replies.length > 0 && (
            <Card withBorder p="xs" mah={180} style={{ overflow: 'auto' }}>
              {replies.map((r) => (
                <Box key={r.id} ff="monospace" fz={12} mb={4} style={{ whiteSpace: 'pre-wrap' }}>
                  <Text span c="dimmed" ff="monospace" fz={12}>
                    &gt; {r.command}
                  </Text>
                  {'\n'}
                  <Text span c={r.error ? 'red' : undefined} ff="monospace" fz={12}>
                    {r.output}
                  </Text>
                </Box>
              ))}
            </Card>
          )}
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void send(command);
            }}
          >
            <Group gap="xs" wrap="nowrap">
              <TextInput
                ref={input}
                style={{ flex: 1 }}
                ff="monospace"
                placeholder={t('console.command')}
                value={command}
                onChange={(e) => setCommand(e.currentTarget.value)}
                onKeyDown={onKey}
                disabled={status?.state !== 'running'}
                maxLength={1000}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('console.command')}
              />
              <Button type="submit" loading={busy} disabled={status?.state !== 'running' || !command.trim()}>
                {t('console.send')}
              </Button>
            </Group>
          </form>
          {hint && (
            <Text size="xs" c="dimmed">
              <Code>{hint.syntax}</Code> {l(hint.description)}
            </Text>
          )}
          <Group gap={6}>
            {quick.length > 0 && (
              <Text size="xs" c="dimmed">
                {t('console.quick')}:
              </Text>
            )}
            {quick.map((c) => (
              <Tooltip key={c.name} label={l(c.description)} openDelay={300}>
                <Button size="compact-xs" variant="default" ff="monospace" disabled={status?.state !== 'running' || busy} onClick={() => pick(c)}>
                  {c.name}
                </Button>
              </Tooltip>
            ))}
            {catalog.length > 0 && (
              <Button size="compact-xs" variant="subtle" leftSection={<IconHelp size={14} />} onClick={help.open}>
                {t('console.catalog')}
              </Button>
            )}
          </Group>
          <Modal opened={helpOpen} onClose={help.close} title={t('console.catalogTitle', { game: gameName })} size="lg">
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {t('console.catalogHelp')}
              </Text>
              {catalog.map((c) => (
                <UnstyledButton
                  key={c.name}
                  onClick={() => {
                    pick(c);
                    help.close();
                  }}
                  p={6}
                  style={{ borderRadius: 6, border: '1px solid var(--mantine-color-default-border)' }}
                >
                  <Code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.syntax}</Code>
                  <Text size="xs" c="dimmed" mt={2}>
                    {l(c.description)}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          </Modal>
        </Stack>
      ) : (
        <Alert variant="light">{t('console.readOnly')}</Alert>
      )}
    </Stack>
  );
}
