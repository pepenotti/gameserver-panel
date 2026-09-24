import { describe, expect, it } from 'vitest';
import { parseOptionComment } from '../src/shared/option-comment';

describe('parseOptionComment', () => {
  it('reads the English range format', () => {
    expect(parseOptionComment('The time it takes for a player to enter and leave PVP mode Min: 0 Max: 1000 Default: 2')).toEqual({
      description: 'The time it takes for a player to enter and leave PVP mode',
      min: 0,
      max: 1000,
      default: '2',
    });
    expect(parseOptionComment('Min: 0 Max: 60 Default: 60')).toEqual({ min: 0, max: 60, default: '60' });
  });

  it('reads the Spanish range format', () => {
    expect(parseOptionComment('El tiempo que tarda un jugador en entrar y salir del modo PVP. Mínimo=0 Máximo=1000 Por defecto=2')).toEqual({
      description: 'El tiempo que tarda un jugador en entrar y salir del modo PVP.',
      min: 0,
      max: 1000,
      default: '2',
    });
  });

  it('reads enum-style defaults and decimals', () => {
    expect(parseOptionComment('How fast zombies move. Default = Random')).toEqual({ description: 'How fast zombies move.', default: 'Random' });
    expect(parseOptionComment('Default = 1 Hour, 30 Minutes')).toEqual({ default: '1 Hour, 30 Minutes' });
    expect(parseOptionComment('Mínimo=0.00 Máximo=1000.00 Por defecto=1.00')).toEqual({ min: 0, max: 1000, default: '1.00' });
    expect(parseOptionComment('Plain text')).toEqual({ description: 'Plain text' });
  });
});
