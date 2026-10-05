import type { I18n } from '@gsp/adapter-api';
import type { CpuArch, HostTraits } from '@gsp/shared';
import type { AddressView } from './traits';

/**
 * A limitation of this host, as the host page lists it (HST-07, UX-04): a
 * stable id, a title and one line in English and Spanish, and its entry in
 * docs/limitations.md (`limitations.md#<anchor>`, a heading's anchor there;
 * a test checks each one exists). `status`: seen on a real host
 * (`measured`), or following from how the platform works (`expected`).
 */
export interface HostLimitation {
  id: string;
  level: 'warning' | 'info';
  status: 'measured' | 'expected';
  title: I18n;
  text: I18n;
  doc: string;
}

/** What decides which limitations apply: the host's traits (null: the orchestrator doesn't say) and the addresses as the panel shows them. */
export interface HostFacts {
  arch: CpuArch | null;
  traits: HostTraits | null;
  addresses: AddressView;
}

const DOC = {
  hiddenAddresses: 'limitations.md#players-addresses-are-hidden-behind-docker-desktop',
  hiddenVisitors: 'limitations.md#the-panels-visitors-are-hidden-the-same-way',
  desktopMemory: 'limitations.md#game-servers-share-dockers-memory-not-your-pcs',
  desktopDisk: 'limitations.md#docker-desktops-disk-only-grows',
  desktopPorts: 'limitations.md#with-docker-desktop-game-ports-listen-on-the-pc-itself',
  windowsPorts: 'limitations.md#some-ports-cant-be-used-on-windows',
  arm: 'limitations.md#arm-computers-cant-run-every-game',
  macos: 'limitations.md#macos-is-documented-but-untested',
} as const;

