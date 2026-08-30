export {
  DSH_HOST,
  DSH_ORIGIN,
  DSH_SCHEME,
  STRIP_WHEN_PROXYING,
  headersForAgent,
  isAgentEventSocket,
  toAgentHttpUrl,
  toAgentWsUrl,
} from './origin'
export type { AgentEndpoint } from './origin'
export { WS_SHIM_SCRIPT, injectWsShim } from './ws-shim'
