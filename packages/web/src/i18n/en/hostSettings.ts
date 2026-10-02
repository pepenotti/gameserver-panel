export default {
  title: 'Panel settings',
  intro: 'Settings for the whole panel. Each server can give its Discord messages their own webhook, language or switches on its Schedules page.',
  address: {
    title: 'How friends reach this computer',
    help: 'The addresses every server’s “How to join” uses: the one players use from the internet, and this computer’s address on your home network.',
    public: 'Public address',
    publicHelp: 'A name such as example.duckdns.org, or an IP address, without https://, a port or a path. A home connection’s IP address can change; a DuckDNS name follows it.',
    home: 'Home-network address',
    homeHelp: 'This computer’s address on your network, such as 192.168.1.50. Players at home use it: many routers can’t send them through the public address.',
    defaultIs: 'Empty uses the default: {{address}} ({{source}}).',
    noDefault: 'Empty: not set.',
    sources: {
      duckdns: 'the DuckDNS name the panel uses',
      lan: 'the panel’s own address on the network',
    },
    detect: 'Detect',
    detectHelp: 'Asks {{service}} for this computer’s public IP address, only when you press it. Nothing else is sent, and nothing is saved until you press Save.',
    detected: 'Found {{address}}. Press Save to keep it.',
    problems: {
      empty: 'Type an address.',
      'too-long': 'That is too long for an address.',
      scheme: 'Leave out the https:// part.',
      path: 'Leave out everything after the name (a / and what follows).',
      port: 'Leave out the port: each server’s port is added for you.',
      invalid: 'That is not a name or an IP address.',
    },
  },
} as const;