/** Every limitation the host page may list, by id, each with when it applies. */
export const HOST_LIMITATIONS: readonly (HostLimitation & { applies: (f: HostFacts) => boolean })[] = [
  {
    id: 'hidden-addresses',
    level: 'warning',
    status: 'measured',
    applies: (f) => f.addresses === 'hidden',
    title: { en: 'Players’ addresses are hidden', es: 'Las direcciones de los jugadores quedan ocultas' },
    text: {
      en: 'Docker Desktop relays every connection, so every player arrives from the same address: a ban by address shuts everyone out, and a game’s limits per address treat all players as one. Ban by account instead.',
      es: 'Docker Desktop retransmite cada conexión, así que todos los jugadores llegan desde la misma dirección: un baneo por dirección deja afuera a todos, y los límites por dirección de un juego tratan a todos como uno. Baneá por cuenta.',
    },
    doc: DOC.hiddenAddresses,
  },
  {
    id: 'hidden-visitors',
    level: 'info',
    status: 'measured',
    applies: (f) => f.addresses === 'hidden',
    title: { en: 'The panel’s visitors are hidden the same way', es: 'Los visitantes del panel quedan ocultos igual' },
    text: {
      en: 'The activity log and the signed-in sessions show the relay’s address for everyone. Sign-in protection doesn’t rely on addresses.',
      es: 'El registro de actividad y las sesiones iniciadas muestran la dirección del relevo para todos. La protección del inicio de sesión no depende de las direcciones.',
    },
    doc: DOC.hiddenVisitors,
  },
  {
    id: 'addresses-expected',
    level: 'info',
    status: 'expected',
    applies: (f) => f.addresses === 'expected',
    title: { en: 'Players’ addresses: expected, not yet measured', es: 'Direcciones de los jugadores: esperadas, todavía sin medir' },
    text: {
      en: 'Docker Engine is expected to pass players’ and visitors’ own addresses to the games and the panel; nobody has measured it yet. Once you have checked, set CLIENT_IP_TRUSTWORTHY=true in .env.',
      es: 'Se espera que Docker Engine pase las direcciones propias de jugadores y visitantes a los juegos y al panel; nadie lo midió todavía. Cuando lo hayas comprobado, poné CLIENT_IP_TRUSTWORTHY=true en .env.',
    },
    doc: DOC.hiddenAddresses,
  },
  {
    id: 'wsl-mirrored',
    level: 'info',
    status: 'expected',
    applies: (f) => f.traits?.docker === 'engine' && f.traits.platform === 'windows' && f.addresses !== 'hidden',
    title: { en: 'Docker Engine inside WSL needs mirrored networking', es: 'Docker Engine dentro de WSL necesita la red en modo espejo' },
    text: {
      en: 'Inside WSL, players’ addresses are expected to arrive only with WSL’s mirrored networking (networkingMode=mirrored in .wslconfig).',
      es: 'Dentro de WSL, se espera que las direcciones de los jugadores lleguen solo con la red en modo espejo de WSL (networkingMode=mirrored en .wslconfig).',
    },
    doc: DOC.hiddenAddresses,
  },
  {
    id: 'addresses-unknown',
    level: 'info',
    status: 'expected',
    applies: (f) => f.addresses === 'unknown',
    title: { en: 'The panel can’t tell whether players’ addresses arrive', es: 'El panel no puede saber si llegan las direcciones de los jugadores' },
    text: {
      en: 'The orchestrator didn’t say how Docker runs here. Behind Docker Desktop every player arrives from one address, so bans by address shut everyone out.',
      es: 'El orquestador no dijo cómo funciona Docker acá. Detrás de Docker Desktop todos los jugadores llegan desde una dirección, así que los baneos por dirección dejan afuera a todos.',
    },
    doc: DOC.hiddenAddresses,
  },
  {
    id: 'desktop-memory',
    level: 'warning',
    status: 'measured',
    applies: (f) => f.traits?.docker === 'desktop',
    title: { en: 'Servers share Docker’s memory, not the computer’s', es: 'Los servidores comparten la memoria de Docker, no la de la computadora' },
    text: {
      en: 'Docker Desktop’s virtual machine has a memory limit of its own, smaller than the computer’s: servers fail or are refused long before the computer’s memory runs out. Raise it in WSL’s or Docker Desktop’s settings.',
      es: 'La máquina virtual de Docker Desktop tiene su propio límite de memoria, menor que el de la computadora: los servidores fallan o se rechazan mucho antes de que se acabe la memoria de la computadora. Subilo en la configuración de WSL o de Docker Desktop.',
    },
    doc: DOC.desktopMemory,
  },
  {
    id: 'desktop-disk',
    level: 'info',
    status: 'expected',
    applies: (f) => f.traits?.docker === 'desktop',
    title: { en: 'Docker Desktop’s disk only grows', es: 'El disco de Docker Desktop solo crece' },
    text: {
      en: 'Removing servers, game files or backups inside Docker doesn’t give the space back to the computer until Docker’s virtual disk is compacted.',
      es: 'Quitar servidores, archivos de juegos o copias dentro de Docker no le devuelve el espacio a la computadora hasta que se compacta el disco virtual de Docker.',
    },
    doc: DOC.desktopDisk,
  },
  {
    id: 'desktop-ports',
    level: 'info',
    status: 'measured',
    applies: (f) => f.traits?.docker === 'desktop',
    title: { en: 'Game ports listen on the computer itself', es: 'Los puertos de los juegos escuchan en la propia computadora' },
    text: {
      en: 'Docker Desktop publishes each server’s ports from a program of its own on the computer; its firewall may have to let that program accept connections from other computers.',
      es: 'Docker Desktop publica los puertos de cada servidor desde un programa propio en la computadora; puede que su firewall tenga que dejar que ese programa acepte conexiones de otras computadoras.',
    },
    doc: DOC.desktopPorts,
  },
  {
    id: 'windows-ports',
    level: 'info',
    status: 'measured',
    applies: (f) => f.traits?.platform === 'windows',
    title: { en: 'Some ports can’t be used on Windows', es: 'Algunos puertos no se pueden usar en Windows' },
    text: {
      en: 'Windows reserves port ranges for Hyper-V and WSL, different on each computer: a server can’t start on a port inside one. Pick ports outside them.',
      es: 'Windows reserva rangos de puertos para Hyper-V y WSL, distintos en cada computadora: un servidor no puede arrancar en un puerto dentro de uno. Elegí puertos fuera de esos rangos.',
    },
    doc: DOC.windowsPorts,
  },
  {
    id: 'arm-games',
    level: 'info',
    status: 'measured',
    applies: (f) => f.arch === 'arm64',
    title: { en: 'Some games can’t run on this computer', es: 'Algunos juegos no pueden funcionar en esta computadora' },
    text: {
      en: 'This computer has an ARM processor. Games whose servers are built for x86-64 only can’t be created here; the create form says which.',
      es: 'Esta computadora tiene un procesador ARM. Los juegos cuyos servidores existen solo para x86-64 no se pueden crear acá; el formulario de creación dice cuáles.',
    },
    doc: DOC.arm,
  },
  {
    id: 'macos-untested',
    level: 'info',
    status: 'expected',
    applies: (f) => f.traits?.platform === 'macos',
    title: { en: 'macOS is untested', es: 'macOS no está probado' },
    text: {
      en: 'The setup guide for macOS exists, but nobody has run this project on a Mac yet.',
      es: 'La guía de instalación para macOS existe, pero nadie usó este proyecto en una Mac todavía.',
    },
    doc: DOC.macos,
  },
];

/** The limitations that apply to this host, warnings first, each as the API gives it. */
export function hostLimitations(f: HostFacts): HostLimitation[] {
  const out = HOST_LIMITATIONS.filter((l) => l.applies(f)).map(({ applies: _applies, ...l }) => l);
  return [...out.filter((l) => l.level === 'warning'), ...out.filter((l) => l.level !== 'warning')];
}
