import type { Translations } from '../en';

export default {
  title: 'Mi cuenta',
  languageHelp: 'El panel y los mensajes de Discord que generes usan este idioma.',
  security: 'Seguridad',
  twoFactor: 'Verificación en dos pasos (2FA)',
  twoFactorOn: 'Activada',
  twoFactorOff: 'Desactivada',
  enable2fa: 'Activar 2FA',
  disable2fa: 'Desactivar 2FA',
  disable2faConfirm: 'Ingresá tu contraseña para desactivar el 2FA.',
  sessions: 'Dispositivos con sesión abierta',
  thisDevice: 'Este dispositivo',
  lastSeen: 'Activo por última vez {{when}}',
  signOutDevice: 'Cerrar sesión',
  perServer: 'Tu rol depende del servidor.',
  myServers: 'Tus servidores',
} satisfies Translations['profile'];
