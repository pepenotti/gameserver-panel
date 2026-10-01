/**
 * Steam games described by a manifest (G4, D4), shared by the runtime and
 * panel halves: the manifest format, its loader and checks, the launch
 * settings both halves check the same way, and the manifests this package
 * ships, each loaded (and so checked) when it is first imported.
 */
import avorionJson from '../../manifests/avorion.json';
import { loadManifest } from './load';

export * from './hooks';
export * from './load';
export * from './meta';
export * from './schema';
export * from './settings';
export * from './templates';
export type * from './types';

/** Avorion (Steam app 565060), the first game added with a manifest only (M6; docs/verification/avorion-2.5.13.md). */
export const AVORION = loadManifest(avorionJson);

/** Every manifest this package ships, by adapter id. */
export const MANIFESTS = { avorion: AVORION } as const;
