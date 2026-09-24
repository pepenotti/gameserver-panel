import type { Translations } from '../en';

// The config-folder browser and text editor (CFG-07, CFG-08).
export default {
  help: 'Todos los archivos de configuración que lee el juego, como texto. Los cambios se revisan mientras escribís, y ves exactamente qué cambia antes de aplicarlo.',
  declared: 'Archivos de configuración',
  pick: 'Elegí un archivo a la izquierda para abrirlo.',
  emptyFolder: 'Todavía no hay archivos en {{folder}}.',
  truncated: 'Solo se muestran los primeros archivos.',
  readonly: 'Solo lectura',
  history: 'Historial',
  historyOf: 'Historial: {{file}}',
  previewSave: 'Revisar y guardar',
  reload: 'Cargar la versión nueva',
  staleHelp: 'Tus cambios siguen acá. Cargar la versión nueva los descarta; copiá lo que necesites antes.',
  issues: '{{count}} problema(s) para corregir antes de guardar',
  line: 'Línea {{line}}',
  lineCol: 'Línea {{line}}, columna {{col}}',
  managedNote: 'Los maneja el panel y se restauran al guardar: {{keys}}',
  secretNote: 'Las contraseñas se ven como ••••••••. Dejalas así para conservarlas.',
  unsavedTitle: 'Cambios sin guardar',
  unsaved: 'Este archivo tiene cambios sin guardar. ¿Descartarlos?',
  reasons: {
    'outside-roots': 'No está en una carpeta que el editor pueda abrir.',
    'install-root': 'Es parte de la instalación del juego, que una actualización sobrescribiría.',
    symlink: 'Es un enlace a otro lugar: los enlaces nunca se siguen.',
    'not-a-file': 'No es un archivo común.',
    'too-large': 'Pesa más de 1 MiB.',
    binary: 'No es un archivo de texto.',
    script: 'Es código que ejecuta el juego: se muestra solo para leer, nunca se edita acá.',
    'not-utf8': 'No es texto UTF-8.',
    missing: 'Se crea la primera vez que prende el servidor.',
  },
} satisfies Translations['files'];
