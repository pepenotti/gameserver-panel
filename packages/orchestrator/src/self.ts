import type { DockerClient, DockerContainer } from './docker';

const COMPOSE_PROJECT = 'com.docker.compose.project';
/** Compose project names: lowercase letters, digits, dashes and underscores. */
const STACK = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** `gsp/orchestrator:s1` → `s1`; a digest or no tag → null. */
export function imageTagOf(image: string): string | null {
  if (image.includes('@')) return null;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon <= slash) return null;
  const tag = image.slice(colon + 1);
  return TAG.test(tag) ? tag : null;
}

/**
 * Who this orchestrator is, from its own container: the Compose project that
 * started it (the stack every name and label belongs to, so worktree stacks
 * stay apart) and its image tag (the runtime images are built with the same).
 */
export async function resolveSelf(docker: DockerClient, self: string): Promise<{ stack: string; imageTag: string }> {
  const c = await docker.find<DockerContainer>(`/containers/${encodeURIComponent(self)}/json`);
  if (!c) throw new Error(`This orchestrator's container (${self}) is not known to Docker: run it with Docker Compose`);
  const stack = c.Config.Labels?.[COMPOSE_PROJECT] ?? '';
  if (!STACK.test(stack)) throw new Error(`This orchestrator's container has no usable ${COMPOSE_PROJECT} label: run it with Docker Compose`);
  const imageTag = imageTagOf(c.Config.Image);
  if (!imageTag) throw new Error(`This orchestrator's image (${c.Config.Image}) has no tag to derive the runtime images from`);
  return { stack, imageTag };
}
