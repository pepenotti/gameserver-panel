// Pages and features a server's game doesn't have (PRD §3.1 principle 5).
export default {
  title: 'Not available for this game',
  body: '{{game}} does not support {{feature}}, so there is nothing to do here. The menu hides pages like this one.',
  thisGame: 'This game',
  or: ' or ',
  error: 'This game does not support {{feature}}.',
  note: 'Not shown because {{game}} does not support them: {{features}}.',
} as const;
