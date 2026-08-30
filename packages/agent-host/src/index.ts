export { parseReadyLine, type ReadyLineInfo } from './ready-line'
export {
  AgentSupervisor,
  type AgentReadyInfo,
  type AgentState,
  type AgentSupervisorOptions,
  type RestartPolicy,
} from './supervisor'
export {
  materializeDesktopProfile,
  BASE_BUNDLES,
  DESKTOP_PROFILE_NAME,
  STAMP_FILENAME,
} from './desktop-profile'
export type { BundledPlugin, MaterializeDesktopProfileOptions } from './desktop-profile'
