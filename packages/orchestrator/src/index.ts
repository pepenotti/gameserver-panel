// What the fake orchestrator (tools/fake-orchestrator) and tests reuse: the
// API server, the spec checks and the derived names, so a development loop
// refuses exactly what production refuses.
export { IdLocks, Mutex, type Backend } from './backend';
export { loadConfig, type OrchestratorConfig } from './config';
export { AGENT_PORT, DEFAULT_STOP_TIMEOUT_SEC, imageName, LABEL, names, planContainer, type ContainerCreateBody, type ContainerPlan, type StackContext } from './derive';
export { DockerBackend, statsOf } from './docker-backend';
export { DockerClient, DOCKER_API_VERSION, type DockerTarget } from './docker';
export { badRequest, conflict, notFound, OrchError, refused, unavailable } from './errors';
export { canonicalJson, specHash } from './hash';
export { createOrchestratorServer, type OrchestratorServerOptions } from './http';
export { isNamedPipe, listenOnSocket } from './listen';
export { formatRanges, inRanges, parsePortRanges, type Policy, type PortRange } from './policy';
export { imageTagOf, resolveSelf } from './self';
export { MIN_MEM_MB, parseEmpty, parseSpec, parseStop } from './spec';
