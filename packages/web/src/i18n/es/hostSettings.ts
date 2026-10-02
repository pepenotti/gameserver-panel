import type { Translations } from '../en';

export default {
  title: 'Ajustes del panel',
  intro: 'Ajustes de todo el panel. Cada servidor puede darles a sus mensajes de Discord su propio webhook, idioma o avisos en su página de Programación.',
  address: {
    title: 'Cómo llegan los amigos a esta computadora',
    help: 'Las direcciones que usa el “Cómo entrar” de cada servidor: la que usan los jugadores desde internet, y la dirección de esta computadora en la red de casa.',
    public: 'Dirección pública',
    publicHelp: 'Un nombre como example.duckdns.org, o una dirección IP, sin https://, sin puerto y sin ruta. La IP de una conexión de casa puede cambiar; un nombre de DuckDNS la sigue.',
    home: 'Dirección en la red de casa',
    homeHelp: 'La dirección de esta computadora en tu red, como 192.168.1.50. La usan los jugadores en casa: muchos routers no pueden llevarlos por la dirección pública.',
    defaultIs: 'Vacía usa la predeterminada: {{address}} ({{source}}).',
    noDefault: 'Vacía: sin configurar.',
    sources: {
      duckdns: 'el nombre de DuckDNS que usa el panel',
      lan: 'la dirección del panel en la red',
    },
    detect: 'Detectar',
    detectHelp: 'Le pregunta a {{service}} la dirección IP pública de esta computadora, solo cuando lo apretás. No se envía nada más, y no se guarda nada hasta que apretás Guardar.',
    detected: 'Se encontró {{address}}. Apretá Guardar para quedártela.',
    problems: {
      empty: 'Escribí una dirección.',
      'too-long': 'Es demasiado larga para una dirección.',
      scheme: 'Sacá la parte https://.',
      path: 'Sacá todo lo que va después del nombre (una / y lo que sigue).',
      port: 'Sacá el puerto: el de cada servidor se agrega solo.',
      invalid: 'Eso no es un nombre ni una dirección IP.',
    },
  },
} satisfies Translations['hostSettings'];
