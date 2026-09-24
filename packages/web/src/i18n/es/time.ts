import type { Translations } from '../en';

export default {
  seconds: '{{n}} s',
  minutes: '{{n}} min',
  hours: '{{n}} h',
  days: '{{n}} d',
  ago: 'hace {{what}}',
  in: 'en {{what}}',
} satisfies Translations['time'];
