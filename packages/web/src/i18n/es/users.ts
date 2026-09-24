import type { Translations } from '../en';

export default {
  title: 'Usuarios',
  add: 'Agregar usuario',
  role: 'Rol',
  tempPassword: 'Contraseña temporal',
  tempPasswordHelp: 'Pasásela por privado; va a elegir la suya en el primer ingreso.',
  generate: 'Generar',
  created: 'Usuario creado. Mandale la dirección del panel, su usuario y la contraseña temporal.',
  lastLogin: 'Último ingreso',
  twoFactor: '2FA',
  disabled: 'Deshabilitado',
  disable: 'Deshabilitar',
  enable: 'Habilitar',
  resetPassword: 'Reiniciar contraseña',
  reset2fa: 'Reiniciar 2FA',
  deleteConfirm: '¿Eliminar a {{name}}? Se le cierra la sesión al instante.',
  reset2faConfirm: '¿Desactivar el 2FA de {{name}}? Si su rol lo necesita, lo va a configurar de nuevo al entrar.',
  you: 'vos',
} satisfies Translations['users'];
