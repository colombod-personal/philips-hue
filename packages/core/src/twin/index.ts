export { BridgeSimulator, type SimulatorOptions, type ReplayOptions, type ReplayState } from './simulator.js';
export { recordBridge, type RecordOptions } from './recorder.js';
export { sampleRecording } from './sample.js';
export {
  cloneRecording,
  isRecording,
  redactSecrets,
  RECORDING_VERSION,
  EXCLUDED_RESOURCE_TYPES,
  type Recording,
  type RecordedEvent,
  type RecordedRequest,
} from './recording.js';
